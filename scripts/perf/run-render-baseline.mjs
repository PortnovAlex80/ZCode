// P-01 独立渲染基线 runner（无 Electron、无 ~/.zcode、无 live profile）。
//
// 把渲染调研的一次性 Node/tsx 探针固化为可重复的提交内基线：
//   - 全量 render unit 重建（buildConversationTurnRenderUnits）；
//   - 问题导航目录（buildConversationTurnNavigatorItems）的未缓存 vs 稳态缓存构建；
//   - 流式尾部 row.delta 逻辑帧的应用成本（applyConversationDeltas，P-03 的阈值基线）。
//
// 用法：
//   node scripts/perf/run-render-baseline.mjs --turns 200,1000 --ticks 200 [--warmup 25]
//                                             [--seed 20261012] [--no-write]
// 结果以 p50/p95 记录到 docs/spec-harness/RENDERING-BASELINE.md 的
// <!-- render-baseline:results:start/end --> 标记区（--no-write 只打印）。
//
// 仓库 TS 通过 tsx 加载：@/ 别名定义在 packages/ui/tsconfig.json，
// 经 TSX_TSCONFIG_PATH 显式指定，脚本因此可从任意 cwd 运行（与
// scripts/builtin-provider-config.mjs 的 tsImport 模式同源）。

import { execFileSync } from "node:child_process";
import os from "node:os";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..");
const docPath = path.resolve(repoRoot, "docs", "spec-harness", "RENDERING-BASELINE.md");
const DOC_SECTION_START = "<!-- render-baseline:results:start -->";
const DOC_SECTION_END = "<!-- render-baseline:results:end -->";

const NAVIGATOR_PREVIEW_OPTIONS = {
  assistantEmptyPreview: "（无文本输出）",
  assistantRunningPreview: "正在工作…",
  userFallbackPreview: "（用户消息）",
};

function parseCliArgs(argv) {
  const args = {
    turns: [200, 1000],
    ticks: 200,
    warmup: 25,
    seed: undefined,
    write: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--turns") {
      args.turns = String(argv[++i] ?? "")
        .split(",")
        .map((value) => Number.parseInt(value.trim(), 10))
        .filter((value) => Number.isInteger(value) && value > 0);
      if (args.turns.length === 0)
        throw new Error("--turns must be a comma list of positive integers");
    } else if (arg === "--ticks") {
      args.ticks = Number.parseInt(argv[++i] ?? "", 10);
      if (!Number.isInteger(args.ticks) || args.ticks < 10)
        throw new Error("--ticks must be an integer >= 10");
    } else if (arg === "--warmup") {
      args.warmup = Number.parseInt(argv[++i] ?? "", 10);
      if (!Number.isInteger(args.warmup) || args.warmup < 0)
        throw new Error("--warmup must be an integer >= 0");
    } else if (arg === "--seed") {
      args.seed = Number.parseInt(argv[++i] ?? "", 10);
      if (!Number.isInteger(args.seed)) throw new Error("--seed must be an integer");
    } else if (arg === "--no-write") {
      args.write = false;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

/** 最近邻秩百分位（与样本规模无关、无插值，方便人工复算）。 */
function percentile(sortedSamples, fraction) {
  if (sortedSamples.length === 0) throw new Error("percentile of empty samples");
  const rank = Math.min(
    sortedSamples.length,
    Math.max(1, Math.ceil(fraction * sortedSamples.length)),
  );
  return sortedSamples[rank - 1];
}

function measure({ ticks, warmup, run }) {
  for (let i = 0; i < warmup; i += 1) run();
  const samples = Array.from({ length: ticks }, () => 0);
  for (let i = 0; i < ticks; i += 1) {
    const startedAt = performance.now();
    run();
    samples[i] = performance.now() - startedAt;
  }
  samples.sort((left, right) => left - right);
  return {
    p50: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    min: samples[0],
    max: samples[samples.length - 1],
  };
}

function formatMs(value) {
  return `${value.toFixed(2)} ms`;
}

async function loadRepositoryModules() {
  process.env.TSX_TSCONFIG_PATH = path.join(repoRoot, "packages", "ui", "tsconfig.json");
  const { tsImport } = await import("tsx/esm/api");
  // Windows 盘符绝对路径须转 file URL 再交给 tsImport（同 scripts/builtin-provider-config.mjs）。
  const asUrl = (relative) => pathToFileURL(path.join(repoRoot, relative)).href;
  const fixtures = await import(pathToFileURL(path.join(scriptDir, "v4-replay-fixtures.mjs")).href);
  const renderUnitsModule = await tsImport(
    asUrl("packages/ui/src/v4/conversationTurnRenderUnits.ts"),
    import.meta.url,
  );
  const navigatorModule = await tsImport(
    asUrl("packages/ui/src/v4/conversationTurnNavigatorHelpers.ts"),
    import.meta.url,
  );
  const applyModule = await tsImport(
    asUrl("packages/shared/src/zcode-protocol-v4/apply.ts"),
    import.meta.url,
  );
  return {
    fixtures,
    buildConversationTurnRenderUnits: renderUnitsModule.buildConversationTurnRenderUnits,
    buildConversationTurnNavigatorItems: navigatorModule.buildConversationTurnNavigatorItems,
    createCachedConversationTurnNavigatorItemsBuilder:
      navigatorModule.createCachedConversationTurnNavigatorItemsBuilder,
    applyConversationDeltas: applyModule.applyConversationDeltas,
  };
}

function collectEnvironment() {
  let revision = "unknown";
  let dirtyFiles = 0;
  try {
    revision = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    dirtyFiles = execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" })
      .split("\n")
      .filter((line) => line.trim().length > 0).length;
  } catch {
    // git 不可用时基线仍可运行，revision 记 unknown。
  }
  const cpus = os.cpus();
  return {
    nodeVersion: process.version,
    platform: `${os.platform()} ${os.arch()}`,
    cpu: cpus[0]?.model ?? "unknown",
    revision,
    dirtyFiles,
    date: new Date().toISOString().slice(0, 10),
  };
}

/** 组装一段流式尾部回放的逻辑帧：先 append 流式行建水位，再以 24 条 row.delta 为一帧。 */
function buildStreamingFrame({ fixtures, rows }) {
  const lastRowId = rows.at(-1)?.rowId ?? 0;
  const tail = fixtures.buildV4ReplayStreamTail({ chunks: 48, baseRowId: lastRowId });
  // 只取 appended 序列建流式水位；complete upsert 属于帧后的终态，不进帧测量。
  const headDeltas = tail.deltas.filter((delta) => delta.op === "row.appended");
  const firstAppend = tail.deltas.find((delta) => delta.op === "row.delta");
  const chunk = firstAppend?.append ?? "";
  const frameDeltas = Array.from({ length: 24 }, () => ({
    op: "row.delta",
    rowId: tail.streamingRowId,
    path: "text",
    append: chunk,
  }));
  return { headDeltas, frameDeltas };
}

function renderDocSection({ environment, args, results }) {
  const dirtyNote =
    environment.dirtyFiles === 0
      ? "工作区无未提交文件"
      : `工作区另有 ${environment.dirtyFiles} 个未提交文件`;
  const lines = [];
  lines.push(
    `更新于 ${environment.date}；node ${environment.nodeVersion}；${environment.platform}；`,
  );
  lines.push(
    `CPU ${environment.cpu}；revision \`${environment.revision}\`（${dirtyNote}）；` +
      `seed ${args.seed}；warmup ${args.warmup}；ticks ${args.ticks}。`,
  );
  lines.push("");
  lines.push("| 指标 | 轮数 | 行数 | p50 | p95 | min | max |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const result of results) {
    lines.push(
      `| ${result.metric} | ${result.turns} | ${result.rows} | ${formatMs(result.p50)} | ${formatMs(result.p95)} | ${formatMs(result.min)} | ${formatMs(result.max)} |`,
    );
  }
  lines.push("");
  lines.push(
    "指标含义见上文 What is measured（and what is not）；p50/p95 为最近邻秩百分位。" +
      "上表只覆盖纯投影/纯函数层，Electron 启动、React 渲染、布局/绘制、worker 池与内存仍是 live-gated，不在此表内。",
  );
  return [DOC_SECTION_START, ...lines, DOC_SECTION_END].join("\n");
}

async function writeDocSection(section) {
  const current = await readFile(docPath, "utf8");
  const startIndex = current.indexOf(DOC_SECTION_START);
  const endIndex = current.indexOf(DOC_SECTION_END);
  if (startIndex === -1 || endIndex === -1) {
    throw new Error(
      `doc markers missing in ${docPath}; expected ${DOC_SECTION_START} / ${DOC_SECTION_END}`,
    );
  }
  const next =
    current.slice(0, startIndex) + section + current.slice(endIndex + DOC_SECTION_END.length);
  await writeFile(docPath, next, "utf8");
  // 生成的表格按脚本手工拼接，列宽与仓库 oxfmt 的 markdown 表格规约不一致；
  // 写入后直接用仓库自带 oxfmt 归一，保证 pnpm fmt:check 不因基线刷新而变红。
  const oxfmtBin = path.join(repoRoot, "node_modules", "oxfmt", "bin", "oxfmt");
  try {
    execFileSync(process.execPath, [oxfmtBin, docPath], { stdio: "ignore" });
  } catch (error) {
    throw new Error(`failed to format ${docPath} with repo oxfmt: ${String(error)}`);
  }
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const modules = await loadRepositoryModules();
  const seed = args.seed ?? modules.fixtures.V4_REPLAY_FIXTURE_DEFAULT_SEED;
  const environment = collectEnvironment();
  const results = [];

  for (const turns of args.turns) {
    const { rows, stats } = modules.fixtures.generateV4ReplayRows({ turns, seed });
    const nowMs = (rows.at(-1)?.createdAt ?? 0) + 1_000;
    const units = modules.buildConversationTurnRenderUnits(rows, {
      nowMs,
      sessionPhase: "completedSuccess",
    });
    if (units.length !== turns) {
      throw new Error(`fixture invariant broken: turns=${turns} but render units=${units.length}`);
    }

    const navigatorOptions = { ...NAVIGATOR_PREVIEW_OPTIONS };
    const cachedBuilder = modules.createCachedConversationTurnNavigatorItemsBuilder();
    cachedBuilder(units, navigatorOptions);

    const { headDeltas, frameDeltas } = buildStreamingFrame({
      fixtures: modules.fixtures,
      rows,
    });
    const baseSnapshot = {
      rows: { window: [...rows], totalCount: rows.length, firstRowId: rows[0]?.rowId ?? null },
    };
    const hydratedSnapshot = modules.applyConversationDeltas(baseSnapshot, headDeltas);

    const metrics = [
      {
        metric: "render-unit 全量重建（buildConversationTurnRenderUnits）",
        rows: stats.rows,
        run: () =>
          modules.buildConversationTurnRenderUnits(rows, {
            nowMs,
            sessionPhase: "completedSuccess",
          }),
      },
      {
        metric: "导航目录 · 未缓存（buildConversationTurnNavigatorItems）",
        rows: stats.rows,
        run: () => modules.buildConversationTurnNavigatorItems(units, navigatorOptions),
      },
      {
        metric: "导航目录 · 稳态缓存（createCached…Builder 复用命中）",
        rows: stats.rows,
        run: () => cachedBuilder(units, navigatorOptions),
      },
      {
        metric: "流式 row.delta 逻辑帧应用（24 delta/帧，applyConversationDeltas）",
        rows: stats.rows,
        run: () => modules.applyConversationDeltas(hydratedSnapshot, frameDeltas),
      },
    ];

    for (const entry of metrics) {
      const measured = measure({ ticks: args.ticks, warmup: args.warmup, run: entry.run });
      results.push({ metric: entry.metric, turns, rows: entry.rows, ...measured });
      console.log(
        `[turns=${turns}] ${entry.metric}: p50=${formatMs(measured.p50)} p95=${formatMs(measured.p95)} min=${formatMs(measured.min)} max=${formatMs(measured.max)}`,
      );
    }
  }

  const section = renderDocSection({ environment, args: { ...args, seed }, results });
  if (args.write) {
    await writeDocSection(section);
    console.log(`doc updated: ${path.relative(repoRoot, docPath)}`);
  } else {
    console.log("--no-write: doc not updated");
  }
}

await main();
