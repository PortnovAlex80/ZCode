// P-01 独立渲染基线的合成 v4 回放 fixture 生成器（库 + CLI）。
//
// 目标：在不启动 Electron、不触碰 ~/.zcode、不访问 live profile 的前提下，提供
// 确定性（同 seed 同输出）的 v4 会话行序列，供 scripts/perf/run-render-baseline.mjs
// 与 packages/ui/test/v4ReplayBaseline.test.ts 回放同一条时间线。
//
// 行形状以 packages/shared/src/zcode-protocol-v4/rows.ts 的 zod schema 为准
// （conversationRowSchema 判别联合）；本文件保持纯 .mjs、零仓库 TS 依赖，
// 协议合法性由 vitest 用例用真实 schema 校验，这里不复制校验规则。
//
// CLI 用法：
//   node scripts/perf/v4-replay-fixtures.mjs 200 20261012
// 只打印统计，不写任何文件（库导入入口为下方两个导出函数）。

/** 默认 seed：固定为基线记录日期，保证文档中的表格可复现。 */
export const V4_REPLAY_FIXTURE_DEFAULT_SEED = 20261012;

const TURN_BASE_TIMESTAMP_MS = 1_750_000_000_000;
const USER_QUERY_TEMPLATES = [
  "帮我看一下这个模块为什么在 Windows 下启动变慢，重点排查 IO 初始化路径",
  "Refactor the pane recovery state so a lost host does not strand the draft",
  "把文档里的安装步骤更新成一条命令，并补上校验产物的说明",
  "Why does the detached panel flash the empty state before hydration completes?",
  "为会话列表增加归档筛选，注意移动端窄屏下的交互",
  "Summarize the failure modes of the return handshake and rank them by risk",
];
const MODEL_IDS = ["glm-5.3", "glm-5.3-air", "glm-5.4"];
const TOOL_SEQUENCE = [
  "Read",
  "Grep",
  "Glob",
  "Bash",
  "Edit",
  "Write",
  "TodoWrite",
  "Task",
  "EnterPlanMode",
];
const CODE_SNIPPET = [
  "applyConversationDeltas(current, frame.payload.deltas)",
  "for (const listener of this.listeners) listener()",
  "return { ...row, text: row.text + append }",
];
const PROSE_SENTENCES = [
  "边界判定必须以投影下发的权威字段为准，renderer 不得按文本反推语义。",
  "快照整体替换，增量只在水位衔接时应用，断档交给服务端裁决。",
  "折叠组的默认展开规则由轮首 header 的终态与最后一段工作状态共同决定。",
  "虚拟列表的 key 只依赖协议稳定身份，补页不会把原轮当成新节点重挂。",
  "导航目录按用户可见 query 建项，产品轮内的系统注入不进目录。",
];

/** mulberry32：小型确定性 PRNG，跨 Node 版本稳定，不依赖 crypto。 */
function createRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomInt(rng, minInclusive, maxInclusive) {
  return minInclusive + Math.floor(rng() * (maxInclusive - minInclusive + 1));
}

function pick(rng, items) {
  return items[randomInt(rng, 0, items.length - 1)];
}

function sentence(turnIndex, offset) {
  return PROSE_SENTENCES[Math.abs(turnIndex * 5 + offset * 7) % PROSE_SENTENCES.length];
}

function buildUserQueryText(turnIndex) {
  return `${USER_QUERY_TEMPLATES[turnIndex % USER_QUERY_TEMPLATES.length]}。${sentence(turnIndex, 3)}`;
}

function buildAssistantMarkdown(rng, turnIndex) {
  const paragraphs = [`### 结论 ${turnIndex}`];
  const paragraphCount = randomInt(rng, 3, 6);
  for (let i = 0; i < paragraphCount; i += 1) {
    paragraphs.push(`${sentence(turnIndex, i)}${sentence(turnIndex + i, 3)}`);
    if (i === 1) paragraphs.push("```ts\n" + CODE_SNIPPET.join("\n") + "\n```");
    if (i === 2) paragraphs.push(`- ${sentence(turnIndex, i)}\n- ${sentence(turnIndex + i, 3)}`);
  }
  return paragraphs.join("\n\n");
}

const TOOL_INPUT_SPECS = {
  Read: (turnIndex) => ({ path: `packages/ui/src/v4/turn${turnIndex % 40}.ts` }),
  Grep: () => ({ pattern: "turnHeader", path: "packages/shared/src" }),
  Glob: () => ({ pattern: "packages/ui/src/v4/*.ts" }),
  Edit: (turnIndex) => ({
    path: `packages/ui/src/v4/turn${turnIndex % 40}.ts`,
    oldText: CODE_SNIPPET[turnIndex % CODE_SNIPPET.length],
    newText: CODE_SNIPPET[(turnIndex + 1) % CODE_SNIPPET.length],
  }),
  Write: (turnIndex) => ({ path: `docs/notes/turn-${turnIndex}.md` }),
  TodoWrite: () => ({ todos: ["investigate", "fix", "verify"] }),
  Task: () => ({ prompt: "audit pane recovery states", type: "review" }),
  EnterPlanMode: () => ({ plan: "harden return handshake" }),
};

function buildToolInputText(toolName, turnIndex) {
  if (toolName === "Bash")
    return `node scripts/perf/run-render-baseline.mjs --turns ${turnIndex} --ticks 20`;
  return JSON.stringify(TOOL_INPUT_SPECS[toolName](turnIndex));
}

const PROSE_OUTPUT_TOOLS = new Set(["Read", "Grep", "Glob", "Write"]);
// 每 10 轮的自动截图 display（browser 轮尾内容块路径）。
const BROWSER_TURN_END_DISPLAY = {
  kind: "node_repl_images",
  source: "browser_turn_end",
  images: [{ base64: "aGVsbG8gYmFzZWxpbmU=", mimeType: "image/png" }],
};

function buildToolOutput(toolName, rng, turnIndex) {
  if (toolName === "Edit") {
    return {
      text: "the file has been updated",
      display: {
        kind: "file_diff",
        filePath: `packages/ui/src/v4/turn${turnIndex % 40}.ts`,
        additions: randomInt(rng, 3, 48),
        deletions: randomInt(rng, 1, 20),
        structuredPatch: [
          {
            oldStart: 10,
            oldLines: 3,
            newStart: 10,
            newLines: 4,
            lines: ["- if (frame.fromSeq !== current.seq) return;", "+ this.requestRecovery();"],
          },
        ],
      },
    };
  }
  if (toolName === "Bash")
    return {
      text: Array.from({ length: randomInt(rng, 2, 8) }, () => pick(rng, CODE_SNIPPET)).join("\n"),
    };
  if (PROSE_OUTPUT_TOOLS.has(toolName)) {
    return {
      text: Array.from({ length: randomInt(rng, 1, 5) }, () => pick(rng, PROSE_SENTENCES)).join(
        "\n",
      ),
    };
  }
  return undefined;
}

// 行构造 helper：把重复的字段组合收敛到一处，调用点保持单行。
function markerRow(identity, lane, marker) {
  return { ...identity, kind: "timelineMarker", lane, marker };
}

function textRow(identity, turnIndex, text, state, extra = {}) {
  return {
    ...identity,
    kind: "assistantText",
    assistantResponseId: `resp-${turnIndex}`,
    text,
    state,
    model: MODEL_IDS[turnIndex % MODEL_IDS.length],
    ...extra,
  };
}

function toolCallRow(identity, turnIndex, toolIndex, toolName, extra = {}) {
  return {
    ...identity,
    kind: "toolCall",
    assistantResponseId: `resp-${turnIndex}`,
    toolCallId: `tool-${turnIndex}-${toolIndex}`,
    toolName,
    status: "success",
    inputText: buildToolInputText(toolName, turnIndex),
    ...extra,
  };
}

/**
 * 生成一份确定性 v4 会话回放行序列。
 *
 * @param {{turns?: number, seed?: number}} options
 * @returns {{rows: Array<Record<string, unknown>>, stats: {turns: number, rows: number, byKind: Record<string, number>, realUserQueries: number, seed: number}}}
 */
export function generateV4ReplayRows({ turns = 200, seed = V4_REPLAY_FIXTURE_DEFAULT_SEED } = {}) {
  if (!Number.isInteger(turns) || turns < 1) {
    throw new Error(`turns must be a positive integer, received: ${turns}`);
  }
  const rng = createRng(seed);
  const rows = [];
  const byKind = Object.create(null);
  let rowId = 0;
  const append = (row) => {
    rowId += 1;
    byKind[row.kind] = (byKind[row.kind] ?? 0) + 1;
    rows.push({
      createdAt: TURN_BASE_TIMESTAMP_MS + rowId * 500,
      createdAtSeq: rowId,
      rowId,
      entityId: `${row.kind}-${rowId}`,
      ...row,
    });
  };

  for (let turnIndex = 1; turnIndex <= turns; turnIndex += 1) {
    const identity = { turnId: `turn-${turnIndex}`, productTurnId: `product-turn-${turnIndex}` };
    const sourceCommandId = `cmd-${turnIndex}`;
    const isInterrupted = turnIndex % 23 === 0;
    const isFailed = turnIndex % 41 === 0;
    const turnState = isFailed
      ? "failed"
      : isInterrupted
        ? "completedInterrupted"
        : "completedSuccess";
    const startedAt = TURN_BASE_TIMESTAMP_MS + turnIndex * 120_000;
    append({
      ...identity,
      kind: "turnHeader",
      origin: "userInput",
      executionKind: "agent",
      sourceCommandId,
      state: turnState,
      startedAt,
      activeMs: 21_000 + randomInt(rng, 0, 25_000),
    });

    // 轮顶轻边界（modelChange）每 40 轮出现一次，渲染在用户输入之前。
    if (turnIndex % 40 === 0) {
      append(
        markerRow(identity, "lightBoundary", {
          type: "modelChange",
          toProvider: "zai",
          toModel: MODEL_IDS[turnIndex % MODEL_IDS.length],
          toThought: "enabled",
        }),
      );
    }

    append({
      ...identity,
      kind: "userInput",
      text: buildUserQueryText(turnIndex),
      origin: "realUser",
      sourceCommandId,
    });

    // 每 9 轮注入一条 background 来源的系统输入：导航目录必须把它过滤掉。
    if (turnIndex % 9 === 0) {
      append({
        ...identity,
        kind: "userInput",
        text: "后台任务已完成，等待前台空闲投递结果。",
        origin: "backgroundResult",
        sourceCommandId: `background-${turnIndex}`,
      });
    }

    append({
      ...identity,
      kind: "reasoning",
      assistantResponseId: `resp-${turnIndex}`,
      text: sentence(turnIndex, 0) + sentence(turnIndex, 1),
      state: "complete",
    });

    // 每 12 轮一条空正文 reasoning：render unit 必须在可见层裁掉它。
    if (turnIndex % 12 === 0) {
      append({
        ...identity,
        kind: "reasoning",
        assistantResponseId: `resp-${turnIndex}`,
        text: "   ",
        state: "complete",
      });
    }

    const toolCount = 3 + randomInt(rng, 0, 5);
    for (let toolIndex = 0; toolIndex < toolCount; toolIndex += 1) {
      const toolName = TOOL_SEQUENCE[(turnIndex + toolIndex) % TOOL_SEQUENCE.length];
      const toolOutput = buildToolOutput(toolName, rng, turnIndex);
      // 每 10 轮在首个可渲染工具上带自动截图 display：行落在工具流中间，
      // render unit 必须仍把它抽取到轮尾内容块（isBrowserTurnEndRow 路径）。
      const browserDisplay =
        turnIndex % 10 === 0 && toolIndex === 0 && toolName !== "EnterPlanMode"
          ? { display: BROWSER_TURN_END_DISPLAY }
          : {};
      append(
        toolCallRow(identity, turnIndex, toolIndex, toolName, {
          ...(toolOutput ? { output: toolOutput } : {}),
          ...browserDisplay,
        }),
      );
      if (toolName === "Task" && turnIndex % 7 === 0) {
        append({
          ...identity,
          kind: "subagent",
          subagentType: "general-purpose",
          status: "success",
          summaryText: pick(rng, PROSE_SENTENCES),
          childSessionId: `child-session-${turnIndex}`,
        });
      }
    }

    // 每 25 轮一次 compact：进「已工作」折叠组的 assistantWork 泳道。
    if (turnIndex % 25 === 0) {
      append(
        markerRow(identity, "assistantWork", {
          type: "compact",
          origin: "auto",
          status: "success",
          tokensBefore: 90_000 + randomInt(rng, 0, 40_000),
          tokensAfter: 12_000 + randomInt(rng, 0, 8_000),
        }),
      );
    }

    // 每 6 轮一条轮中短正文，之后是每轮的最终答复（带 fork/retry action）。
    if (turnIndex % 6 === 0)
      append(textRow(identity, turnIndex, sentence(turnIndex, 2), "complete"));
    const finalText = isInterrupted
      ? `${buildAssistantMarkdown(rng, turnIndex)}\n\n（本轮被用户中断，以上为部分输出。）`
      : buildAssistantMarkdown(rng, turnIndex);
    append(
      textRow(
        identity,
        turnIndex,
        finalText,
        isFailed ? "failed" : isInterrupted ? "interrupted" : "complete",
        { actions: { canFork: true, canRetry: true, canEdit: true, editDisposition: "fork" } },
      ),
    );

    // 每 50 轮一次 goalVerify：turnTailBoundary 泳道，留在轮尾不折叠。
    if (turnIndex % 50 === 0) {
      append(
        markerRow(identity, "turnTailBoundary", {
          type: "goalVerify",
          iteration: turnIndex / 50,
          outcome: "pass",
        }),
      );
    }
  }

  let realUserQueries = 0;
  for (const row of rows) {
    if (row.kind === "userInput" && row.origin === "realUser") realUserQueries += 1;
  }
  return { rows, stats: { turns, rows: rows.length, byKind, realUserQueries, seed } };
}

/**
 * 构造一个运行中轮的流式尾部增量序列（row.appended + row.delta + row.upserted），
 * 用于回放 streaming 失效路径（applyConversationDeltas 的逐帧成本）。完全由
 * turnIndex/chunks 决定（无随机量），可与任意基线行序列拼接。
 *
 * @param {{chunks?: number, baseRowId?: number, turnIndex?: number}} options
 * @returns {{deltas: Array<Record<string, unknown>>, turnId: string, expectedText: string, streamingRowId: number}}
 */
export function buildV4ReplayStreamTail({ chunks = 48, baseRowId = 0, turnIndex = 1 } = {}) {
  if (!Number.isInteger(chunks) || chunks < 1) {
    throw new Error(`chunks must be a positive integer, received: ${chunks}`);
  }
  const turnId = `stream-${turnIndex}`;
  const startedAt = TURN_BASE_TIMESTAMP_MS + turnIndex * 120_000;
  const sourceCommandId = `stream-cmd-${turnIndex}`;
  const tailRow = (kind, rowId, createdAt, extra) => ({
    kind,
    rowId,
    turnId,
    entityId: `${kind}-${rowId}`,
    createdAt,
    createdAtSeq: rowId,
    ...extra,
  });
  let nextRowId = baseRowId;
  const newRowId = () => ++nextRowId;
  const deltas = [];
  const pushRow = (row) => deltas.push({ op: "row.appended", row });
  const headerRowId = newRowId();
  const inputRowId = newRowId();
  const streamingRowId = newRowId();
  pushRow(
    tailRow("turnHeader", headerRowId, startedAt, {
      origin: "userInput",
      executionKind: "agent",
      sourceCommandId,
      state: "running",
      startedAt,
    }),
  );
  pushRow(
    tailRow("userInput", inputRowId, startedAt + 10, {
      text: buildUserQueryText(turnIndex),
      origin: "realUser",
      sourceCommandId,
    }),
  );
  pushRow(
    tailRow("assistantText", streamingRowId, startedAt + 200, {
      assistantResponseId: `stream-resp-${turnIndex}`,
      text: "",
      state: "streaming",
      model: MODEL_IDS[turnIndex % MODEL_IDS.length],
    }),
  );
  const chunkTexts = [];
  for (let i = 0; i < chunks; i += 1) {
    const chunk = `${PROSE_SENTENCES[(turnIndex + i) % PROSE_SENTENCES.length]} `;
    chunkTexts.push(chunk);
    deltas.push({ op: "row.delta", rowId: streamingRowId, path: "text", append: chunk });
  }
  const expectedText = chunkTexts.join("");
  deltas.push({
    op: "row.upserted",
    row: tailRow("assistantText", streamingRowId, startedAt + 200, {
      assistantResponseId: `stream-resp-${turnIndex}`,
      text: expectedText,
      state: "complete",
      model: MODEL_IDS[turnIndex % MODEL_IDS.length],
      actions: { canFork: true, canRetry: true },
    }),
  });
  deltas.push({
    op: "row.upserted",
    row: tailRow("turnHeader", headerRowId, startedAt, {
      origin: "userInput",
      executionKind: "agent",
      sourceCommandId,
      state: "completedSuccess",
      startedAt,
      endedAt: startedAt + 60_000,
      activeMs: 55_000,
    }),
  });
  return { deltas, turnId, expectedText, streamingRowId };
}

// ── CLI（位置参数：<turns> [seed]，只打印统计，不写文件）──

// CLI 直跑判定：两侧都经 path.resolve 归一（Windows 下 argv[1] 与 import.meta.filename
// 的分隔符不一致，直接字符串比较会让统计静默不执行）。
const pathModule = await import("node:path");
const invokedAsCli =
  process.argv[1] !== undefined &&
  pathModule.resolve(process.argv[1]) === pathModule.resolve(import.meta.filename);
if (invokedAsCli) {
  const turns = Number.parseInt(process.argv[2] ?? "200", 10);
  const seed = Number.parseInt(process.argv[3] ?? String(V4_REPLAY_FIXTURE_DEFAULT_SEED), 10);
  const { stats } = generateV4ReplayRows({ turns, seed });
  const kindSummary = Object.entries(stats.byKind)
    .map(([kind, count]) => `${kind}=${count}`)
    .join(", ");
  console.log(`v4 replay fixture: turns=${stats.turns} rows=${stats.rows} seed=${stats.seed}`);
  console.log(`row kinds: ${kindSummary}`);
  console.log(`realUser queries: ${stats.realUserQueries}`);
}
