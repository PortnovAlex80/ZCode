# Rendering performance: bounded implementation waves

Prepared 2026-10-14 from `dev` at `f52565c834635fca4641a2771d5588b836a7f063`
and the existing, uncommitted layout changes. This is an implementation brief;
authoring it did not implement A–C or release the runtime gate. Supporting source
findings and fresh diagnostic measurements: [audit](RENDERING-PERFORMANCE-AUDIT-2026-10-14.md).

Final review checkpoint: another owner integrated the layout work as `2f90b0e3` during
this audit. The measured V4/plugin/apply functions and benchmark files did not change
in that commit. `WINDOW-LAYOUT.md` was included in that owner's amended commit. Re-read the actual HEAD/status;
the initial dirty inventory below is historical, not the final working-tree state.

User refinement: performance implementation MUST use a separate worktree while the
user continues window/layout development in the main checkout. Prepare and validate
their eventual combination in the performance worktree; do not interfere with the
user's working directory. The isolation and integration rules below are mandatory.
The root uses an integration worktree and separate UI/batch worker worktrees. Updating
the common `dev` branch requires a NEW explicit user instruction AFTER the ready report.

Copy the text below into the root implementation agent's task.

---

You are the root implementation agent for a focused rendering-performance improvement
in the maintained ZCode fork. The user's active checkout is
`D:\Development\ZCode-Harness`; your implementation checkout MUST be a separate Git
worktree, preferably `D:\Development\ZCode-Harness-render-perf`.

Complete reviewed source changes and isolated correctness/performance evidence for
A–C below. Preserve the existing engine, native session execution, protocol, permissions,
project navigation, Markdown workflow and document-in-center layout. Do not substitute
a new renderer, transport, model client or accepted-command queue. Do not increase
runtime concurrency. Do not obtain performance by losing messages, truncating history,
suppressing permissions, weakening checks or indiscriminately disabling features.

Keep the running application untouched. Pure-function improvements are not an
application-wide speedup. Complete the authorized source work even while live acceptance
remains open; distinguish implementation completion from production acceptance.

### Startup acknowledgement

Read this complete file directly from
`D:\Development\ZCode-Harness\docs\spec-harness\RENDERING-PERFORMANCE-WAVES-PROMPT.md`
and its linked audit. Do not rely only on a launcher's summary or an old chat copy.
After reading, state the absolute path and the source revision you inspected. After
actually creating/verifying worktrees and spawning workers, report the role-to-agent,
absolute-worktree and exclusive-path assignment table. Never claim delegation or
worktree creation before those actions succeed. Then continue autonomously through
the authorized waves without waiting for routine implementation confirmations.

## 1. Source, rules and baseline before any writer starts

Read the actual checkout, not only this prompt. The inspected revision is a reference,
not a command to reset to it. Read:

- Root and applicable nested `AGENTS.md` files, including `packages/ui/AGENTS.md`.
- `.agents/skills/architecture-governance/SKILL.md`; locate it if moved.
- `docs/spec-harness/IMPLEMENTATION-PLAN.md` and `IMPLEMENTATION-CHECKLIST.md`, especially
  P-01–P-04, U-01, D-05, current layout requirements and the runtime gate.
- `docs/spec-harness/AGENT-TEAM-PROMPT.md` for delegation conventions only where current.
- `docs/spec-harness/RENDERING-BASELINE.md` and `WINDOW-LAYOUT.md`.
- `docs/performance/conversation-row-structural-sharing.md` and `ui-render-stability.md`.
- `DESIGN.md` before UI changes; relevant V4 and plugin contracts before changing them.

Run `node scripts/check-workspace-freshness.mjs`, inspect HEAD, branch, status and diff,
then run `pnpm architecture:check --changed`. Verify actual commands/toolchain from
`package.json`, `pnpm-workspace.yaml`, `mise.toml` and test configuration.

The October 14 audit found 10 modified tracked files and 3 untracked files, concentrated
in shell layout, caption controls and document behavior. They belong to other work.
Record their paths and content fingerprints before changes. Do not reset, stash, delete,
format wholesale or overwrite them. Reconcile active file ownership before assigning
writers; if ownership is unresolved, progress on disjoint paths first.

At final review that layout work was integrated by its owner as `2f90b0e3`; preserve
the integrated changes and any remaining dirty work. Its checklist records U-04/U-05
implementation with live acceptance pending, plus nine reported pre-existing failures
in six wider UI suites. Read that evidence and reproduce relevant failures before
attributing them to this task; this audit did not run or independently verify that sweep.

### Mandatory worktree isolation and concurrent window development

The main checkout belongs to the user's window/layout work. Treat it as READ-ONLY for
this implementation, including its source, specs, checklist, index, dependencies and
build outputs. Never switch its branch, stash/reset/clean it, stage or commit its files,
resolve conflicts there, or move its checked-out branch ref behind its owner's back.
All performance edits, root integration edits, tests, builds, benchmark artifacts and
checklist updates belong to the isolated performance worktrees. This includes files
with the same repository-relative names as files the window owner is editing.

Root creates one detached INTEGRATION worktree from an explicitly recorded COMMITTED baseline.
For example, after confirming the destination does not already exist:

```powershell
$sourceCheckout = 'D:\Development\ZCode-Harness'
$perfCheckout = 'D:\Development\ZCode-Harness-render-perf'
if (Test-Path -LiteralPath $perfCheckout) { throw 'Inspect existing worktree; do not overwrite it.' }
$perfBase = git -C $sourceCheckout rev-parse HEAD
if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve committed baseline.' }
git -C $sourceCheckout worktree add --detach $perfCheckout $perfBase
if ($LASTEXITCODE -ne 0) { throw 'Worktree creation failed.' }
```

Record the absolute worktree path, baseline SHA and `git worktree list --porcelain`.
If this task's prompt/audit documents are still uncommitted, copy only those explicitly
identified task artifacts into the performance worktree and record their hashes; do not
use that as permission to copy unrelated source edits. Read all repository rules/specs
from the committed worktree baseline and note any newer provisional requirements.
Every worker must verify its cwd, `git rev-parse --show-toplevel` and HEAD before writing.
All implementation commands in this prompt run from the assigned PERFORMANCE worktree
after creation. Root may commit reviewed performance changes there to preserve integration
checkpoints; workers do not commit/push. Keep the detached worktree and recorded commit
SHAs until integration is acknowledged. Do not create permanent worker branches or
force-push/rewrite shared history. Worktrees share Git metadata: do not change repository
configuration, hooks, refs or remotes in ways that affect the other owner.

Use this worktree topology, with collision-free alternatives if these paths already
belong to another task:

| Role                 | Worktree                                                               | Responsibility                                                    |
| -------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Root                 | `D:\Development\ZCode-Harness-render-perf`                             | Specs, contracts, common harness, integration and final candidate |
| UI writer            | `D:\Development\ZCode-Harness-render-perf-ui`                          | A, then C, in the SAME UI worktree                                |
| Batch writer         | `D:\Development\ZCode-Harness-render-perf-batch`                       | B and its exclusively assigned tests                              |
| Independent reviewer | Read-only access to stable worker checkpoints and integration worktree | No writable worktree required                                     |

Create worker worktrees from root's recorded Wave 0 contract checkpoint. They are
detached worktrees of the SAME fork, not new repositories or checkouts of `dev`.
Keep the three-subagent limit and one logical writer per assigned path across the
performance team; separate directories do not authorize duplicate competing edits.
Root remains the only committer: pause a worker at handoff, inspect its exact diff,
obtain independent review, then commit only assigned files in that worker's worktree.
Root merges those reviewed commit SHAs into the integration worktree. Do not stage
files while their worker is still writing or commit unrelated files with `git add .`.
Resolve cross-worker conflicts only in the integration worktree. Synchronize necessary
accepted integration checkpoints back to paused worker worktrees before dependent work
resumes; never overwrite uncommitted worker changes. Root's canonical checklist lives
in the integration worktree, with explicit handoffs and recorded worker commit SHAs.

Use worktree-local dependency links, generated files, test caches and build directories.
A normal pnpm content-addressed package store may be shared; writable `node_modules`,
outputs and profile directories must not be symlinked/junctioned back to the active
checkout. Use pinned tools and frozen-lockfile installation if dependencies are needed.
The separate worktree does NOT lift the runtime, GUI, development-server or paid-call gates.

Do not copy the other owner's evolving uncommitted files into the performance branch.
They may be read as provisional context, but are not a reproducible baseline or accepted
contract. Integrate committed window checkpoints. If an essential interface is still
uncommitted, finish disjoint B/C work and prepare the A adapter against the latest
committed contract; keep its final integration check pending. Do not block unrelated
performance work or attempt to finish the window feature yourself.

Maintain a small overlap register in the PERFORMANCE worktree's checklist: path/symbol,
performance owner, known window change, assumed contract and last integrated window SHA.
Reserve overlapping shell/layout files to root within this team. The window owner may
independently edit its own copies; exclusive file ownership applies within each worktree,
with root responsible for resolving semantic overlap between their commits later.

### Prepare the combined result in the performance worktree

At a stable checkpoint, root records reviewed performance commits, identifies the
latest committed window/layout target SHA and brings that checkpoint into the performance
worktree through a normal Git merge. Do not merge the user's live dirty directory or
silently pull a moving branch into an in-progress worker edit. Pause affected writers,
start integration from a clean committed performance checkpoint and resolve all conflicts
in the PERFORMANCE worktree. Do not use blanket `ours`/`theirs` resolutions.

Preserve both the new window behavior and the performance boundaries. If window work
adds another document/portal/PiP host, adapt visibility and lifecycle routing to the
actual mounted host/document, not only the original main document. Hiding the main
document must not suspend a conversation still visibly hosted elsewhere. Preserve one
control owner, composer state, return/close behavior and current role-based restore
affordances without rebuilding the window feature or restoring retired machinery.

Review the combined diff against that exact target SHA. Re-run affected window/layout,
visibility, composer, scroll and protocol regressions plus required integration checks.
Invalidate and repeat affected performance measurements if integration changes their
code or workload. Record the target SHA, resulting candidate SHA, resolved overlaps,
commands/results and remaining live gates. No textual conflict does not mean no semantic
conflict: test the combined behavior even when Git merges automatically.

Final update of the common `dev` branch requires a NEW explicit user command AFTER
the completion report. This task authorizes worktree-local commits and integration,
NOT merging/cherry-picking into `dev` or `master`, moving their refs, or pushing to them,
even if the main checkout happens to become clean. Hand over the reviewed candidate SHA;
a fast-forward
is possible if its verified target remains current and is an ancestor of the candidate.
Do not execute that update in the user's busy checkout. If the target advances, integrate
the new checkpoint and revalidate the affected combination in the performance worktree
first. Do not delete the worktree or discard commits before successful handoff. Preparing
this merge-ready result is part of the task; disturbing active window work is not.
Finish the turn with the ready report and wait for that separate merge instruction.
Do not interpret silence, completed tests or this implementation prompt as permission
to update the common branch. After a later merge instruction, recheck target HEAD,
active ownership and working-tree cleanliness; never stash or discard the user's work
to make the merge possible. Authorization to merge still does not authorize launch,
installation, profile changes or paid calls.

Current explicit decisions retire the old Main-owned separate-window transfer stack
and Office/AutoCAD integrations. Older plans, checked historical evidence, removed
paths and old acceptance scenarios do not authorize restoring them. Preserve in-app
Markdown and layout work. Do not implement pending PiP, file-picker, packaging or other
UX features as part of this performance task. If another owner lands them, refresh the
visibility integration contract against that source without taking over their work.

Root updates the relevant behavior/performance specification BEFORE behavior changes.
Use the existing P items, with bounded P-03.A/B/C subitems if useful, and corresponding
P-01/P-04 evidence. Keep P-02's existing worker improvements and live limits accurate.
Record U-01/D-05 regression obligations, preserving historical user acceptance while
leaving acceptance of changed behavior open. Do not rewrite all historical documents
or let their obsolete release sequence broaden this assignment.

## 2. Hard runtime boundary

- Do not launch, stop, restart, attach to or instrument the user's ZCODE application.
- Do not read or modify its live profile, credentials, sessions or projects.
- Do not send model prompts or run paid requests.
- Do not run development servers, trigger HMR, install, launch or publish the result.
- Synthetic fixtures, isolated Node/unit tests and build-only checks are allowed.
- GUI/browser tests require a genuinely isolated environment AND permission under the
  current runtime gate. Do not weaken the gate to obtain a trace.
- Preserve `desktop-continuous` and `web-remote-replayable` delivery semantics.

The existing browser resize fixture starts Vite and Chromium despite `hmr:false`.
It is not allowed by this prompt. A mocked DOM/virtualizer test can prove lifecycle and
work counts; it cannot establish real geometry, paint, FPS or production interaction
latency. Packaging/install/launch and native-vs-fork live profiling need their own
authorized delivery step and must not happen silently at the end.

## 3. Reconfirm these source findings

1. `packages/ui/src/v4/ConversationTimeline.tsx` derives plugin instances from all rows,
   then rebuilds render units when rows, phase, expiry time, plugin resolver/disclosure
   or topic preparations change. `conversationTurnRenderUnits.ts` groups/materializes
   all loaded rows. DOM virtualization does not avoid this preparation.
2. `packages/ui/src/plugin-ui/domain/pluginUiInstancePolicy.ts` constructs turn order
   using `turnOrder.includes(row.turnId)` for every row. This is approximately
   O(loaded rows × distinct turns), even with zero plugin cards. The original baseline
   does not measure it. Include this path in C; caching only the turn builder is
   insufficient. Respect the managed module and its domain constraints; inspect policy
   rather than blindly inserting a Map/Set or weakening architecture rules.
3. `conversationProjectionStore.ts` applies a logical frame via
   `applyConversationDeltas`. `packages/shared/src/zcode-protocol-v4/apply.ts` searches
   and copies the window per update. Its mutable accumulator is explicitly for
   unpublished server candidates, not an automatically supported client API.
4. `shareDeltaRows` still scans the loaded window after apply. Pending optimistic and
   accepted-input reconciliation can scan it too. Measure the complete store boundary
   as well as the isolated new helper; preserve row sharing and control correctness.
5. `AnimatedSidePanePanel.tsx` force-mounts conversation tabs. Settings retain the
   workspace as an inert/transparent tree. Collapsed main chat is retained. Focus and
   telemetry visibility are not a presentation-suspension contract.
6. `SessionPane.tsx` owns projection subscription, command/lifecycle/config behavior,
   and passes its composer as `ConversationTimeline.bottomDock`. Unmounting the whole
   timeline can therefore unmount the composer. Plugin session providers own live
   resource feeds and commands and also need to survive presentation suspension.
7. Width-change handling synchronously measures mounted rows and uses `flushSync` to
   preserve scroll behavior. This is a correctness boundary, not a first optimization.

Verify and preserve existing lazy highlight/diff workers, share-mode gating, navigator
caching, row structural sharing, hidden-document motion pause and preview visibility
gating. Historical legacy ChatView/event-coalescing work does not prove V4 hidden panes
are cheap. Initial wire history is bounded; large loaded windows occur after hydration.

The existing 24-delta benchmark repeats adjacent text appends to ONE row/path. Production
`coalesceConversationDeltas` merges this shape to ONE operation before ordinary delivery.
Keep it as an uncoalesced synthetic stress case, but do not present its speedup as the
benefit of a typical wire frame. Include actual post-coalescing mixed frames.

## 4. Team, ownership and wave gates

Use at most THREE concurrent subagents plus root. Respect stronger repository delegation
rules. Exactly one writer owns each file, including tests and root integration files.
Implementation workers never commit or push. Reviewer is independent and read-only.
Do not launch a separate A writer and C writer against the same UI files.

Root owns scope, specs, checklist, public contracts/exports, architecture policy,
test-runner configuration, benchmark methodology, integration and final acceptance.
Record exact paths, including proposed new files, in the worktree-local checklist before delegation.
The following is the assignment model; resolve exact paths from the current checkout.

| Owner        | Exclusive responsibility                                  | Typical paths                                                                                                                                                                                                                                 |
| ------------ | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI writer    | A, then C; presentation lifetime and derivation internals | `packages/ui/src/v4/SessionPane.tsx`, `ConversationTimeline.tsx`, `WorkbenchPane.tsx`, `V4WorkspaceChatArea.tsx`, new cache/helpers; conversation side-hosts; `SpecDiscussionPane.tsx`; assigned UI tests; plugin policy/cache internals in C |
| Batch writer | B; immutable frame application and projection integration | New helper beside shared V4 apply; `packages/ui/src/v4/conversationProjectionStore.ts`; explicitly named shared/UI batch and projection tests                                                                                                 |
| Root         | Cross-cutting contracts and integration                   | Relevant specs/checklist; shared V4 barrel; plugin public contracts/exports if needed; root test configuration; benchmark scripts/reports; shell visibility wiring in currently dirty layout files                                            |
| Reviewer     | Stable source and evidence review                         | No writable paths, no commits                                                                                                                                                                                                                 |

Root reserves `WorkspaceShellLayout.tsx`, `AnimatedSidePanePanel.tsx`,
`RootWorkspaceContent.tsx` and overlapping visibility/layout helpers IN THE PERFORMANCE
WORKTREE. This does not claim ownership of the user's copies. UI writer proposes exact
integration changes to root. Root may
explicitly transfer a file to the UI writer, but never edit it concurrently. The same
rule applies to any side-host or plugin file that needs a shared contract change.

### Wave 0 — freeze contracts, oracles and measurement plan

Root creates/verifies the isolated worktree, records its committed baseline and overlap
register, and completes spec reconciliation and ownership before writers start.
Freshness checks on detached HEAD may report no tracking branch; record this intentional
condition and compare the recorded baseline with the current committed integration target.
Read-only investigations may run in parallel. Freeze:

- Control owner versus presentation owner; visibility inputs; reveal readiness;
  composer/IME lifetime; designated hidden main-pane execution-config source.
- A client-safe immutable batch interface and module export. Keep sequence/recovery,
  publication and live-event dispatch in the existing store.
- C's affected-turn detection: either a measured bounded identity scan or an explicit
  root-owned change-hint contract. Do not let B and C invent incompatible private
  indices. Hints, if chosen, describe applied local projection changes, including
  snapshot/history/branch boundaries; they are not another wire protocol or event queue.
- Cache ownership including workspace/session/epoch and independent pane presentation
  configuration; disposal/pruning and handling of multiple presenters of one session.
- Untouched reference implementations and fixture hashes; test discovery; paired
  benchmark cases, noise characterization and small-window overhead budgets.

Show owners and event order in the spec, for example:

```text
native execution -> existing transport/sequence gate -> immutable projection publication
                                                  -> control/lifecycle/permissions
                                                  -> visible presentation derivation
hidden: control remains live; presentation has bounded transition work
reveal: current valid projection -> derive -> restore geometry/scroll -> interactive
desktop continuous and web replayable keep the same established owner/sequence rules
```

Exit: specs and interfaces are reviewable, writers have disjoint file lists, the existing
working tree is protected, and the reviewer has accepted the evidence plan. No runtime
authorization is implied by completing this wave.

### Wave 1 — A and B in parallel

UI writer implements A; batch writer implements B. Root integrates frozen public exports
and shell wiring on its reserved paths. Reviewer reviews each completed stable slice;
an in-progress diff is not accepted evidence. Fixes return to that slice's writer.

Exit: focused A/B behavior/equivalence/immutability checks pass, both stable slices have
independent review, public contracts are integrated, and changed regressions pass.

### Wave 2 — C after A's boundary is stable

The SAME UI writer implements C, including the omitted plugin preparation cost. Root
owns the common benchmark harness. The finished batch worker may assist with read-only
measurement analysis or newly assigned disjoint tests, but receives no overlapping
benchmark, UI or plugin paths. Reviewer evaluates C's stable source and all invalidation
cases, then reviews A+B+C together. All agents can read cross-module contracts.

Exit: full-builder equivalence, unit identity, bounded cache lifetime, plugin equivalence
and integration regressions pass. Report remaining scans and their complexity honestly.

### Wave 3 — integrate, repair, measure and hand off

Root integrates the latest stable committed window checkpoint in the performance
worktree under the integration rules above, then freezes the combined source/diff
fingerprint. Reviewer checks final source and
measurement implementation. Writers repair findings within their assigned paths;
recheck affected evidence. Stop concurrent heavy tests/builds during paired benchmarks.
Run required integration checks, update checklist evidence and provide the final report.
If a repair changes measured behavior, invalidate affected measurements and rerun them.

Resize is a conditional follow-up, not a prerequisite for completing A–C. Do not create
idle agents merely to keep all slots occupied. End with accurately open live gates.

## 5. A — suspend heavy presentation of genuinely hidden conversations

Introduce explicit presentation visibility, separate from focus and foreground telemetry.
Multiple split panes can be visible while only one is focused. Derive visibility from
the current shell/host state and document visibility, not from which side a pane occupies.

Cover inactive conversation tabs, collapsed/expanded-document-hidden main chat, settings
cover, document-level visibility, and the existing Markdown discussion host. Audit
subagent, selection-side-chat and workflow-actor side hosts as well as split workbench
leaves. Preserve the current role-based panel visibility and restore affordances in both
chat-center and document-center arrangements.

Keep native execution, projection sequence/recovery, lifecycle, current execution
configuration, permissions/questions, terminal notifications, required background
summaries, and plugin live feeds/command registration working. Preserve the designated
hidden main pane as an execution-config source. Do not freeze the whole SessionPane,
unsubscribe all hidden sessions or cancel accepted work on hide.

Split control/lifecycle from expensive presentation where needed. Audit derivations
inside SessionPane, not just its child DOM: plugin reference discovery, workflow maps,
sharing, telemetry and summary consumers must be classified before gating. A commit of
a hidden tree must not falsely mark a user-input bubble as visibly rendered.

After bounded hide-transition work, suppress token-frequency Markdown/render-unit/plugin
presentation derivation, row rendering, presentation clocks, geometry reads and purely
presentation-driven history hydration. Keep required protocol/control work live. Do not
drop resource events or stop plugin calls just because their card is hidden.

Preserve drafts, native input nodes and IME composition, attachments, selected session,
find state, scroll memory, document changes and per-pane state. In particular,
`bottomDock` contains stateful composer/control UI: do not achieve suspension by simply
unmounting it, changing its key, moving it through a remounting branch or replacing all
of SessionPane with a placeholder. Account for plugin page/anchor cleanup contracts.

On reveal use the latest VALID projection, including updates received while hidden.
Preserve recovery/error semantics when no new valid state is available. Restore actual
width-dependent geometry and scroll anchors before declaring the surface interactive;
avoid a flash of stale interactive content. Do not invent a delay timer as readiness.

Prove with isolated React/work counters that long hidden token replays produce bounded
heavy work after the hide transition. Separately prove ongoing control/permission/event
delivery and config ownership. Test two visible panes with focus switching, all listed
hide reasons, background completion, hide/reveal during stream, document swap/return,
draft/caret/attachment/find retention and reveal after session/epoch changes. Real IME
and pixel-accurate geometry remain live acceptance if only simulated tests are allowed.

## 6. B — efficient immutable logical-frame application

Design a public CLIENT-SUPPORTED pure batch helper. A frame-local private candidate and
row index are possible; no mutable candidate escapes or survives publication. Choose
the narrowest implementation that preserves semantics and avoids repeated searches and
copies. Include empty, control-only and single-update frames in the design; eager full
copy/index construction must not erase benefits for normal small frames.

Keep `applyConversationDelta` and `applyConversationDeltas` unchanged as correctness
oracles. Do not change the oracle and optimized implementation together. Shared imports
use the existing public `@zcode/shared/zcode-protocol-v4` boundary; root owns new exports.
Do not silently generalize the server accumulator's documented lifetime contract.

Preserve every supported ordered operation:

- Append, count and initial row anchor; upsert of loaded rows; missing-ID no-op.
- Text append to assistant/reasoning `text`, tool `inputText`, existing `output.text`
  and subagent `summaryText`; wrong-kind/missing-path behavior.
- Removal/truncation and whole-active-branch reset, including partially loaded windows.
- `state.updated` replaces PRESENT state keys wholesale. Its schema excludes rows,
  seq and logEpoch; it is not itself a row-window replacement operation.
- Workflow updates/removals and interleaving with complete workflow state replacement.
- All live-only plugin events: snapshot no-ops, but ordered delivery remains mandatory.

Keep sequence, epoch, duplicate/gap filtering, recovery, model-transition observation,
directory invalidation and publication order exactly as before. Preserve row-pool
structural sharing and its weak lifetime across store keep-warm eviction. Any metadata
used for sharing or C must describe final surviving rows correctly after removals and
repeated updates. Do not reintroduce a full scan PER changed row in post-processing.

No previously published snapshot or nested row/output/workflow value may be mutated by
later frames. Test deeply frozen nonempty inputs and deltas, retained references across
several publications, unchanged-row identity, input immutability and output equivalence.
Use representative and seeded randomized VALID ordered frames, including append/delta/
upsert chains, repeated updates, absent IDs, truncate/append, state/workflow interleavings,
snapshot replacement, history prepend and recovery. Validate index rebuilding/invalidation
where required; no stale index may cross a changed branch/window/session scope.

Measure helper-only AND full store apply/sharing/reconciliation boundaries. Retain the
24-op uncoalesced stress test, and add 1-op, control-only, empty and realistic mixed
POST-COALESCING frames. Do not alter server coalescing or transport for this task.

## 7. C — reuse completed-turn content and remove redundant preparation

Use bounded per-session/window/epoch derivation state with stable references for unchanged
completed units. Identify affected turns, including older turns receiving late results.
Keep `buildConversationTurnRenderUnits` available as an independent full reference.
If factoring shared helpers would compromise its independence, retain a frozen baseline
reference in test support before refactoring and have the reviewer verify its provenance.
Apply the same independent-oracle discipline to plugin policy changes.

Do not settle for React.memo around a full-window builder or a cache rebuilt from scratch
on every token. Separate pure turn content from positional, phase, plugin and clock
overlays. Preserve final behavior AND referential stability where output is unchanged.

Explicit invalidations include:

- History prepend, removals/rewind, window/snapshot replacement, session/epoch changes.
- Late tool/subagent results; header, actions and row-kind changes in older turns.
- Headerless-turn phase fallback, grouping/settings and locale-dependent consumers.
- Last-turn/index normalization and topic-preparation insertion/removal.
- Plugin resource/logical identity, success/error replacement, manual pin/disclosure,
  and the recent-three-turn auto-expansion boundary. A new plugin result can invalidate
  an older turn; a plain new turn can shift plugin expansion even without a plugin row.
- Time-dependent/highspeed cross-turn footers and phase transitions.

Preserve the visible running clock and highspeed expiry/wake behavior. Do not add a
history-wide interval, retain stale units after expiry, or force a full-history rebuild
on harmless focus/visibility events. Reveal must resolve missed expiry boundaries.

Include `deriveLogicalUiInstances` in the implementation and performance acceptance.
Remove or avoid its repeated linear membership search without bypassing plugin domain
rules. Preserve plugin policy with equivalence tests for no-plugin and plugin-rich
histories. Scope disclosure invalidation where justified, retaining cross-turn resource
semantics and multi-presenter correctness. Do not extend existing app-global maps with
unbounded retained sessions/snapshots or delete shared state used by another presenter.

Inventory and measure plugin derivation, topic preparation, expiry scan, clock-row
indexing, query/navigator preparation and remaining full-row passes. A single O(rows)
identity pass may be an acceptable measured tradeoff; disclose it. Do not claim
O(changed turns) for the total path while such scans remain. Avoid JSON serialization
or deep hashing of all content on every token as a cache key.

Test output against the independent full builder through every invalidation above.
Assert unchanged completed units retain identity during text-only streaming; show
bounded materialization counts and cache pruning on window/branch/session disappearance.
Do not capture whole historical snapshots in long-lived cache closures.

## 8. Measurement contract and acceptance budgets

Reproduce the original pure baseline without editing its report:

```powershell
node scripts/perf/run-render-baseline.mjs --turns 200,1000,2000 --ticks 60 --warmup 10 --no-write
```

Historical October 14 diagnostics supplied with the task used Node 24.13.1, seed
20261012 and these settings: full-builder p50 4.03/18.08/40.21 ms, 24-op apply p50
0.60/4.86/12.07 ms at 200/1000/2000 turns; 2000-turn rebuild p95 48.24 ms.
A separate paired accumulator feasibility experiment measured 8.64 vs 2.39 ms at
2000 turns, including copy/index creation. These are historical pure-function results,
not current candidate acceptance, normal wire-frame costs or permission to reuse that API.

Fresh audit results and the newly measured plugin cost are in the linked audit.
Do not compare unrelated runs as before/after. The old runner labels apply rows with
completed-history size although its measured window contains THREE added tail rows:
1972/10012/20055 history rows versus 1975/10015/20058 actual apply rows.

Root establishes a repeatable paired harness before judging candidate performance:

1. Record actual Node/pnpm versions, OS/CPU, revision and relevant dirty-tree fingerprints,
   fixture seed/hash, history turns/rows, actual loaded rows, raw and post-coalescing op
   counts, warmup/samples, configuration and machine-load limitations. `mise.toml` pins
   Node 24.14.0; audit/historical runs used 24.13.1. Use identical versions within pairs.
2. Keep the original fixture contents/sizes unchanged. Add explicitly named scenarios:
   small initial windows; 200/1000/2000 hydrated turns; empty/control/1/24-op frames;
   same-row and distributed updates; cumulative streaming; late old-turn updates;
   prepend/truncate/replacement; phase/expiry changes; no-plugin and plugin-rich cases.
3. Time candidate allocation/copy/index construction, invalidation and pruning inside
   the relevant measured boundary. Separate cold preparation from warm steady state.
   Run equivalence checks outside timed sections and consume outputs consistently.
4. Characterize noise with repeated baseline/baseline pairs; then freeze noise-aware
   improvement and small-window overhead budgets before accepting candidate results.
   Run at least three paired trials, alternating A/B and B/A order. Stop agent builds
   and tests during measurement; do not interfere with the user's application.
5. Report every trial's p50/p95 and spread, not the best run. If gains fall within noise,
   call them inconclusive; do not move budgets after seeing unfavorable results.
6. Keep helper-only apply, full store processing, plugin preparation, complete pure
   presentation preparation, isolated React and production GUI results separate.
   A reference-only rerun is not optimized-path evidence.
7. For hidden panes, use deterministic heavy-work/timer/measurement counts and control
   event assertions. Cover one/multiple visible and hidden panes and reveal cost.
   Ordinary unit tests assert equivalence and work bounds, not fragile wall-clock limits.

Only a later allowed production renderer run can establish commits under representative
rendering, long tasks, interaction latency, CPU/memory, layout/paint and user-visible
speedup. No GPU/FPS diagnosis without such evidence.

## 9. Resize: explicitly conditional

Do not remove `flushSync`, disable virtualizer measurement or rewrite animations first.
Measure the remaining resize path in an allowed representative isolated renderer.
Without that evidence, document a candidate and leave resize optimization unimplemented.
This does not block completing A–C.

Any later small resize change must preserve following-at-bottom, manual reading position,
prepend anchors, width-dependent heights, terminal transitions, cached restoration, both
chat-center/document-center arrangements and supported split orientations. Pure timers
and mocked geometry cannot accept that change's production performance.

## 10. Verification and independent review

Use actual root Vitest commands; `@zcode/ui` and `@zcode/shared` do not expose package
test scripts. Existing B baseline coverage can be run with:

```powershell
pnpm exec vitest run packages/shared/test/zcodeProtocolV4Coalesce.test.ts packages/shared/test/zcodeProtocolV4WorkflowRunsDelta.test.ts packages/ui/test/conversationRowSharing.test.ts packages/ui/test/v4SessionDataLayer.test.ts packages/ui/test/v4ResyncNotOwnedEvictionRace.test.ts packages/ui/test/v4ReplayBaseline.test.ts
```

Select affected A/C suites from the current checkout, including composer continuity,
turn render units, live tail, scroll memory/session switch, find, navigator, row sharing,
plugin policy, native execution source, layout swap/collapse/document persistence,
highspeed clock, share gating, lazy workers and heavy-preview behavior. Add meaningful
behavior/work-count regressions rather than only source-text assertions.

Check test discovery: the inspected root config does not automatically include all
source-local `src/v4/*.test.ts` or plugin domain tests. Existing
`highspeedFooterExpiryClockGate.test.ts`, `sessionShareProjectionGate.test.ts` and
`pluginUiRowPolicy.test.ts` require verified runner inclusion. Root owns any narrow
test-wiring change. A command that discovers zero tests is not a pass.

After focused checks, run required `pnpm typecheck`, `pnpm lint` and
`pnpm architecture:check --changed`, plus affected pre-push checks and build-only checks
required by the current governance. Inspect commands for runtime side effects before
running them. Report pre-existing failures separately; do not repair unrelated dirty
work without ownership. Never update architecture baselines just to make the gate pass.
Broad `ui` and `shared` are currently unmanaged; the plugin module is managed. A passing
architecture check does not certify unmanaged edges or sequence semantics.

The independent reviewer must inspect stable diffs and test/benchmark code, focusing on:

- Hidden control/config/permissions/live plugin events and composer continuity.
- Frozen and retained snapshot immutability; ordered operations and gap/duplicate/recovery.
- Desktop continuous and web replayable regressions where touched.
- Cache invalidation, older-turn updates, cross-turn plugin/footer dependencies, pruning.
- Oracle independence, fixture preservation, coalescing realism and complete timed work.
- Existing layout changes preserved; no scope creep or unearned live acceptance.

Fix findings, review the fixes, then rerun affected evidence. Root reviews the final diff
and updates existing checklist items with revision/fingerprint, paths, commands, counts,
review outcome, measurement boundary and open gates. Keep live acceptance open.

## 11. Final handoff and worker brief

Deliver source changes plus a concise report with changed responsibilities/paths,
paired before/after measurements and exact boundaries, checks actually executed,
remaining risks/scans/bottlenecks, review results and updated P-item evidence.
Include worktree path, starting baseline, latest integrated window target SHA, reviewed
candidate SHA, overlap resolutions and the owner's safe final integration procedure.
Report a merge-ready candidate separately from a merge actually applied to `dev`.
Explicitly state: "The reviewed candidate is ready in the isolated integration
worktree. The common branch and your active window-development checkout have not been
updated. Awaiting your separate instruction to merge into dev." Use "ready" only when
the required source, review and isolated checks are complete; otherwise list the actual
remaining blockers. Keep all worktrees/checkpoints available until successful handoff.
Include a later production-validation procedure: authorized isolated production build,
synthetic histories and one/several pane arrangements; stream/scroll/resize/reveal;
draft/IME/permission preservation; commits/long tasks/latency/CPU/memory/layout/paint;
identical conditions for native-vs-fork comparison. Do not execute that procedure while
the gate is closed. Do not mark the whole product accepted from source or fixtures.

Use this bounded brief for each worker:

```text
Role and wave:
Repository/checkpoint and dirty-tree caveats:
Absolute PERFORMANCE worktree cwd; main checkout read-only:
Integrated window checkpoint and overlapping paths/contracts:
Checklist IDs and exact outcome:
Accepted specs/contracts and dependencies:
Exclusive writable files; all other paths read-only:
State owners, visibility or sequence rules:
Required tests, oracle, work-count/measurement boundary:
Forbidden: live app/profile/models/dev servers; commit/push:
Exit gate and independent reviewer:
Handoff: <=10 bullets with files, behavior, evidence, limits and concrete integration requests.
```

Complete A–C and the permitted checks. Leave only accurately identified runtime-dependent
acceptance and evidence-gated resize work open; do not install or launch anything.
