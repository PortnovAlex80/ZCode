# Rendering audit for the next implementation prompt

Date: 2026-10-14. Repository: `D:\Development\ZCode-Harness`, `dev`, HEAD
`f52565c834635fca4641a2771d5588b836a7f063`. Result:
[English implementation prompt](RENDERING-PERFORMANCE-WAVES-PROMPT.md).

Final review checkpoint: **`2f90b0e3393d222acfc71ed11bce170878046b21`**. Another owner
committed the previously dirty layout changes while this documentation was being
reviewed. The initial checkpoint and dirty inventory below describe the measured audit
state, not final HEAD. No product commit was made by this audit.

This task reviewed source and prepared a prompt. It did not implement the proposed
optimizations, modify product source, change checklist acceptance, commit or launch the
application. Three bounded read-only investigators examined UI lifetime/derivation,
batch/projection correctness and measurement methodology. Root checked their findings,
ran the isolated measurements/checks below and authored the two documentation files.

## Findings that materially change the supplied prompt

| Finding                                                            | Evidence in inspected source                                                                                                                                            | Consequence                                                                                                              |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Full turn derivation still follows row-window replacement          | `packages/ui/src/v4/ConversationTimeline.tsx:511–543`; `conversationTurnRenderUnits.ts:417–442`                                                                         | C remains necessary; DOM virtualization does not bound preparation work.                                                 |
| Plugin preparation has repeated linear membership search           | `packages/ui/src/plugin-ui/domain/pluginUiInstancePolicy.ts:55–67`                                                                                                      | Approximately O(rows × turns) before the turn builder, even without plugin cards. C must include this omitted path.      |
| The 24-delta stress frame becomes one ordinary coalesced operation | `scripts/perf/run-render-baseline.mjs:157–170`; `packages/shared/src/zcode-protocol-v4/coalesce.ts:124–137`; CLI `conversation-topic-publisher.ts:242`, `:860`, `:1021` | Preserve this stress case but add realistic post-coalescing mixed frames and single-op overhead.                         |
| Store work remains beyond pure apply                               | `packages/ui/src/v4/conversationProjectionStore.ts:734–770`, `:794–817`, `:1354–1383`                                                                                   | Measure row sharing and pending-command reconciliation too; a fast helper alone is insufficient evidence.                |
| Composer lifetime crosses the proposed timeline boundary           | `packages/ui/src/v4/SessionPane.tsx:5819` supplies `bottomDock`; `ConversationTimeline.tsx:381–382` documents its role                                                  | Do not unmount or key-reset the timeline/composer to suspend rendering. Freeze the control/presentation split first.     |
| Focus, telemetry and visibility are different                      | `V4WorkspaceChatArea.tsx:574`; `specGeneralChatCollapse.ts:113–124`; `SessionPane.tsx:695`, `:2504–2527`                                                                | All visible split panes need presentation; the designated hidden main source must still publish execution configuration. |
| Plugins carry both presentation and live control responsibilities  | `plugin-ui/adapters/PluginUiProviders.tsx:56–57`; `plugin-ui/CONTRACT.md`                                                                                               | Preserve resource feeds, calls, permissions and page lifecycle when presentation sleeps.                                 |
| Plugin changes can affect older turns and other presenters         | Timeline disclosure subscription `:515–527`; plugin policy `:53–104`; `pluginUiInstanceStore.ts:11–39`                                                                  | Cache invalidation must handle replacement/recent-turn policy; cleanup must not erase another presenter's state.         |
| Settings/hidden tabs keep trees mounted                            | `root/RootWorkspaceContent.tsx:110–113`, `:186`; `AnimatedSidePanePanel.tsx:1399–1434`                                                                                  | Mount continuity already exists; presentation suspension needs explicit routing through all hosts.                       |
| Resize evidence is unavailable under this task's gate              | `ConversationTimeline.tsx:1198–1266`; browser resize fixture `packages/ui/test/browser/manual-review/pending/conversation-timeline-resize.test.mjs:17–60`               | Keep synchronous measurements/flushSync; existing browser fixture launches Vite/Chromium and is not allowed here.        |

Line references describe the inspected working tree and will move. Re-find symbols before
editing. A source-confirmed cost is not automatically a demonstrated production bottleneck.

Additional invalidation requirements include phase fallback for headerless turns,
last-turn normalization, topic preparations, cross-turn highspeed footer ownership,
resource supersession and recent-three-turn plugin expansion. SessionPane also contains
plugin-reference/workflow scans and rendered-input telemetry. Hiding only the final row
DOM would leave some token-frequency work and could falsely acknowledge a visible render.

The shared `state.updated` schema excludes rows/seq/logEpoch. It replaces present state
keys, not the row window. Snapshot replacement, history hydration and branch truncation
are distinct boundaries. The existing mutable accumulator is documented for unpublished
server candidates; a client-facing immutable batch API needs its own bounded contract.

Existing lazy worker initialization, share gating, navigator cache, weak row sharing,
document-hidden motion pause and heavy-preview gating were found in current source.
Legacy `ui-render-stability.md` history remains useful context, not proof of V4 behavior.

## Fresh isolated measurements

Environment: Windows x64; Node **24.13.1**, pnpm **10.33.2**; CPU **Intel Core Ultra 7
155H**, confirmed through `node:os`. `mise.toml` pins Node 24.14.0, so the Node deviation
is explicit. Default seed
**20261012**, warmup **10**, samples **60**. No heavy agent tests/builds overlapped these
measurements; the user's running workload was neither inspected nor controlled. These
are diagnostic results under uncontrolled background load, not acceptance budgets.

Original command, executed once with no changes to its runner or report:

```powershell
node scripts/perf/run-render-baseline.mjs --turns 200,1000,2000 --ticks 60 --warmup 10 --no-write
```

| Completed turns | History rows | Actual apply window rows | Full builder p50 / p95 | Apply 24 uncoalesced text ops p50 / p95 |
| --------------: | -----------: | -----------------------: | ---------------------: | --------------------------------------: |
|             200 |         1972 |                     1975 |        6.82 / 10.87 ms |                          1.38 / 1.51 ms |
|            1000 |        10012 |                    10015 |       15.90 / 22.75 ms |                          3.75 / 7.33 ms |
|            2000 |        20055 |                    20058 |       40.78 / 56.73 ms |                        10.25 / 27.89 ms |

The original script's apply metric labels completed-history row count, although its
input has three additional running-tail rows. This report distinguishes both counts
without rewriting historical evidence. The command also measured navigator preparation:

| Completed turns | Uncached navigator p50 / p95 | Warm cached navigator p50 / p95 |
| --------------: | ---------------------------: | ------------------------------: |
|             200 |               2.64 / 4.10 ms |                  0.09 / 0.15 ms |
|            1000 |              8.26 / 12.96 ms |                  0.18 / 0.24 ms |
|            2000 |             23.23 / 28.23 ms |                  1.25 / 2.25 ms |

Separate plugin-only diagnostic, three trials, same seed/history sizes/warmup/samples:

| Completed turns |  Trial 1 p50 / p95 |  Trial 2 p50 / p95 |  Trial 3 p50 / p95 |
| --------------: | -----------------: | -----------------: | -----------------: |
|             200 |     0.90 / 1.28 ms |     0.70 / 1.15 ms |     0.70 / 1.37 ms |
|            1000 |   27.83 / 38.23 ms |   27.38 / 36.94 ms |   26.32 / 35.94 ms |
|            2000 | 142.20 / 171.45 ms | 140.92 / 167.25 ms | 136.84 / 171.65 ms |

Every fixture returned **zero plugin instances**; the expensive turn-order calculation
still ran. The same probe verified **24 raw operations → 1 coalesced operation** at
each size. This exposes a missing measurement boundary and motivates C's expanded
preparation scope. It does not measure React, Electron, actual wire distributions,
scrolling or user-visible latency. Do not add separately measured p50s as if they were
one end-to-end percentile, or compare them with older runs to claim a speedup.

No optimized candidate was implemented or timed in this audit. The user-provided
8.64 vs 2.39 ms accumulator experiment remains historical feasibility evidence only.

## Reproducing the supplementary probe

Run from the repository root in PowerShell. The script generates synthetic rows, imports
pure functions and prints results; it does not write source, read profiles or start a
server. Timing covers plugin derivation only, not fixture generation/import/equality.
Percentiles use nearest rank, matching the existing runner.

```powershell
@'
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
process.env.TSX_TSCONFIG_PATH = path.resolve('packages/ui/tsconfig.json');
const { tsImport } = await import('tsx/esm/api');
const load = (p) => tsImport(
  pathToFileURL(path.resolve(p)).href,
  pathToFileURL(path.resolve('package.json')).href,
);
const { deriveLogicalUiInstances } = await load(
  'packages/ui/src/plugin-ui/domain/pluginUiInstancePolicy.ts',
);
const { coalesceConversationDeltas } = await load(
  'packages/shared/src/zcode-protocol-v4/coalesce.ts',
);
const { generateV4ReplayRows, buildV4ReplayStreamTail } =
  await import('./scripts/perf/v4-replay-fixtures.mjs');
for (const turns of [200, 1000, 2000]) {
  const { rows } = generateV4ReplayRows({ turns, seed: 20261012 });
  const tail = buildV4ReplayStreamTail({ chunks: 48, baseRowId: rows.at(-1).rowId });
  const ops = Array.from({ length: 24 }, () => ({
    ...tail.deltas.find(d => d.op === 'row.delta'),
  }));
  const trials = [];
  for (let trial = 0; trial < 3; trial++) {
    for (let i = 0; i < 10; i++) deriveLogicalUiInstances(rows);
    const ms = [];
    for (let i = 0; i < 60; i++) {
      const start = performance.now();
      deriveLogicalUiInstances(rows);
      ms.push(performance.now() - start);
    }
    ms.sort((a, b) => a - b);
    trials.push({ p50: +ms[29].toFixed(2), p95: +ms[56].toFixed(2) });
  }
  console.log(JSON.stringify({
    node: process.version, turns, historyRows: rows.length,
    applyRows: rows.length + tail.deltas.filter(d => d.op === 'row.appended').length,
    pluginInstances: deriveLogicalUiInstances(rows).instances.length,
    originalOps: ops.length, coalescedOps: coalesceConversationDeltas(ops).length,
    trials,
  }));
}
'@ | node --input-type=module
```

The supplementary probe was run serially after the original baseline and before root
checks. It is an audit probe, not the future paired acceptance harness. The latter must
include plugin-rich data, cumulative updates, real post-coalescing frame shapes,
candidate allocation/index costs, combined preparation and multiple randomized or
alternating baseline/candidate trials. Budgets must be frozen before candidate acceptance.

## Checks actually executed

| Check                                                                                                                                                                                                                               | Result                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `node scripts/check-workspace-freshness.mjs`                                                                                                                                                                                        | Exit 0; `dev` synchronized with `origin/dev`; 40 ahead / 0 behind `origin/master`. |
| Original baseline `--no-write`                                                                                                                                                                                                      | Exit 0; report unchanged; numbers above.                                           |
| Supplementary pure plugin/coalescing probe                                                                                                                                                                                          | Exit 0; three trials at each size; numbers above.                                  |
| `pnpm exec vitest run packages/ui/test/v4ReplayBaseline.test.ts packages/shared/test/zcodeProtocolV4Coalesce.test.ts packages/shared/test/zcodeProtocolV4WorkflowRunsDelta.test.ts packages/ui/test/conversationRowSharing.test.ts` | **4 files, 85 tests passed**; 11.21 s. Baseline tests, not future A–C coverage.    |
| `pnpm typecheck`                                                                                                                                                                                                                    | Exit 0.                                                                            |
| `pnpm lint`                                                                                                                                                                                                                         | Exit 0; **63 existing warnings, 0 errors**.                                        |
| `pnpm architecture:check --changed`                                                                                                                                                                                                 | Exit 0; 0 violations. Broad UI/shared modules are unmanaged; plugin-ui is managed. |

The checks above were run before writing these documentation artifacts. Only the two
new Markdown files were subsequently authored. No production build, GUI/browser test,
renderer trace, app installation, model call or native-vs-fork comparison was performed.
Mocked React restoration and full A–C correctness suites are requirements for the future
implementation, not completed work in this audit.

Some existing source-local Vitest tests are outside the inspected root config's include
patterns (V4 share/clock gate and plugin domain tests). The new prompt explicitly requires
verified discovery and root-owned test wiring rather than treating their existence or
a zero-test run as green regression evidence.

## Working-tree and artifact provenance

Initial observed dirty work: `docs/spec-harness/WINDOW-LAYOUT.md`,
`WorkspaceSidePaneToggleButton.tsx`, `app-shell/AnimatedSidePanePanel.tsx`,
`app-shell/WorkspaceShellLayout.tsx`, `spec-document/SpecDocumentPane.tsx`,
`specDocumentPanePersistence.test.ts`, `specGeneralChatCollapse.test.ts`,
`specGeneralChatCollapse.ts`, `test/workspaceShellDividerDirection.test.ts`,
`test/workspaceShellLayoutSwap.test.ts` (UI paths relative to `packages/ui/src` except
the last two, relative to `packages/ui`). Three pre-existing untracked files:
`packages/ui/src/app-shell/WorkspaceSidePaneCaptionControls.tsx`,
`packages/ui/src/spec-document/workspacePanelRoles.ts`, and
`packages/ui/test/specDocumentEntryPoints.test.ts`.

Fingerprint recorded after the read-only audit/checks and before final document review:

```text
git diff --binary HEAD (SHA-256):
232d2709f6298cc8ce9ab0eb150490b18b9d52923f873e0ae37e403db6f7b002
scripts/perf/v4-replay-fixtures.mjs:
ec128f0ab71e7551a47f2308bb6feaaabef8e9d1e4e5cb3a910fbc70bfe19e08
scripts/perf/run-render-baseline.mjs:
8d99bc5006dda593b0d3edf6d705e832dfbd00ea30ae74a2bf2df2f7ab4bb4f6
packages/ui/src/app-shell/WorkspaceSidePaneCaptionControls.tsx:
d7315414818cdb4cf3fa8a42fc59b8477e15fd1110f38d9604d298594afb1841
packages/ui/src/spec-document/workspacePanelRoles.ts:
54e2720c5295e86713e68d44e38b589bd3707f9ea93c9c758a3409901d4cc82d
packages/ui/test/specDocumentEntryPoints.test.ts:
49a0875bd96ee5ed2bddd604d4d46ebb6ca42d25f3fa1d433475eaa93c249797
```

Hashes use raw local bytes, so line-ending conversion changes them. The diff fingerprint
does not include untracked files; their hashes are recorded separately. It is a
working-tree provenance record, not a Git commit or claim of an independently frozen
production build. The next implementation must refresh it and all source citations.

After those fingerprints were recorded, the feature owner committed Wave 7 as
`9a4527bc` (parent `f52565c8`), including layout source/tests and checklist updates.
The intermediate status observed here had only the pre-existing `WINDOW-LAYOUT.md` modification
and these two new audit/prompt documents. The new commit changes none of
`ConversationTimeline.tsx`, `SessionPane.tsx`, `conversationTurnRenderUnits.ts`,
`conversationProjectionStore.ts`, shared V4 `apply.ts`, `pluginUiInstancePolicy.ts` or
`scripts/perf/`; the benchmark/fixture hashes remain identical. Layout file hashes
changed during that owner's integration and the earlier untracked-file hashes above
are historical. This audit's tests/typecheck/lint were not rerun as acceptance of the
other owner's final commit.

The updated checklist reports nine pre-existing failures in a wider UI sweep, with its
own comparison evidence. That sweep was not run or independently verified here; the
85 passing tests above are the complete focused test evidence from this audit. Future
implementation must account for relevant baseline failures without claiming a clean
full UI suite.

Independent final read-only reviews of these documents passed the UI/lifetime/ownership
and measurement/methodology criteria after correcting checkpoint provenance and a dock
source citation. They reviewed the implementation brief, not an A–C implementation.

## Resulting wave design and limits

Wave 0: root reconciles existing work, specs, visibility/control ownership, immutable
batch API, affected-turn strategy and measurement contracts. Wave 1: one UI writer
implements A alongside a separate batch writer for B. Wave 2: the same UI writer owns
C and plugin preparation; root owns common measurement scripts. Wave 3: independent
stable-diff review, fixes, serialized paired measurements, required integration checks
and handoff. Root retains dirty shell integration and public exports unless ownership
is explicitly transferred. At most three subagents run concurrently.

The runtime gate remains closed. P items are not accepted by this audit. Actual
rendering/interaction gains, real IME/scroll restoration and any resize optimization
remain unmeasured. Feature retirement and existing document-in-center behavior remain
constraints. The future prompt completes source work and isolated evidence without
claiming production acceptance or silently installing/launching the result.

Before handoff, that owner amended the layout commit to `2f90b0e3` to include
`WINDOW-LAYOUT.md`. The tree difference from intermediate `9a4527bc` is only that
document. Final observed status contains only the two new audit/prompt documents.
