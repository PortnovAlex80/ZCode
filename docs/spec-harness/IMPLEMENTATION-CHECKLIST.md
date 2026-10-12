# Implementation checklist: one ZCODE fork

Updated: 2026-10-12. Baseline: `bfede821`. Target and order:
[IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md). Execution brief:
[AGENT-TEAM-PROMPT.md](AGENT-TEAM-PROMPT.md).

## How root uses this file

Read this file at the start of every implementation/review turn. Select existing item
IDs, assign one writer per path, and update this file after integration and verification.
Chat is not the task database. Do not check an item for code existence alone if its
acceptance requires runtime evidence. `[x]` means the stated, bounded criterion was
verified; `[ ]` remains work or an unexecuted gate. Code/fixture completion and live
product completion are separate items. Link tests/source and record command, result,
revision and remaining limits; do not commit raw traces, user documents or secrets.

Checked implementation/fixture baseline items refer to prior verification of `bfede821`
and its ancestors. Functional/native tests were not rerun for these planning documents.
The documentation checks below are current evidence. Edits invalidate affected evidence;
recheck those items before restoring their accepted status.

## Current root state

| Field                          | State                                                                                              |
| ------------------------------ | -------------------------------------------------------------------------------------------------- |
| Product decision               | One maintained fork build; official installer is fallback; no maintained overlay build             |
| Current assignment             | Plan, English team prompt and checklist only                                                       |
| Live runtime gate              | CLOSED: user has active ZCODE sessions; no launch/stop/profile changes or paid prompts             |
| Immediate implementation order | D-01..D-05 desktop correctness; P-01 baseline analysis; then public document UI/binding boundaries |
| Release status                 | Not accepted: GUI, performance, live agent and installation gates remain open                      |

## Exclusive write assignments

Root fills this table before starting implementation agents and clears completed
assignments. A reviewer is read-only. Shared schemas, exports, package manifests/lockfile,
platform contracts and cross-package wiring stay with root unless explicitly reassigned.

| Item IDs   | Agent / role         | Exclusive paths                       | Depends on         | Reviewer / result                                |
| ---------- | -------------------- | ------------------------------------- | ------------------ | ------------------------------------------------ |
| A-01, R-01 | Root / documentation | `AGENTS.md`, `docs/spec-harness/*.md` | Inspected baseline | Local link/format/diff checks; runtime untouched |

## A — Canonical fork and architecture

- Branch policy: `master` is the default/accepted-version branch; `dev` contains all current work. Local/origin `main` and `research/spec-harness` were renamed preserving their commits. No extra permanent branches; merge upstream into `dev`, then fast-forward `master` after acceptance.
- Branch acceptance 2026-10-12: GitHub API rename preserved base `aac47556` and development tip `bec597d5`; `git branch -vv` and `git ls-remote --heads origin` show exactly `master`/`dev`, GitHub default and `origin/HEAD` are `master`. Freshness now resolves the remote default instead of skipping a removed `origin/main`; real `--no-fetch`, syntax, typecheck, lint (67 warnings / 0 errors) and changed architecture checks passed. Active runtime/profile unchanged.

- [x] **A-01** One product, three context lanes, native-host scope and runtime gate are documented. Evidence: implementation plan and team prompt; user clarification 2026-10-12.
- [x] **A-02** Fork has origin/upstream and migrated source modules. Evidence: baseline `bfede821`; [refactoring record](REFRACTORING.md).
- [x] **A-03** Build and start are separate; start rejects changed sources/output and does not start Vite. Evidence: `scripts/spec-harness-production.mjs`, `scripts/test/spec-harness-production.test.mjs`.
- [ ] **A-04** Review current call graph and ownership across Main/Host/services/CLI, including existing window-scoped Hosts, remote identity and document gateway; document any unresolved collision. Do not flatten all legitimate owners into one global Host.
- [ ] **A-05** Complete requirement-to-source/test mapping and native screen-element inventory for the current fork. Reconcile inherited overlay requirements; no old-only behavior claimed as current.

## D — Desktop document behavior and state

- [x] **D-00** Migrated document service, thread/anchor model, watcher and presentation state have focused source/fixture coverage. Evidence: `packages/services/src/spec-document/*.test.ts`, `packages/ui/src/spec-document/*.test.ts`. Live persistence is D-01.
- [ ] **D-01** Restore Open doc, chosen file, draft, conflict status, scroll and layout across project/session switch and restart; deleted/moved files give a visible recoverable state; no silent dirty-draft discard.
- [ ] **D-02** Verify project-chat history, inherited Side conversation and fresh discussion payload separately. Fresh discussion contains explicit project/document/fragment/request, no copied chat or silent whole-document attachment; empty draft produces native composer before Send without model input.
- [ ] **D-03** Open doc and Add in side chat work for valid new and existing parent sessions; disabled states explain genuine missing capabilities. Keyboard selection and source/view selection preserve exact fragments.
- [ ] **D-04** Delete discussion handles idle, pending, running and unknown execution honestly; removes durable bindings/native session as specified; reopening a document does not resurrect a deleted thread.
- [ ] **D-05** Expand/restore document, float/dock/resize/hide discussion, save/reload/external conflict and project-collapse persistence match the current screen spec. Hide is distinct from stop/delete.

## W — OS windows and view ownership

- [x] **W-00** Coordinator/readiness/rollback regression tests exist and passed with fake Electron. Evidence: `packages/desktop/test/specDetachedPanels.test.mjs`; lazy entries and platform bridge in fork.
- [ ] **W-01** Review and verify detach → source release → child attach/readiness → presentation, and Return → child release → source restore ACK → child close. One composer, correct owner/lease/generation; no extra agent and no timeout extension used to conceal a race.
- [ ] **W-02** Real production GUI handles early/repeated Return, X, hidden Main, missing parent, renderer crash and lost Host. On failure there is a usable rollback/recovery surface; no unhandled titlebar-overlay error or stranded handoff.
- [ ] **W-03** Draft, attachments, IME, selection, scrolling, permission dialogs and running session survive move/return; stale sender and late ACK are rejected.
- [ ] **W-04** Main/session/panel roles and project/session labels are visible; user can locate the original, show an existing detached view and return it without spawning a duplicate. Close-view and Quit semantics are explicit.
- [ ] **W-05** Two-monitor move, different DPI, minimize/restore, geometry persistence and missing-monitor recovery pass in actual GUI. View close does not stop background agents; owner shutdown is separately verified.

## P — Rendering performance

- [x] **P-00** Production renderer, lazy business entries, event-based detached readiness, auxiliary worker ceiling and visible-turn timer/caches exist. Evidence: `REFRACTORING.md`, `diffsWorkerBudget.test.ts`; this is not a measured speed claim.
- [ ] **P-01** Establish reproducible baseline: native vs fork, production-only, comparable history/agent count/viewport. Capture cold/warm detach and return, shell-ready vs content-ready vs interactive, p50/p95, CPU, private memory/heap, long tasks, layout/paint and worker count. Use isolated replay fixtures until live profiling is authorized.
- [ ] **P-02** Reduce measured eager highlight/diff cost without remounting the chat or breaking inline tool/diff output; state whether pools remain renderer-local. Agree thresholds from P-01 before accepting results.
- [ ] **P-03** Bound streaming invalidation, hidden-view subscriptions/timers, resize/virtualizer measurements and caches based on traces. Preserve sequence/replay, history heights and user scroll/focus.
- [ ] **P-04** Reprofile accepted changes under several active sessions and different sizes; report actual before/after and remaining bottlenecks. Consider retained WebContentsView only with evidence and a bounded separate spike.

## T — Native document conversation and transport

- [x] **T-00** Common opt-in gateway, native SDK and MCP helper compile and have focused tests. Evidence: `documentGateway.test.ts`, `documentHostClient.test.ts`, `prototypes/document-host/mcp-server.test.mjs`.
- [x] **T-01** Root CA differs from server certificate, with strict TLS and real HTTPS + MCP stdio fixture. Evidence: `bfede821`, `mcp-tls-acceptance.mjs`; no connection to live ZCODE was used.
- [ ] **T-02** Finish explicit project/session binding: existing project chat vs binding-specific document chat, Side parent and independent thread identity. Preserve upstream runtime isolation and enforce cross-surface composer policy; do not attach MCP retroactively to an active startup config.
- [ ] **T-03** Verify native controls and action parity: model/mode, attachments/context, supported slash/workflow commands, tools/reasoning, questions/permissions, stop, history pagination, thread switch/delete and error/recovery states. Reuse public controllers/components; no fake active selectors or demo response in production.
- [ ] **T-04** Reopen/reconnect restores durable session bindings/history and presentation as specified. Distinguish ephemeral native anchors/proposals; unknown command ID is queried without resending prompt/write. Failures remain visible.
- [ ] **T-05** Real allowed-origin/pairing/canonical-workspace/capability boundaries and disconnect/cancel/backpressure/session deletion work end to end. Preserve complete preexisting MCP configuration; provider credentials never enter the pane.
- [ ] **T-06** Trace real pane → native transport → Host/services → CLI `app-server --stdio` → provider/tool → native projection. Verify create-without-input, stream, permission/question, stop, busy admission and recovery with authorized model usage only.

## O — Word and Excel

- [x] **O-00** Word native range/read/locate/comment/tracked replacement and refusal fixtures passed: 8 native + 3 UI checks. Evidence: `Test-Office-Adapters.ps1 -HostName word`, baseline `bfede821`; UI checks use a test command facade.
- [x] **O-01** Excel native range/read/formula/value/freshness/refusal fixtures passed: 7 native + 3 UI checks. Evidence: same fixture with `-HostName excel`; not proof of a live CLI/model loop.
- [ ] **O-02** Word GUI ribbon/ПКМ/selection/thread UX, anchored duplicate-text handling, external edits, comments and revision tracking restore pass with required API checks. Unsupported rich-content replacement refuses; no false atomic-CAS promise.
- [ ] **O-03** Excel GUI menu/selection/thread UX and apply pass for values and invariant formulas; native target identity, dimensions, limits and protection/merged/array/spill refusals hold through real user changes.
- [ ] **O-04** Both hosts share familiar ZCODE controls/themes while preserving host UX, keyboard/IME/focus/accessibility and narrow layout. Every required screen control has an ID, state/action/capability/error description and verification.
- [ ] **O-05** Real Word and Excel agent loop reads live unsaved content, proposes a bounded edit, applies once on user action, verifies receipt, refuses stale/switched/closed targets and recovers after pane reconnect.

## C — AutoCAD

- [x] **C-00** AutoCAD 2024 net48/x64 plug-in compiled against installed SDK; 14 CoreConsole native checks passed. Evidence: `prototypes/autocad-preview/SpecHarness.AutoCAD.csproj`, `Test-AutoCAD-Adapter.ps1`.
- [ ] **C-01** Actual NETLOAD/SHDOC/WebView2 deployment, docking/floating palette, focus and selection/cancel pass without changing global SECURELOAD or modifying another application's installation.
- [ ] **C-02** Real GUI verifies document activation/navigation epochs, bounded queue, command context/DocumentLock/transaction, explicit INSUNITS/WCS/OCS, native identity and setLayer refusals. No stale drawing is activated automatically.
- [ ] **C-03** Native CLI agent loop reads/locates selected geometry, proposes setLayer and applies once with verified result; no arbitrary LISP/command-string executor is substituted for supported tools.

## R — One release, build, profile and docs

- [x] **R-01** Root plan/prompt/checklist distinguish implemented, fixture-verified and live-unverified work. Earlier Office/preview design documents point to current SRS and are labeled historical.
- [ ] **R-02** After implementation, focused tests, root typecheck, lint, changed architecture gate, affected pre-push checks and production receipt validation pass on the final frozen revision. Document prior failures/warnings and checker coverage honestly.
- [ ] **R-03** Complete Electron/native/runtime preparation and fresh-machine build/install/run instructions using pinned toolchains; verify no Vite, temporary HOME or active-runtime source injection is used.
- [ ] **R-04** Fork uses that machine's normal ZCODE profile, project list and local authorization without shipping credentials. Shared-profile concurrent start is refused/handled; schema/version/fallback data recovery documented and verified with disposable profile copies first.
- [ ] **R-05** One supported launcher/shortcut and original upstream Z icon (including its two slits) appear correctly in first/child windows, Alt+Tab, taskbar/pinning. User-provided replacement art is a later optional input.
- [ ] **R-06** Document every current screen element and workflow with requirement → control → owner → test/evidence links. Build/update/upstream-merge and another-machine setup instructions match actual scripts.
- [ ] **R-07** Full integration is independently reviewed and live release gates pass or user explicitly narrows scope. Retire obsolete overlay launchers/builds within an agreed list; keep user data and project files. Official installer remains fallback; no parallel supported legacy product.
- [ ] **R-08** Implement one root `Build-Installer.cmd` over upstream Windows x64 electron-builder/NSIS bundling. Full and verified-cache rebuild paths prepare/build/package without launching/installing/publishing; fail clearly and print artifact path, upstream/fork version, source revision and SHA-256. Pin CLI/native assets; distinguish desktop package from Office/CAD setup.
- [ ] **R-09** Packaged EXE enables accepted fork functionality without source-launcher environment variables. Verify installer/runtime closure, original icons, install/upgrade/uninstall and normal-profile reuse using owned isolated environments. No shipped credentials/dev cache/certificates, and no profile deletion.
- [ ] **R-10** Define and verify fork-safe update behavior: automatic official update cannot silently replace our changes; reviewed upstream source update/rebuild is documented. Official installer is an explicit fallback; profile-schema/data restoration is separate from application reinstall.

## Evidence updates and handoff

2026-10-12 documentation acceptance, A-01/R-01: only `AGENTS.md` and
`docs/spec-harness/*.md` changed. Root typecheck passed; lint passed with 67 existing
warnings and 0 errors. Local-link validation found 30 links and no missing targets;
all 46 checklist IDs are unique. Changed-document format and Git whitespace checks
passed after formatting. No source behavior, GUI, native fixture, model or active
profile was changed/tested in this update. This does not close R-02 or live gates.

For each newly accepted item append a bounded entry here, or add it to the item itself:

```text
ID(s):
Revision / affected files:
Check command or manual scenario:
Result and relevant counts / measurement:
Independent review:
Remaining limits / runtime gate:
```

No new implementation work has been accepted by this documentation update. The next
implementation root starts from open IDs, not from a claim that the entire product is
done. The future compact API reference map is intentionally outside this checklist's
release scope; see DOCUMENT-HOSTS.md for that separate request.

2026-10-12 installer planning update: `git ls-remote upstream 'refs/tags/*3.15.1*'`
confirmed that the peeled `v3.15.1` tag equals original base
`aac4755666d09fdcd70272fcf063c077a639015f`. The downloaded EXE's version resource
reports ProductVersion 3.15.1 / FileVersion 3.15.1.8093; it was not executed.
Reviewed existing `bundle.mjs`, product identity and NSIS config. R-08..R-10 remain
open: no installer wrapper, installer build/install or auto-update behavior was
implemented/tested in this planning update. The old 46-ID count above belongs to the
previous document check; the active checklist now has 49 unique items.
