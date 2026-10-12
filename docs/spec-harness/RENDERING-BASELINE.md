# Rendering baseline (P-01): isolated v4 replay harness

Status: **harness committed, baseline measured; live gates remain open.** This document is
owned by the P-01 implementation task and records the reproducible, Electron-free rendering
baseline required by checklist item
[P-01](IMPLEMENTATION-CHECKLIST.md#p--rendering-performance). It extends the rendering
investigation's one-off Node/tsx probe into a committed, repeatable harness.

## Scope and hard constraints

- **No Electron.** Nothing here launches, attaches to, or instruments a ZCODE window or the
  user's desktop app. The harness runs the pure projection/render-unit pipeline in plain
  Node.
- **No `~/.zcode` access.** Fixtures are synthetic and seeded; the harness never reads or
  writes the live profile and does not use `.agents/skills/zcode-large-task-fixture`
  against it.
- **No paid model prompts, no live sessions.** Row data is generated locally from a fixed
  seed.
- Checklist P-01 stays **open** after this harness lands: native-vs-fork comparison,
  renderer traces, memory/CPU/long-task capture, layout/paint and worker counts are
  live-gated and only measurable after an explicit user release of the runtime gate.

## What is measured (and what is not)

The v4 conversation timeline is driven by pure functions over the projection rows:

| Metric                                   | Entry point                                                                                      | Meaning                                                                                                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| render-unit full rebuild                 | `buildConversationTurnRenderUnits` (`packages/ui/src/v4/conversationTurnRenderUnits.ts`)         | Rebuilding every turn render unit from a complete row window — the cost `ConversationTimeline` pays when `rows` identity changes (snapshot replace, branch cut, full hydrate). |
| navigator directory, uncached            | `buildConversationTurnNavigatorItems` (`packages/ui/src/v4/conversationTurnNavigatorHelpers.ts`) | Rebuilding the question-navigator directory from scratch for every unit set — the pre-cache upper bound.                                                                       |
| navigator directory, cached steady state | `createCachedConversationTurnNavigatorItemsBuilder`                                              | The same directory built through the per-mount cache after it has primed — the production steady-state cost.                                                                   |
| streaming `row.delta` frame apply        | `applyConversationDeltas` (`packages/shared/src/zcode-protocol-v4/apply.ts`)                     | Applying one logical frame of 24 text-append deltas to a hydrated tail — the baseline for the streaming-invalidation budget that P-03 will bound.                              |

Explicitly **not** measured here (live-gated): Electron/main startup, React commit/layout/
paint, virtualizer measurements, highlight/diff worker pools, CPU/private memory/heap,
long tasks, cold/warm detach and return timing, native-vs-fork comparison. Those require
the production renderer under the released runtime gate; this table is the pure-projection
floor they must be read against.

## Fixture protocol

`scripts/perf/v4-replay-fixtures.mjs` generates the replayed session deterministically
(same seed ⇒ byte-identical rows; default seed `20261012`). Per turn it emits: a
`turnHeader` (mostly `completedSuccess`, every 23rd turn `completedInterrupted`, every 41st
`failed`), one `realUser` `userInput` (plus a `backgroundResult` input every 9th turn), 1–2
`reasoning` rows (every 12th turn one with blank text to exercise the render-unit trim), 3–8
`toolCall` rows cycling a realistic tool mix (`Read/Grep/Glob/Bash/Edit/Write/TodoWrite/
Task/EnterPlanMode`), `Edit` outputs carrying `file_diff` display, every 10th turn a
`browser_turn_end` screenshot display on its first renderable tool (the render pipeline
must hoist it to the turn end), every 7th turn a `subagent` row
beside a `Task` call, a final `assistantText` with `canFork`/`canRetry` actions, every 25th
turn an `assistantWork`-lane compact marker, every 40th turn a `lightBoundary` model change,
and every 50th turn a `turnTailBoundary` goal verify. All rows satisfy the frozen
`conversationRowSchema`; the contract is pinned by
`packages/ui/test/v4ReplayBaseline.test.ts`. (`hookInvocation` rows are not generated:
they are filtered out of every visible render path and add no measurement surface.)

`buildV4ReplayStreamTail` produces a running-turn delta sequence (`row.appended` streaming
row → `row.delta` appends → `row.upserted` completion) for the streaming metric and tests.

## How to run

```bash
# fixture stats only (positional args: <turns> [seed]; writes nothing)
node scripts/perf/v4-replay-fixtures.mjs 200 20261012

# baseline run: measures p50/p95 and refreshes the results section below
node scripts/perf/run-render-baseline.mjs --turns 200,1000 --ticks 200

# print-only (does not touch this document)
node scripts/perf/run-render-baseline.mjs --turns 200,1000 --ticks 200 --no-write

# fixture contract tests
pnpm exec vitest run packages/ui/test/v4ReplayBaseline.test.ts
```

The runner loads repository TypeScript through `tsx` with `TSX_TSCONFIG_PATH` pinned to
`packages/ui/tsconfig.json` (the `@/` alias home), so it works from any cwd. Node version
matters: results are only comparable at the recorded version. The shell toolchain note
applies — `mise.toml` pins 24.14.0 while the recorded runs below used 24.13.1
(patch-level deviation, accepted per checklist root state).

The recorded table was taken on a developer machine concurrently running other build and
test work; cross-run p50 variance under differing load was observed (full rebuild @1000
turns ranged ~16–25 ms across runs on 2026-10-12). Compare only runs taken under
comparable load, and re-run the baseline on a quiet machine before freezing P-02/P-03
thresholds.

## Results

The section between the markers below is regenerated by `run-render-baseline.mjs`; hand
edits inside it will be overwritten.

<!-- render-baseline:results:start -->

更新于 2026-10-12；node v24.13.1；win32 x64；
CPU Intel(R) Core(TM) Ultra 7 155H；revision `aa8236cf`（工作区另有 16 个未提交文件）；seed 20261012；warmup 25；ticks 200。

| 指标                                                              | 轮数 |  行数 |      p50 |      p95 |      min |      max |
| ----------------------------------------------------------------- | ---: | ----: | -------: | -------: | -------: | -------: |
| render-unit 全量重建（buildConversationTurnRenderUnits）          |  200 |  1972 |  9.04 ms | 25.86 ms |  4.62 ms | 57.40 ms |
| 导航目录 · 未缓存（buildConversationTurnNavigatorItems）          |  200 |  1972 |  3.08 ms |  6.05 ms |  2.06 ms | 13.73 ms |
| 导航目录 · 稳态缓存（createCached…Builder 复用命中）              |  200 |  1972 |  0.08 ms |  0.31 ms |  0.05 ms |  2.35 ms |
| 流式 row.delta 逻辑帧应用（24 delta/帧，applyConversationDeltas） |  200 |  1972 |  1.36 ms |  2.28 ms |  0.76 ms |  5.14 ms |
| render-unit 全量重建（buildConversationTurnRenderUnits）          | 1000 | 10012 | 25.31 ms | 37.00 ms | 20.23 ms | 53.97 ms |
| 导航目录 · 未缓存（buildConversationTurnNavigatorItems）          | 1000 | 10012 | 12.32 ms | 24.23 ms | 10.16 ms | 37.81 ms |
| 导航目录 · 稳态缓存（createCached…Builder 复用命中）              | 1000 | 10012 |  0.36 ms |  0.57 ms |  0.29 ms |  3.31 ms |
| 流式 row.delta 逻辑帧应用（24 delta/帧，applyConversationDeltas） | 1000 | 10012 |  6.74 ms |  8.81 ms |  5.12 ms | 14.31 ms |

指标含义见上文 What is measured（and what is not）；p50/p95 为最近邻秩百分位。上表只覆盖纯投影/纯函数层，Electron 启动、React 渲染、布局/绘制、worker 池与内存仍是 live-gated，不在此表内。

<!-- render-baseline:results:end -->

## Prior one-off probe (reference only)

The rendering investigation's one-off Node/tsx probe measured, per **full rebuild** of the
render units: **5.35 ms @200 turns / 15.96 ms @1000 turns**, and the navigator build at
**10.25 ms uncached vs ~1.06 ms cached**. Those numbers motivated the committed harness;
they were not produced by this script and are recorded here only as the historical
reference the table above supersedes.

## Acceptance links

- Checklist item P-01: reproducible-isolated half delivered here; native/live halves stay
  open with the runtime gate.
- P-02/P-03 thresholds must be agreed **from the table above**, not from the one-off probe.
- Fixture/pipeline contract: `packages/ui/test/v4ReplayBaseline.test.ts` (run via
  `pnpm exec vitest run packages/ui/test/v4ReplayBaseline.test.ts`).
