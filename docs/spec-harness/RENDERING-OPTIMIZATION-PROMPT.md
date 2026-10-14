# Agent task: bounded rendering optimizations in the ZCode fork

Prepared: 2026-10-14. Repository: `D:\Development\ZCode-Harness`.

Copy the task below into the implementation agent's session. This is an implementation
brief, not evidence that the changes or live performance acceptance are complete.

---

You are implementing a focused rendering-performance improvement in the maintained
ZCode fork. Keep the existing engine, native session execution, protocol, permissions,
project navigation, Markdown document workflow and document-in-center layout.

The objective is to reduce unnecessary work in the renderer during streaming,
long-history navigation, hidden conversation tabs and resizing. Deliver reviewed source
changes, correctness evidence and reproducible before/after measurements. Do not claim
an application-wide speedup from a pure-function benchmark.

## 1. Read the current source and constraints first

Read:

- `AGENTS.md`.
- `.agents/skills/architecture-governance/SKILL.md` before source changes; locate the
  current skill if that path has moved.
- `docs/spec-harness/IMPLEMENTATION-PLAN.md`.
- `docs/spec-harness/IMPLEMENTATION-CHECKLIST.md`, especially P-01 through P-04,
  U-01, D-05 and the current runtime gate.
- `docs/spec-harness/AGENT-TEAM-PROMPT.md` for delegation conventions.
- `docs/spec-harness/RENDERING-BASELINE.md`.
- `docs/performance/conversation-row-structural-sharing.md` and
  `docs/performance/ui-render-stability.md`.

Run the workspace freshness check and inspect `git status` before assigning writers.
The working tree may contain another agent's feature-retirement changes. Preserve them.
Current user decisions retire separate OS-window transfer and Office/AutoCAD integrations;
do not restore those features as part of this task. Some older documents still describe
them: current source and explicit retirement decisions take precedence.

Update the relevant behavior/performance specification before changing behavior. Record
work and evidence under the existing P checklist items, with bounded subitems if useful.
Keep live acceptance open while its gate is closed.

## 2. Runtime and scope boundaries

- Do not launch, stop, restart, attach to or instrument the user's ZCODE application.
- Do not read or modify the live profile, credentials, sessions or projects.
- Do not send model prompts or run paid requests.
- Do not run development servers or trigger HMR in the user's active application. If an
  active development app consumes the files you need to edit, prepare the work in an
  isolated checkout rather than editing its live source.
- Synthetic fixtures and isolated Node/unit tests are allowed. GUI tests are allowed
  only if their environment is genuinely isolated and permitted by the runtime gate.
  Never weaken the gate to obtain a trace.
- Source/build work does not authorize installing or launching the result.
- Do not rewrite the renderer, replace React/Electron, redesign the transport, add a
  second accepted-command queue, change provider/auth behavior or increase concurrency.
- Do not optimize by dropping messages, truncating history, suppressing permissions,
  reducing correctness checks or disabling expensive features indiscriminately.
- Preserve existing desktop-continuous and web-remote-replayable semantics.

## 3. Verified starting points, not assumptions about the live bottleneck

Reconfirm these against current source; line numbers can move:

1. `packages/ui/src/v4/ConversationTimeline.tsx` builds complete render units in a
   `useMemo` dependent on `rows`, session phase, time and plugin UI derivation. A text
   delta replaces the row window, so loaded completed history can be reprocessed.
2. `packages/ui/src/v4/conversationTurnRenderUnits.ts` groups and materializes all rows.
   DOM virtualization does not eliminate these full-window computations.
3. `packages/ui/src/v4/conversationProjectionStore.ts` calls
   `applyConversationDeltas` for each logical delta frame.
4. `packages/shared/src/zcode-protocol-v4/apply.ts` applies each delta separately;
   row updates search and copy the window repeatedly. Its mutable candidate API is
   explicitly scoped to unpublished server candidates: it is not automatically a
   supported drop-in client optimization.
5. `packages/ui/src/app-shell/AnimatedSidePanePanel.tsx` retains conversation tabs via
   `forceMount`. `SessionPane` uses `useConversationProjection`; `telemetryVisible`
   currently affects foreground telemetry, not the live subscription.
6. `ConversationTimeline.tsx` synchronously measures mounted rows and uses `flushSync`
   during width changes to preserve scrolling. Treat this as a sensitive correctness
   boundary, not an obvious call to delete.

Existing improvements already include lazy highlight/diff workers, share-mode computation
gating, navigator caching, row structural sharing, hidden-document motion pause and
heavy-preview visibility gating. Verify their presence and preserve them. Older legacy
background-event coalescing documentation does not prove that every current V4
conversation presentation is cheap while hidden.

Diagnostic measurements on 2026-10-14, Node 24.13.1, synthetic seed 20261012:

| Loaded turns | Full render-unit rebuild p50 | Apply 24 text deltas p50 |
| --- | ---: | ---: |
| 200 | 4.03 ms | 0.60 ms |
| 1000 | 18.08 ms | 4.86 ms |
| 2000 | 40.21 ms | 12.07 ms |

These used `run-render-baseline.mjs --ticks 60 --warmup 10 --no-write`. The 2000-turn
full-rebuild p95 was 48.24 ms. A separate paired candidate experiment, including candidate
array copy and index construction, measured 8.64 ms versus 2.39 ms at 2000 turns for
24 deltas; outputs were deeply equal and the input was unchanged. Different runs had
different scheduling noise: use the paired comparison only. This is feasibility evidence,
not production acceptance or an instruction to reuse the server API unconditionally.

The initial wire window is bounded. Large loaded-window costs apply after history
hydration; they do not describe every newly opened conversation.

## 4. Implement three bounded improvements

### A. Suspend heavy presentation of hidden conversations

Introduce an explicit presentation-visibility boundary, distinct from focus and telemetry.
Multiple split panes can all be visible while only one is focused.

Keep native execution, projection sequence handling, lifecycle, current execution config,
permission/question delivery, terminal notifications and required background summaries
correct. Suppress unnecessary Markdown/render-unit derivation, visible-row rendering,
presentation timers and geometry measurements for genuinely hidden conversation content.

Cover inactive side tabs, a main chat hidden by document expansion, settings covering the
workspace and document-level visibility. Preserve state needed to resume immediately:
drafts, IME composition, attachments, selected session, scroll memory, find state and
document changes. Preserve the designated hidden main pane's execution-config source.

Do not simply freeze the entire `SessionPane` or unsubscribe all hidden sessions. Split
control/lifecycle responsibilities from heavy presentation where needed. On reveal,
render the latest valid state and restore geometry/scroll before declaring it interactive.

### B. Apply logical-frame row changes efficiently

Design a client-supported immutable batch path: avoid repeated full-window copies and
linear searches when many row changes arrive in one frame. One private candidate and a
frame-local index are possible, but choose the narrowest implementation that preserves
the contract and fits existing public module boundaries.

Preserve delta order and every operation's semantics: append, upsert, text paths,
missing-row no-op, removal, branch truncation, state replacement, workflow updates and
live-only plugin events. Advance sequence/epoch/recovery state exactly as before.
Published snapshots and their nested rows must never be mutated by later updates.

Use the existing pure reference implementation as the correctness oracle. Do not change
the oracle and optimized path together to make tests agree. Do not introduce an index
that survives past a branch/window replacement without correct rebuilding/invalidation.

### C. Reuse unchanged completed-turn derivations

Avoid rebuilding every completed turn when only the current streaming row changes.
Use bounded per-session derivation/cache state and stable references for unchanged units.
Identify affected turns explicitly, including late tool results or updates to older turns.

Preserve all relevant invalidation inputs: history prepend, rewind/removal, session and
epoch changes, phase transitions, grouping/settings, locale where applicable, plugin
disclosures/resources and time-dependent footers. Preserve the existing visible-running
clock and highspeed expiry behavior. Clear/prune cache entries when their scope disappears.

Keep the full pure builder available as an independent equivalence reference. Prefer
isolating pure content derivation from clock/config derivation over retaining stale units.
Measure plugin derivation and other full-row scans too; do not just move the same cost
into a new helper.

## 5. Resize optimization is conditional follow-up

Do not start by removing `flushSync`, changing all animations or disabling virtualizer
measurement. First measure the remaining resize path in an allowed isolated renderer.
If evidence justifies a small improvement, preserve following-at-bottom, manual reading
position, prepend anchors, width-dependent heights, terminal-turn transitions and cached
scroll restoration in both layout orientations.

If a representative renderer trace is unavailable, document the candidate and leave this
follow-up unimplemented. Complete A-C without inventing a GPU/FPS diagnosis.

## 6. Team organization and write ownership

The root agent owns scope, specifications, checklist, integration and final acceptance.
Use bounded implementation agents and an independent read-only reviewer. Keep at most
three subagents active and assign exactly one writer per file.

A workable split is:

- UI owner: A and C, coordinating all changes to `SessionPane`, `ConversationTimeline`,
  turn derivation and presentation visibility; do not give these files to two writers.
- Batch owner: B, with explicitly assigned projection/shared-apply paths and tests.
- Independent reviewer: stable diffs, snapshot immutability, hidden-control behavior,
  invalidation cases and benchmark methodology; no edits or commits.

Root integrates shared public exports and architecture changes. Respect any stronger
repository rules for agent spawning. Workers return concise evidence and do not commit.
Review stable source, repair identified issues, then recheck affected evidence.

## 7. Correctness and measurement checklist

- [ ] Source and specification baseline established; exclusive ownership recorded.
- [ ] Heavy hidden presentation demonstrably stops doing token-frequency work while
  execution, control events and required notifications continue.
- [ ] Hidden-to-visible restoration, split-pane focus, document expand/return and
  document-in-center swap preserve drafts, inputs and scroll.
- [ ] Batch path matches the untouched reference on representative and randomized
  ordered deltas, including repeated updates, missing IDs, truncation and state changes.
- [ ] Previously published snapshots remain unchanged after subsequent frames; test
  retained old references and frozen inputs, not only final JSON equality.
- [ ] Cached turn derivation matches the full builder after all invalidation cases.
  Unchanged completed units retain identity during text-only streaming updates.
- [ ] Cache lifetime is bounded by session/window/branch ownership; demonstrate pruning.
- [ ] Protocol gap, duplicate, recovery, session replacement and desktop/web delivery
  regression coverage remains green where touched.
- [ ] Existing clock/expiry, navigator, sharing, preview and scroll regressions pass.
- [ ] Paired baseline/candidate measurements use identical Node version, fixtures,
  loaded history, warmup, samples, settings and comparable machine load.
- [ ] Report p50/p95, loaded row counts and before/after; include 200/1000/2000 turns,
  many deltas in one frame and small-window overhead. Run several paired trials rather
  than accepting the best run. Preserve fixture sizes and contents.
- [ ] Pure-function results, isolated React results and production GUI results are
  reported separately. When available, measure commits, long tasks, interaction
  latency, CPU and memory with one and several visible/hidden conversations.
- [ ] No claimed global speedup or live acceptance without corresponding measurement.
- [ ] Run focused tests, then required `pnpm typecheck`, `pnpm lint` and the changed
  architecture checks. Use actual package commands and report pre-existing failures.
- [ ] Root reviews the final diff and keeps unexecuted live acceptance items open.

Reproduce the existing pure baseline without editing its report:

```powershell
node scripts/perf/run-render-baseline.mjs --turns 200,1000,2000 --ticks 60 --warmup 10 --no-write
```

Add benchmark coverage for the optimized paths; merely rerunning the reference-only
baseline does not demonstrate a speedup. Set acceptance budgets from repeated paired
measurements before judging the candidate. Avoid flaky absolute wall-clock assertions
in ordinary unit tests; use equivalence, work-count bounds and complexity evidence.

## 8. Final handoff

Deliver the source changes and a concise report containing:

1. Changed responsibilities and paths.
2. Before/after results and their exact measurement boundary.
3. Correctness and regression checks actually executed.
4. Remaining risks, unchanged bottlenecks and unexecuted live gates.
5. Updated P checklist evidence and the production validation procedure for later use.

Complete the authorized implementation and isolated checks. Keep the running application
untouched. Production packaging/install/launch and native-vs-fork live profiling require
their own authorized delivery step; do not execute them silently at the end of this task.
