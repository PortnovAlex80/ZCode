/* eslint-disable max-lines -- 配对测量 harness 需要把场景定义、交替试次编排与报告渲染
   维护在同一可复现单元里（场景表与报告口径一一对应，拆分会隐藏测量边界）。 */
// 渲染性能候选配对测量 harness（Wave 3，prompt §8 测量契约）。
//
// 目的：在同一个进程、同一份 fixture、同一台机器上，按 A/B 交替顺序配对测量
// 「优化前实现」与「优化后实现」的纯函数成本，不与历史无关运行比较。
//
// 配对臂（同一提交内同时存在，见 RENDERING-PERFORMANCE-WAVES-PROMPT §6/§7/§8）：
// - B（一帧批量应用）  before=applyConversationDeltas（未修改的裁判）
//                      after=applyConversationFrame（候选）
// - 插件准备            before=deriveLogicalUiInstancesBaseline（test/support 冻结副本，
//                      HEAD f6d3678e 逐字节拷贝）after=deriveLogicalUiInstances（候选）
// - C（展示准备）       before=buildConversationTurnRenderUnits（全量 builder，独立参照）
//                      after=createCachedConversationTurnRenderUnitsBuilder（候选）
//
// 边界拆分（§8.6）：helper-only apply / 插件准备 / 完整纯展示准备 / 组合每帧流水线
// 分别成表；等价断言全部在计时区外做；每臂每场景 warmup 后取 ticks 个样本，
// p50/p95 用最近邻秩（与 run-render-baseline.mjs 同口径）。
//
// 场景（§8.2）：空帧 / control-only / 1-op / 24-op 未合并压力 / 24-op 合并后（典型线上帧）/
// 混合分布帧（8 行分布 delta + control）；C 另含流式稳态、迟到旧轮更新、历史前插、
// 截断修剪、冷重建；噪声参照臂 = 全量 builder 对自身（baseline/baseline）。
//
// 已知口径限制（如实披露，不冒充 GUI 证据）：fixture 生成 0 个插件实例（与审计相同）；
// 插件臂测得的差异来自 turnOrder 判重路径，与插件卡数量无关；无 React/Electron/布局绘制。
//
// 用法：
//   node scripts/perf/run-render-paired-candidate.mjs --turns 200,1000,2000 --ticks 60
//        [--warmup 10] [--seed 20261012] [--trials 3]
//        [--report docs/spec-harness/RENDERING-PERFORMANCE-PAIRED-MEASUREMENTS.md]
// 报告写入 --report 指定文件（默认见上）；stdout 同时打印汇总。

import { execFileSync } from "node:child_process";
import os from "node:os";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..");
const defaultReport = path.join(
  repoRoot,
  "docs",
  "spec-harness",
  "RENDERING-PERFORMANCE-PAIRED-MEASUREMENTS.md",
);

function parseCliArgs(argv) {
  const args = {
    turns: [200, 1000, 2000],
    ticks: 60,
    warmup: 10,
    seed: 20261012,
    trials: 3,
    report: defaultReport,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = () => argv[(index += 1)];
    if (token === "--turns") args.turns = next().split(",").map((value) => Number(value));
    else if (token === "--ticks") args.ticks = Number(next());
    else if (token === "--warmup") args.warmup = Number(next());
    else if (token === "--seed") args.seed = Number(next());
    else if (token === "--trials") args.trials = Number(next());
    else if (token === "--report") args.report = path.resolve(next());
    else throw new Error(`unknown argument: ${token}`);
  }
  return args;
}

function percentileNearestRank(sorted, rank) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))];
}

function statsOf(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: percentileNearestRank(sorted, Math.floor(sorted.length * 0.5)),
    p95: percentileNearestRank(sorted, Math.ceil(sorted.length * 0.95) - 1),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

function formatMs(value) {
  return `${value.toFixed(2)} ms`;
}

function collectEnvironment() {
  let revision = "unknown";
  let dirtyFiles = 0;
  try {
    revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
    dirtyFiles = execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" })
      .split("\n")
      .filter((line) => line.trim().length > 0).length;
  } catch {
    // git 不可用时测量仍可运行，revision 记 unknown。
  }
  const cpus = os.cpus();
  return {
    nodeVersion: process.version,
    platform: `${os.platform()} ${os.arch()}`,
    cpu: cpus[0]?.model ?? "unknown",
    revision,
    dirtyFiles,
    date: new Date().toISOString(),
  };
}

async function loadRepositoryModules() {
  process.env.TSX_TSCONFIG_PATH = path.join(repoRoot, "packages", "ui", "tsconfig.json");
  const { tsImport } = await import("tsx/esm/api");
  const asUrl = (relative) => pathToFileURL(path.join(repoRoot, relative)).href;
  const fixtures = await import(pathToFileURL(path.join(scriptDir, "v4-replay-fixtures.mjs")).href);
  const applyModule = await tsImport(
    asUrl("packages/shared/src/zcode-protocol-v4/apply.ts"),
    import.meta.url,
  );
  const applyFrameModule = await tsImport(
    asUrl("packages/shared/src/zcode-protocol-v4/applyFrame.ts"),
    import.meta.url,
  );
  const coalesceModule = await tsImport(
    asUrl("packages/shared/src/zcode-protocol-v4/coalesce.ts"),
    import.meta.url,
  );
  const renderUnitsModule = await tsImport(
    asUrl("packages/ui/src/v4/conversationTurnRenderUnits.ts"),
    import.meta.url,
  );
  const cacheModule = await tsImport(
    asUrl("packages/ui/src/v4/conversationTurnRenderUnitsCache.ts"),
    import.meta.url,
  );
  const policyModule = await tsImport(
    asUrl("packages/ui/src/plugin-ui/domain/pluginUiInstancePolicy.ts"),
    import.meta.url,
  );
  const policyBaselineModule = await tsImport(
    asUrl("packages/ui/test/support/pluginUiInstancePolicyFrozenBaseline.ts"),
    import.meta.url,
  );
  return {
    fixtures,
    applyConversationDeltas: applyModule.applyConversationDeltas,
    applyConversationFrame: applyFrameModule.applyConversationFrame,
    coalesceConversationDeltas: coalesceModule.coalesceConversationDeltas,
    buildConversationTurnRenderUnits: renderUnitsModule.buildConversationTurnRenderUnits,
    createCachedConversationTurnRenderUnitsBuilder:
      cacheModule.createCachedConversationTurnRenderUnitsBuilder,
    deriveLogicalUiInstances: policyModule.deriveLogicalUiInstances,
    deriveLogicalUiInstancesBaseline: policyBaselineModule.deriveLogicalUiInstancesBaseline,
  };
}

/** 计时一个（scenario, arm, size）单元：warmup 后取 ticks 个样本。返回 {stats, sink}。 */
function measure({ warmup, ticks, setup, run }) {
  const context = setup();
  let sink = 0;
  for (let index = 0; index < warmup; index += 1) sink += run(context, index % ticks) ?? 0;
  const samples = [];
  for (let index = 0; index < ticks; index += 1) {
    const start = performance.now();
    const consumed = run(context, index);
    samples.push(performance.now() - start);
    sink += consumed ?? 0;
  }
  return { stats: statsOf(samples), sink };
}

/** 断言两臂输出等价（计时区外，一次性/每尺寸一次）。 */
function assertDeepEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error(
      `equivalence failure [${label}]: byte-identical JSON mismatch (lengths ${a.length} vs ${b.length})`,
    );
  }
}

function buildScenarioSuite({ modules, args, turns, environment }) {
  const { fixtures, applyConversationDeltas, applyConversationFrame, coalesceConversationDeltas } =
    modules;
  const { buildConversationTurnRenderUnits, createCachedConversationTurnRenderUnitsBuilder } =
    modules;
  const { deriveLogicalUiInstances, deriveLogicalUiInstancesBaseline } = modules;
  const { seed, warmup, ticks } = args;

  const generated = fixtures.generateV4ReplayRows({ turns, seed });
  const tail = fixtures.buildV4ReplayStreamTail({ chunks: 48, baseRowId: generated.rows.at(-1).rowId });
  const headDeltas = tail.deltas.filter((delta) => delta.op === "row.appended");
  // 逻辑帧测量基座：已应用 append 头的快照（裁判路径应用，setup 区不计入测量）。
  const base = applyConversationDeltas(
    {
      rows: {
        window: [...generated.rows],
        totalCount: generated.rows.length + headDeltas.length,
        firstRowId: generated.rows[0]?.rowId ?? null,
      },
    },
    headDeltas,
  );

  const firstAppend = tail.deltas.find((delta) => delta.op === "row.delta");
  const chunkText = firstAppend?.append ?? "x";
  const frame24 = Array.from({ length: 24 }, () => ({
    op: "row.delta",
    rowId: tail.streamingRowId,
    path: "text",
    append: chunkText,
  }));
  const frameCoalesced = coalesceConversationDeltas(frame24);
  const frame1 = [frame24[0]];
  const frameControl = [{ op: "state.updated", patch: { revision: 4, usage: { cumulative: { inputTokens: 9 } } } }];
  // 混合分布帧：8 个不同 assistantText 行的分布 delta + 1 条 control（典型合并后帧形）。
  const assistantRows = base.rows.window.filter((row) => row.kind === "assistantText");
  const mixedTargets = assistantRows.slice(-8);
  const frameMixed = [
    ...mixedTargets.map((row, index) => ({
      op: "row.delta",
      rowId: row.rowId,
      path: "text",
      append: `${index + 1} `,
    })),
    frameControl[0],
  ];

  // —— 等价断言（计时区外）：候选帧路径 vs 裁判逐条路径 ——
  for (const [label, frame] of [
    ["empty", []],
    ["control", frameControl],
    ["1op", frame1],
    ["24op-uncoalesced", frame24],
    ["24op-post-coalescing", frameCoalesced],
    ["mixed", frameMixed],
  ]) {
    const oracle = applyConversationDeltas(base, frame);
    const candidate = applyConversationFrame(base, frame);
    assertDeepEqual(candidate, oracle, `apply ${label} @${turns}`);
  }

  // —— 插件策略等价（冻结 before vs 当前 after）——
  assertDeepEqual(
    deriveLogicalUiInstances(generated.rows),
    deriveLogicalUiInstancesBaseline(generated.rows),
    `plugin policy @${turns}`,
  );

  // —— C 场景的窗口序列（裁判路径在 setup 预生成，两臂共享同一输入）——
  const BUILD_OPTIONS = { nowMs: 1_750_080_000_000, sessionPhase: "running" };
  const CACHE_OPTIONS = { ...BUILD_OPTIONS, scopeKey: `paired:${turns}` };
  // 流式稳态：60 个连续 1-op 帧产生的窗口序列。
  const streamingWindows = [base.rows.window];
  {
    let current = base;
    for (let index = 0; index < Math.max(ticks, warmup); index += 1) {
      current = applyConversationDeltas(current, [
        { op: "row.delta", rowId: tail.streamingRowId, path: "text", append: "tail " },
      ]);
      streamingWindows.push(current.rows.window);
    }
  }
  // 迟到旧轮更新：替换第 3 个 assistantText 行引用（文本延长）。
  const lateOldRow = assistantRows[2] ?? assistantRows[0];
  const lateWindow = streamingWindows.at(-1).map((row) =>
    row === lateOldRow ? { ...row, text: `${row.text} late-arriving result` } : row,
  );
  // 历史前插：独立 3 轮历史（合法行结构），rowId 平移到主窗之下。
  const prependSource = fixtures.generateV4ReplayRows({ turns: 3, seed: seed + 7 });
  const minRowId = Math.min(
    ...streamingWindows[0].map((row) => row.rowId),
    ...prependSource.rows.map((row) => row.rowId),
  );
  const prependRows = prependSource.rows.map((row, index) => ({
    ...row,
    rowId: minRowId - 1000 + index,
    turnId: `old-${row.turnId}`,
  }));
  const prependWindow = [...prependRows, ...streamingWindows.at(-1)];
  // 截断修剪：去掉最后一轮（含流式尾）。
  const truncateWindow = streamingWindows[0].filter((row) => row.turnId !== tail.deltas[0].row.turnId);

  // —— C 等价断言（计时区外）：缓存 builder 输出 vs 全量 builder ——
  {
    const cacheBuilder = createCachedConversationTurnRenderUnitsBuilder();
    for (const window of [streamingWindows[0], lateWindow, prependWindow, truncateWindow]) {
      cacheBuilder.build(window, CACHE_OPTIONS); // 预热同一 scope（等价断言用，不计入测量）
      assertDeepEqual(
        cacheBuilder.build(window, CACHE_OPTIONS),
        buildConversationTurnRenderUnits(window, BUILD_OPTIONS),
        `cached render units @${turns}`,
      );
    }
  }

  const unitCount = (units) => units.length;

  const scenarios = [
    {
      id: "apply-empty",
      boundary: "helper-only apply",
      before: { setup: () => ({}), run: () => unitCount(applyConversationDeltas(base, []).rows.window) },
      after: { setup: () => ({}), run: () => unitCount(applyConversationFrame(base, []).rows.window) },
    },
    {
      id: "apply-control-only",
      boundary: "helper-only apply",
      before: {
        setup: () => ({}),
        run: () => unitCount(applyConversationDeltas(base, frameControl).rows.window),
      },
      after: {
        setup: () => ({}),
        run: () => unitCount(applyConversationFrame(base, frameControl).rows.window),
      },
    },
    {
      id: "apply-1op",
      boundary: "helper-only apply",
      note: "两臂最终走同一 applyConversationDelta（1-op 委托）；差异在亚毫秒噪声带内（2000t 逐 trial 双向散布 0.33–0.67ms）",
      before: {
        setup: () => ({}),
        run: () => unitCount(applyConversationDeltas(base, frame1).rows.window),
      },
      after: {
        setup: () => ({}),
        run: () => unitCount(applyConversationFrame(base, frame1).rows.window),
      },
    },
    {
      id: "apply-24op-uncoalesced-stress",
      boundary: "helper-only apply",
      before: {
        setup: () => ({}),
        run: () => unitCount(applyConversationDeltas(base, frame24).rows.window),
      },
      after: {
        setup: () => ({}),
        run: () => unitCount(applyConversationFrame(base, frame24).rows.window),
      },
    },
    {
      id: "apply-24op-post-coalescing",
      boundary: "helper-only apply",
      note: `${frameCoalesced.length} op（典型线上帧形）。判读：interleaved harness 中 after 偶见 +0.1ms 级稳定差（V8 跨场景优化态串扰）；独立探针（同 fixture、交替 A/B×4）两臂持平 0.26–0.37ms 交替领先 → 本场景按 inconclusive-but-bounded 记录，不上调任何预算`,
      before: {
        setup: () => ({}),
        run: () => unitCount(applyConversationDeltas(base, frameCoalesced).rows.window),
      },
      after: {
        setup: () => ({}),
        run: () => unitCount(applyConversationFrame(base, frameCoalesced).rows.window),
      },
    },
    {
      id: "apply-mixed-distributed",
      boundary: "helper-only apply",
      note: "8 行分布 row.delta + 1 control",
      before: {
        setup: () => ({}),
        run: () => unitCount(applyConversationDeltas(base, frameMixed).rows.window),
      },
      after: {
        setup: () => ({}),
        run: () => unitCount(applyConversationFrame(base, frameMixed).rows.window),
      },
    },
    {
      id: "plugin-derivation",
      boundary: "plugin preparation",
      note: "fixture 插件实例数为 0（与审计一致）",
      before: {
        setup: () => ({}),
        // fixture 插件实例数为 0：返回值加 1 保证 sink 守卫不误报（属性访问仍在计时区内强制求值）。
        run: () => 1 + deriveLogicalUiInstancesBaseline(generated.rows).instances.length,
      },
      after: {
        setup: () => ({}),
        run: () => 1 + deriveLogicalUiInstances(generated.rows).instances.length,
      },
    },
    {
      id: "render-units-full-rebuild",
      boundary: "complete pure presentation preparation",
      before: {
        setup: () => ({}),
        run: () => unitCount(buildConversationTurnRenderUnits(streamingWindows[0], BUILD_OPTIONS)),
      },
      after: {
        setup: () => ({}),
        run: () =>
          unitCount(
            createCachedConversationTurnRenderUnitsBuilder().build(
              streamingWindows[0],
              CACHE_OPTIONS,
            ),
          ),
        note: "after=每样本新建 builder（冷准备：分配/复制/索引计入测量边界内）",
      },
    },
    {
      id: "render-units-streaming-steady",
      boundary: "complete pure presentation preparation",
      before: {
        setup: () => ({ index: 0 }),
        run: (context, index) =>
          unitCount(buildConversationTurnRenderUnits(streamingWindows[index % streamingWindows.length], BUILD_OPTIONS)),
      },
      after: {
        setup: () => ({ builder: createCachedConversationTurnRenderUnitsBuilder() }),
        run: (context, index) =>
          unitCount(
            context.builder.build(
              streamingWindows[index % streamingWindows.length],
              CACHE_OPTIONS,
            ),
          ),
        note: "after=同一 builder 暖缓存（挂载级缓存，流式稳态）",
      },
    },
    {
      id: "render-units-late-old-turn",
      boundary: "complete pure presentation preparation",
      before: {
        setup: () => ({}),
        run: (context, index) =>
          unitCount(
            buildConversationTurnRenderUnits(
              index % 2 === 0 ? streamingWindows[0] : lateWindow,
              BUILD_OPTIONS,
            ),
          ),
      },
      after: {
        setup: () => ({ builder: createCachedConversationTurnRenderUnitsBuilder() }),
        run: (context, index) =>
          unitCount(
            context.builder.build(
              index % 2 === 0 ? streamingWindows[0] : lateWindow,
              CACHE_OPTIONS,
            ),
          ),
        note: "交替流式窗/迟到旧轮窗：每轮迟到轮真实失效重物化，其余轮命中",
      },
    },
    {
      id: "render-units-history-prepend",
      boundary: "complete pure presentation preparation",
      before: {
        setup: () => ({}),
        run: (context, index) =>
          unitCount(
            buildConversationTurnRenderUnits(
              index % 2 === 0 ? streamingWindows[0] : prependWindow,
              BUILD_OPTIONS,
            ),
          ),
      },
      after: {
        setup: () => ({ builder: createCachedConversationTurnRenderUnitsBuilder() }),
        run: (context, index) =>
          unitCount(
            context.builder.build(
              index % 2 === 0 ? streamingWindows[0] : prependWindow,
              CACHE_OPTIONS,
            ),
          ),
        note: "交替流式窗/前插窗：新轮物化 + 位置归一化重算，旧轮命中",
      },
    },
    {
      id: "render-units-truncate-prune",
      boundary: "complete pure presentation preparation",
      before: {
        setup: () => ({}),
        run: (context, index) =>
          unitCount(
            buildConversationTurnRenderUnits(
              index % 2 === 0 ? streamingWindows[0] : truncateWindow,
              BUILD_OPTIONS,
            ),
          ),
      },
      after: {
        setup: () => ({ builder: createCachedConversationTurnRenderUnitsBuilder() }),
        run: (context, index) =>
          unitCount(
            context.builder.build(
              index % 2 === 0 ? streamingWindows[0] : truncateWindow,
              CACHE_OPTIONS,
            ),
          ),
        note: "交替完整窗/截断窗：截断构建含消失轮条目修剪成本",
      },
    },
    {
      id: "combined-per-frame-pipeline",
      boundary: "combined per-frame pure pipeline (apply + plugin + render units)",
      before: {
        setup: () => ({ index: 0 }),
        run: (context, index) => {
          const window = streamingWindows[index % streamingWindows.length];
          deriveLogicalUiInstancesBaseline(window);
          return unitCount(buildConversationTurnRenderUnits(window, BUILD_OPTIONS));
        },
      },
      after: {
        setup: () => ({ builder: createCachedConversationTurnRenderUnitsBuilder() }),
        run: (context, index) => {
          const window = streamingWindows[index % streamingWindows.length];
          deriveLogicalUiInstances(window);
          return unitCount(context.builder.build(window, CACHE_OPTIONS));
        },
      },
    },
    {
      id: "noise-full-builder-selfpair",
      boundary: "noise reference (baseline/baseline)",
      before: {
        setup: () => ({}),
        run: () => unitCount(buildConversationTurnRenderUnits(streamingWindows[0], BUILD_OPTIONS)),
      },
      after: {
        setup: () => ({}),
        run: () => unitCount(buildConversationTurnRenderUnits(streamingWindows[0], BUILD_OPTIONS)),
      },
    },
  ];

  return {
    turns,
    historyRows: generated.rows.length,
    applyWindowRows: base.rows.window.length,
    coalescedOps: frameCoalesced.length,
    scenarios,
  };
}

function renderReport({ args, environment, suites, trialsLog }) {
  const lines = [];
  lines.push(`# 渲染性能候选：配对测量报告（Wave 3）`);
  lines.push("");
  lines.push(`- 生成时间：${environment.date}；node ${environment.nodeVersion}；${environment.platform}；CPU ${environment.cpu}。`);
  lines.push(`- 候选 revision \`${environment.revision}\`（未提交文件 ${environment.dirtyFiles} 个）；seed ${args.seed}；warmup ${args.warmup}；ticks ${args.ticks}；trials ${args.trials}（A/B 与 B/A 交替）。`);
  lines.push(`- 配对臂都在同一进程/同一 fixture 上运行；等价断言（逐字节 JSON 相等）在计时区外全部通过后才计时。`);
  lines.push(`- 口径：p50/p95 为最近邻秩百分位（与 run-render-baseline.mjs 一致）。helper-only apply / 插件准备 / 完整纯展示准备 / 组合流水线分边界列示。`);
  lines.push(`- 限制：纯函数边界，不含 React/Electron/布局/绘制/交互；fixture 插件实例数为 0（插件臂差异来自 turnOrder 判重路径，与插件卡数量无关）；这是候选证据，不是生产验收。`);
  lines.push("");
  for (const suite of suites) {
    lines.push(`## ${suite.turns} 轮（历史 ${suite.historyRows} 行，apply 窗口 ${suite.applyWindowRows} 行；24-op 压力帧合并后 ${suite.coalescedOps} op）`);
    lines.push("");
    lines.push("| 场景 | 边界 | before p50 | after p50 | Δp50 | before p95 | after p95 | Δp95 |");
    lines.push("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |");
    for (const row of suite.rows) {
      lines.push(
        `| ${row.id}${row.note ? `<br/>${row.note}` : ""} | ${row.boundary} | ${formatMs(row.before.p50)} | ${formatMs(row.after.p50)} | ${row.deltaP50} | ${formatMs(row.before.p95)} | ${formatMs(row.after.p95)} | ${row.deltaP95} |`,
      );
    }
    lines.push("");
  }
  lines.push(`## 逐 trial 展开（p50；顺序交替）`);
  lines.push("");
  lines.push("| trial | 顺序 |");
  lines.push("| --- | --- |");
  for (const entry of trialsLog) lines.push(`| ${entry.trial} | ${entry.order} |`);
  lines.push("");
  lines.push(`详细逐 trial p50/p95 与 spread 见同目录 JSON（报告文件旁 \`.json\` 后缀）。`);
  return lines.join("\n");
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const environment = collectEnvironment();
  const modules = await loadRepositoryModules();
  const suites = [];
  const trialsLog = [];
  for (const turns of args.turns) {
    const suite = buildScenarioSuite({ modules, args, turns, environment });
    const rows = [];
    const perTrial = [];
    for (const scenario of suite.scenarios) {
      const trialResults = { before: [], after: [] };
      for (let trial = 0; trial < args.trials; trial += 1) {
        const beforeFirst = trial % 2 === 0;
        const order = beforeFirst ? "before→after" : "after→before";
        if (trial === 0) trialsLog.push({ trial: `${turns}t/${scenario.id}/${trial}`, order });
        const arms = beforeFirst
          ? [
              ["before", scenario.before],
              ["after", scenario.after],
            ]
          : [
              ["after", scenario.after],
              ["before", scenario.before],
            ];
        for (const [arm, impl] of arms) {
          const { stats, sink } = measure({ warmup: args.warmup, ticks: args.ticks, setup: impl.setup, run: impl.run });
          if (sink <= 0 && scenario.id !== "apply-empty") {
            throw new Error(`sink not consumed for ${scenario.id}/${arm} (sink=${sink})`);
          }
          trialResults[arm].push(stats);
        }
      }
      const medianOf = (list, key) => {
        const values = list.map((stats) => stats[key]).sort((a, b) => a - b);
        return percentileNearestRank(values, Math.floor(values.length / 2));
      };
      const before = {
        p50: medianOf(trialResults.before, "p50"),
        p95: medianOf(trialResults.before, "p95"),
      };
      const after = {
        p50: medianOf(trialResults.after, "p50"),
        p95: medianOf(trialResults.after, "p95"),
      };
      const ratio = (a, b) => (b <= 0 ? "n/a" : `${(a / b).toFixed(2)}x`);
      rows.push({
        id: scenario.id,
        boundary: scenario.boundary,
        note: scenario.note,
        before,
        after,
        deltaP50: ratio(after.p50, before.p50),
        deltaP95: ratio(after.p95, before.p95),
      });
      perTrial.push({ id: scenario.id, trials: trialResults });
    }
    suite.rows = rows;
    suite.perTrial = perTrial;
    suites.push(suite);
  }
  const report = renderReport({ args, environment, suites, trialsLog });
  await mkdir(path.dirname(args.report), { recursive: true });
  await writeFile(args.report, `${report}\n`, "utf8");
  await writeFile(
    `${args.report}.json`,
    JSON.stringify({ args, environment, suites }, null, 2),
    "utf8",
  );
  console.log(report);
  console.log(`\nreport written: ${args.report}`);
}

await main();
