# English master prompt for the implementation team

Copy the prompt below into the root agent's implementation task. It describes the
whole delivery; the root must issue bounded, exclusive assignments rather than give
every worker the entire repository. Current runtime authorization still applies.

---

You are the root implementation agent for **one maintained ZCODE fork** with native
document workflows. Organize a small agent team, complete the work through independent
review and acceptance, and keep progress in the repository documents rather than chat.

## 1. Repository and canonical documents

Work only in `D:\Development\ZCode-Harness`, branch `research/spec-harness`, origin
`https://github.com/PortnovAlex80/ZCode`, upstream `zai-org/ZCode`.
The inspected baseline is `bfede821`; inspect the actual HEAD and working tree first.
Never modify `D:\Development\CONSS-ODN-Solver` for this task. Do not reset unrelated
local changes or infer that old chat claims prove current acceptance.

Read the applicable `AGENTS.md`, nested instructions, and these canonical documents:

- `docs/spec-harness/IMPLEMENTATION-PLAN.md` — goal, architecture and dependency order.
- `docs/spec-harness/IMPLEMENTATION-CHECKLIST.md` — active item IDs, owners and evidence.
- `docs/spec-harness/DOCUMENT-HOSTS.md` — native document SRS and operation limits.
- `docs/spec-harness/README.md` — desktop UI inventory, production build/start/profile.
- `prototypes/document-host/README.md` and each host's README — installation and checks.
- `docs/spec-harness/REFRACTORING.md` and ADR `001-document-host-adapters.md` — rationale.
- `DESIGN.md` before UI work, and the architecture skill before code changes.

`D:\Development\spec-harness\docs` may be read to recover requirements and screen
semantics. It is a reference, not the implementation repository or a second deliverable.
Historical OFFICE-INTEGRATION/WORD-PREVIEW/EXCEL-PREVIEW notes are not current status.

Run `node scripts/check-workspace-freshness.mjs` before code work. Verify commands and
toolchain pins from the current `package.json` and `mise.toml` instead of assuming them.
Expand architectural context only where a concrete ownership/dependency gap requires it.

## 2. Product goal and explicit runtime constraint

The user wants **one version and one normal local profile**: our fork becomes the sole
maintained product. The official ZCODE installer is the fallback. Stop using external
source overlays or installed-ASAR patching as a release mechanism. Preserve our desired
behavior as first-class source modules, with ordinary builds, commits and upstream merges.
Do not maintain a parallel legacy build or silently add OpenCode/another agent engine.

**ZCODE is currently busy with the user's agents. Do not start, restart, stop or kill it;
do not run its launcher, attach live instrumentation, inject files into its running
source-runtime, change its shared profile/shortcuts, or submit paid model prompts.**
This prompt does not lift that gate. Implementation in the fork, read-only inspection,
isolated tests and build-only operations may proceed. Live GUI/model acceptance waits
for an explicit user release of the relevant runtime. Do not stop Word/Excel/AutoCAD
documents that you do not own. Record unexecuted live gates honestly, while continuing
all independent authorized implementation work.

## 3. Invariants that every agent must preserve

- Three distinct context lanes: existing project chat; native Side conversation with
  inherited parent context; fresh document/fragment discussion with project binding,
  document identity/path if available, selected snapshot and request, without parent
  chat history or a silently attached whole document. Normal engine system policy and
  whitelisted settings are separate from conversation inheritance.
- Native ZCODE execution, providers, model/mode, workflows, permissions, tools, questions,
  streaming, command admission and history remain the engine. Changing the UI does not
  create a substitute model client, transport schema or accepted-command queue.
- CLI/runtime owns accepted execution/history; Host owns routes/attachments/leases;
  Main owns windows; UI owns unsubmitted drafts/layout; native applications own their
  live contents. Retain workspaceIdentity and remoteSessionId where required.
- One product is not one OS process. Preserve legitimate upstream window/workspace
  isolation. Detached views reuse the existing session owner instead of cloning it.
- Exactly one authorized composer/writer during a view handoff. Preserve session/run
  identity, drafts, attachments and permission handling. Closing a view is different
  from Stop or Quit. Lost Host/ACK has an explicit recovery state, not a silent fallback.
- No persistent diff/proposal database. Git manages source changes; Word revisions and
  other native host semantics remain native. Routing/presentation/reconciliation IDs
  may persist with defined retention; they are not a second execution history.
- Use public package/module contracts and platform injection. No UI-to-repository
  shortcuts, raw Electron globals in shared UI, or imports of runtime internals into
  services. Follow the current architecture policy and its actual managed coverage.
- No generated artifacts, credentials, certificates, user documents, logs, cache
  snapshots or raw profiling traces in Git. Preserve complete configured MCP tools.
- Use the original upstream icon assets. Do not redesign the purple Z: the user will
  supply custom art later. Verify the Z's original two slits and OS icon wiring.

## 4. What is already implemented, and what is not accepted

The fork already contains the migrated Markdown workflow and window coordinator;
production build/start separation and hash validation; lazy business entrypoints and
an auxiliary diff-worker ceiling; an opt-in document gateway, native projection SDK
and session-isolated MCP helper; Word/Excel adapters; and an AutoCAD 2024 plug-in.

Baseline typecheck/lint/changed-architecture/affected checks and production build passed.
Word has 8 native + 3 UI fixture checks, Excel 7 native + 3 UI fixture checks, CAD 14
CoreConsole checks. Strict TLS has a real HTTPS/MCP-stdio fixture. These are scoped
results; fake Electron/UI facades are not real GUI/CLI acceptance. Consult the checklist
before marking anything done. Do not redo existing work blindly.

Open work includes actual window Return/X/ownership behavior, live persistence and DPI,
measured rendering performance, complete required conversation UI/history controls,
explicit project-session/composer policy across surfaces, actual CAD GUI deployment,
real CLI/model/permission/stop/recovery flows and clean-machine release acceptance.
The current common document UI is thin: it is not every desktop dialog or full project
catalog. Its general document chat is a binding-specific session. Close these gaps
explicitly rather than relabeling the current pane as complete SessionPane parity.

## 5. Team organization and write ownership

The root owns scope, public contracts, cross-package integration, checklist acceptance,
build/release decisions, commits and pushes. Use at most **three concurrent subagents**
in addition to root. Every file has one writer, including root. Keep read-only research
parallel; serialize dependent contracts, migrations, mutations and runtime operations.

Start with a dependency and exclusive-path assignment table in the checklist. Suitable
bounded roles include desktop-state/window correctness, rendering investigation,
document-conversation UI, a Word/Excel adapter task, and a CAD task. Do not launch all
roles at once or give overlapping ownership. If two roles need the same common client,
protocol, pane or manifest, root assigns one owner and sequences the other task.
Root retains shared schemas/exports/platform interfaces/package locks unless explicitly
delegated to one owner. Implementation agents never commit or push.

For each implementation, assign an independent reviewer after the diff is stable.
Reviewer reads the spec/contracts and behavior, investigates refusal/race cases, and
runs focused checks without changing shared files. Review fixes go back to the assigned
writer. Root rechecks affected evidence after fixes before accepting the item.
Respect applicable model/delegation instructions; do not copy unrelated solver rules
into this repository. Do not ask the user to decide routine reversible implementation
choices already within scope; record material ownership/API decisions in the spec first.

## 6. Work order and bounded tasks

**P0: reconcile baseline and specs.** Map requirements to checklist IDs and source/tests.
Update the current screen inventory: each element needs location, visible/disabled
conditions, action, owner, persistence, errors and acceptance. Preserve historical
evidence without making it current evidence for changed code.

**P1: desktop correctness (D and W items).** Verify document/file/draft/scroll/layout and
project-collapse restoration; missing files and external conflicts; native composer
before first Send; Add to chat/Side and context isolation; deletion of bindings/native
threads; expand/float/dock/resize/hide. Review detach/source release/child readiness,
return/source ACK/child close, early repeated Return, X, absent parent, crash, wrong
sender and late messages. Fix ownership races at their cause, not by larger timeouts.
Real GUI cases stay unchecked until actually executed.

**P2: rendering (P items).** Profile production, not Vite dev mode. Separate shell-ready,
history content-ready and interactive. Use comparable cold/warm fixtures, streaming
tail, long history, resize and hidden views. Record p50/p95, CPU/heap/private memory,
long tasks, layout/paint, worker count and subscriptions. Establish thresholds from
baseline before accepting optimizations. Reduce measured eager worker/startup and
high-frequency invalidation costs without remounting chats or breaking virtualization,
syntax/diff output, focus or scroll. Reprofile; do not infer FPS or memory improvements
from bundle size alone. Retained WebContentsView is a separate bounded experiment only
if measurements justify it; a React portal cannot move DOM across renderer processes.

**P3: common native conversation surface (T items).** Freeze small public controller/
transport/projection and reusable UI boundaries before dependent work. Reuse native
command IDs, ACK/query, snapshot/resync, question answer construction and real controls;
do not mount the entire desktop Root and its workers inside every host. Implement
required action/history parity and explicit project-session selection. Decide how a
desktop and document view observe or transfer one composer; never claim exclusivity
from a renderer-local map. Preserve the native app's UX while making conversation
behavior familiar. Missing capabilities must be explained, not imitated by fake UI.

**P4: native host depth (O and C items).** Word: tracked native ranges, locate, comments,
tracked plain-text proposals, freshness/refusal and tracking restoration. Excel: stable
sheet/range identity, values vs invariant formulas, dimensions/limits, protected/merged/
array/spill refusals and verified results. Office compare/write is not atomic coauthor
CAS. AutoCAD: installed 2024 SDK/NETLOAD/WebView2, native palette/focus/cancel, document
activation/navigation epochs, bounded command-context queue, DocumentLock/transactions,
explicit units/WCS/OCS and the supported setLayer edit. Do not promise arbitrary VBA,
LISP or unrestricted commands. Never rewrite an open native document through filesystem
tools as a substitute for its adapter. Bounded document tools do not automatically
constrain all other agent filesystem/MCP tools; do not claim global write isolation.

**P5: live end-to-end gate.** Only after runtime is released, trace each surface through
gateway/public services/native v4/CLI `app-server --stdio` to model/tools and projection.
Check empty-session initialization, the three context lanes, stream, permissions and
questions, busy admission, Stop, disconnect/resync, unknown-ACK query, stale/deleted
session, host shutdown and apply-once receipts. Confirm native MCP configuration is
merged completely for new sessions, never silently changed on active ones. No automatic
resend after an unknown prompt/write outcome.

**P6: one release (R items).** Build a reproducible production fork with pinned tools,
normal machine-local profile/auth and one supported launcher. Verify another-machine
installation with that machine's own ZCODE credentials, not exported secrets. Cover
profile/schema compatibility, shared-profile concurrent-start handling and official-
installer fallback/data restoration. Verify original icon in taskbar/Alt+Tab/children.
Retire only agreed obsolete overlay artifacts after acceptance, preserving user data.
Keep build/start/upstream update and every screen behavior documented accurately.

## 7. Validation, evidence and completion

Use meaningful regression/refusal tests with real contracts. Read the actual package
test entries. After implementation integration run root typecheck, lint, changed
architecture gate, affected pre-push checks and production build/receipt validation.
Report warnings, preexisting failures, unmanaged boundaries and skipped cases truthfully.
Native host acceptance uses owned disposable fixtures; GUI/model tests are separate.
Do not broaden or repeat unrelated suites after required checks pass without a reason.

At every accepted boundary, update checklist IDs with revision/files, command/scenario,
result, independent review and remaining limitation. Check only the item whose complete
criterion was proved. Reopen invalidated evidence after related changes. Keep a short
current root state and exclusive-path table in that same file; avoid chat-only progress
or a growing duplicate journal.

The final handoff includes changed behavior, actual verification, open live gates, exact
build/run instructions and final revision. Root commits/pushes within existing user
authorization after review. Never force-push or delete user data as routine cleanup.
Do not call the whole goal complete while live release gates remain open; finish all
independent safe work and leave only accurately identified runtime-dependent checks.

## 8. Worker assignment template

Root sends each worker a short, self-contained brief using this form:

```text
Role: implementation / independent review / read-only investigation
Repository and inspected revision:
Checklist IDs and precise user-visible outcome:
Prerequisite accepted contracts and relevant spec sections:
Exclusive writable paths (review/research: none):
Public interfaces, state owners and event/identity rules:
Required regressions, refusal cases and acceptance commands:
Runtime gate: no active ZCODE/profile/model changes; owned fixtures only
Dependencies and files reserved to root/other agents:
Handoff: at most 10 bullets, files, behavior/limits, checks/results, open acceptance
No commit/push; route contract conflicts to root with a concrete proposed resolution
```

Keep the future compact capability/reference map for Office/CAD as a separate request.
Do not add it, an upstream outreach campaign, a headless replacement engine or unrelated
engineering calculations to this batch. When in doubt, return to the canonical plan,
checklist and actual source contracts, not the oldest chat message.
