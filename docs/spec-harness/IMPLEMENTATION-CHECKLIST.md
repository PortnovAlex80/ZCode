# Implementation checklist: one ZCODE fork

Updated: 2026-10-13. Baseline: `bfede821` (recorded evidence baseline); Wave 1 was
built on `aa8236cf` and integrated 2026-10-13. Target and order:
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
| Current assignment             | 2026-10-15 handoff complete: user approved ordinary UX; browser consent confirmed. Native windows/project roots/catalog retry and OAuth runtime assembly are repaired. English changelog and Russian checklist audited. Full pre-push verification, source push and production packaging passed; packaged GUI smoke passed. Live catalog/inference/billing and specialized window/performance acceptance remain open. |
| Live runtime gate              | OPEN for ZCode repair/GUI validation: user explicitly confirmed on 2026-10-15 that ZCode is shut down and work may proceed. Build, launch, restart and inspect the repaired app; preserve profiles and sessions. Browser consent remains the user's action; no automatic paid/model prompts or unrelated Office/CAD changes. This supersedes older closed-runtime notes for this repair. |
| Toolchain decisions            | `pnpm.overrides`/`patchedDependencies` live in `pnpm-workspace.yaml` (frozen-lockfile install verified, react 19.2.7, typecheck green); agents may run `pnpm install --frozen-lockfile` but never lockfile-refreshing commands; node 24.13.1 shell deviation recorded per evidence |
| Immediate implementation order | Wave 4 (build-only): R-08 Build-Installer.cmd, R-10 fork-safe updates, R-03 build/run instructions, O-06/O-07 and T-05 fixture halves, R-06 doc pass → R-02 full gates at the frozen revision → only live-gated work remains until the user explicitly releases the runtime |
| Release status                 | Not accepted: GUI, performance, live agent and installation gates remain open                      |

## Exclusive write assignments

### User handoff audit and push — 2026-10-15

User explicitly approved committing and pushing current work, requested an English
changelog and review of the Russian acceptance checklist, and asked to preserve GLM
billing/routing. Root owns those documents and push to origin/dev. The checklist now
records general everyday-UX approval separately from detailed unperformed scenarios;
U-15/10.2 has direct live evidence. Model availability/billing remain separate gates.
Read-only routing audit confirmed unchanged ZCode/Z.ai gateway and credential branches,
but found missing production GPT request-auth assembly. `repair_openai` owns the narrow
bootstrap DI fix and routing regressions; root requires independent review and rebuild
before treating the latest installer as the final handoff candidate.

Routing audit result: 54 existing adapter/gateway/provider/overlay tests plus 19
bootstrap tests passed. Independent reviewer reran the 11 factory/composition tests,
including a real loopback HTTP request through runner. New source applies only to
openai-oauth; Zhipu off-peak/highspeed preserve the exact target source, ordinary
GLM/API-key providers preserve their branches. Missing OAuth fails before network
without OPENAI_API_KEY fallback. Shared data-base path matches Host credentials.
Root final typecheck passed; lint 63 warnings/0 errors; architecture 0 violations.
Full live billing/quota bucket remains unverified; no paid inference was used.

Push validation expanded to the full root unit suite because origin/dev predates
removed source files. It exposed recursive test-proxy preloading: the existing
Windows URL import was not removed by path-only NODE_OPTIONS cleanup. Fixed only
that helper and verified no fixture processes remain. Five already-present local
Windows compatibility changes are reviewed and included unchanged so pushed tests
are reproducible (PowerShell UTF-8, platform file URLs, pnpm patch authority, proxy
URL import). Independent focused check: 5 suites / 30 tests passed. The earlier
PowerShell timeout does not reproduce after recursive fixture cleanup.

The next full verification exposed a timing-sensitive downloader test (30ms real
network chunks versus a 50ms idle limit). Replaced only that test fixture with a
controlled clock and stream consumption checkpoints, retaining real file/hash checks;
active data survives 240ms total and stalled data aborts exactly at the 50ms limit.
Product downloader and timeouts are unchanged. Focused 7 tests passed, lint clean.

Final full pre-push verification at `674d57b8` passed: 1,975 test files and
18,419 tests passed; 3 files and 67 tests skipped, no failures (1,073.63 seconds).
Lint completed with 63 warnings and no errors; architecture reported no violations.
Normal `git push origin dev` completed successfully, advancing origin/dev from
`aa8236cf` to `674d57b8`; no hooks were bypassed. Production CLI, Electron and UI
compilation passed at the same revision; installer packaging is recorded below.

Final production artifact: `packages/desktop/dist/ZCode-3.15.1-win-x64.exe`,
170,130,002 bytes; SHA-256
`afc136c19e93fe830943197e71e32a6cace3945fe2f1b74f64afbeef1bc6c7fc`.
Packaged metadata: version 3.15.1, source revision `674d57b8`, build time
2026-10-15T17:02:45.688Z. Full production build and Build-Installer fast both
completed successfully, including package audits. Isolated launch of the actual
`dist/win-unpacked/ZCode.exe` confirmed title ZCode, app.asar renderer and visible
Continue with ChatGPT welcome; no live inference was sent. Exactly one shortcut
remains: Desktop/ZCode.lnk targets this win-unpacked executable. Installer was not
executed; existing installed application/profile were preserved. Later documentation
commits do not change the artifact's embedded source revision.

### Callback completion and model catalog recovery — 2026-10-15

Live user completed browser consent but login spinner persisted. Saved credentials
were observed, model cache absent. An authenticated bounded GET to the documented
model endpoint returned HTTP 520 (no model inference invoked). Host TCP inspection
also showed a remaining loopback connection after its listener had closed; callback
shutdown must be tested against browser speculative connections rather than assumed.
`repair_openai` owns adapter deadlines/callback cleanup/catalog refresh + Desktop bridge;
`repair_windows` owns account service serialization/Host composition;
`repair_performance` owns retry/status UI and locales. Root owns specs, integration,
independent review, validation and production rebuild. No account tokens or raw traces
are committed. Existing installed process and active consent are preserved.

Implementation verification: real speculative TCP callback test reproduced the hang
before cleanup and passed after it. Token exchange/refresh and catalog headers/body
have aborting 15-second deadlines; expired-token timeout preserves credentials and
releases the refresh lock for the next attempt. Catalog retry uses current credentials,
generation-guarded cache writes, and existing provider projection refresh.
Root executed 43 adapter tests (5 suites), 9 service/desktop integration tests (2 suites),
and 15 UI/hook tests (2 suites), all passed. Full typecheck passed after rebuilding
adapter public declarations. Lint 63 warnings/0 errors; architecture 0 violations.
Independent review caught the expired-token deadline gap before this validation.
Actual account catalog availability remains blocked by observed upstream HTTP 520;
local retry/interface evidence cannot establish live model access or inference.

Product GUI at code revision `f667b682`: isolated encrypted fixture account and
localhost catalog endpoint, first GET returned HTTP 520 and visible error, second
explicit Refresh models returned one model. Continued into workspace and opened
the actual composer selector: OpenAI/ChatGPT group contained `gpt-5.4` from the
fixture catalog. Exactly two catalog GETs; zero OAuth consent or inference calls.
This verifies UI → Host service → Desktop adapter → cache → provider projection →
real selector, not live OpenAI availability. Production source/CLI build passed.

### Reopened live defects — 2026-10-15

User reports production browser never opens for ChatGPT, project picker still lists
application-checkout files, and discussion Expand still creates a document-bounded panel.
Root owns integration, real GUI validation and the user-authorized commit.
`repair_openai` owns acknowledged Main/Host browser launch; `repair_performance` owns
authoritative active-project document binding; `repair_windows` owns discussion native
Expand/layout. The latter two coordinate exclusive writes in SpecDocumentPane/shell.
Prior welcome-button and main-chat tests do not accept these three reported flows.

Follow-up findings and verification:

- A real isolated Electron probe reproduced utilityProcess shell launch returning
  success without a browser request. Main `shell.openExternal` opened the localhost
  page with intact query parameters. Desktop now uses a validated Host/Main request
  and acknowledgement, with a bounded failure instead of optimistic success.
- The document root reads the focused conversation binding or matching active task
  metadata; unknown/remote scopes do not fall back to the installation directory.
  Real temporary project A/B filesystem tests and store-focus tests cover this path.
- Desktop discussion Expand uses the native window operation. A moved discussion has
  no internal drag/resize handles or fixed inner minimum dimensions. The actual-pane
  regression checks node preservation and Return; full installed GUI remains a gate.
- Root integration regression run: 10 suites / 59 tests passed; build receipt tests
  2 passed. Auth bridge independently reviewed without blocking findings. Workspace
  review identified draft/session boundary cases; these are fixed with explicit regressions.
  Final workspace/stability run: 4 suites / 14 tests passed. Final typecheck passed;
  lint 63 warnings / 0 errors; architecture 0 violations.
- Account consent and model requests were not performed. Browser launch evidence is
  not evidence of successful subscription authentication or inference.

Follow-up product GUI evidence at code commit `a4665e07`:

- Fresh isolated profile, explicit temporary project A, process cwd in the app repo:
  Open doc lists exactly `unique-project-A.md`. No installation files are listed.
- Opened the actual document discussion pane, used its native Expand control,
  moved/resized the real BrowserWindow to `(30,30,1000,750)`, verified no internal
  move/resize handles, then returned the same pane. This used an empty discussion;
  an active paid/model conversation was not created.
- Actual Continue with ChatGPT UI reached Main's native launcher exactly once with
  the official authorization origin/path. Injecting an OS-launch failure produced
  the visible retryable error rather than an endless spinner. This fixture does not
  claim live account authentication. The separate real localhost browser probe above
  verifies that Main's native launcher opens the default browser.
- Updated production executable launched from packaged `app.asar`, title ZCode,
  and displayed Continue with ChatGPT. The existing user's app/profile was preserved.

Updated installer: `packages/desktop/dist/ZCode-3.15.1-win-x64.exe`, 170122480 bytes,
SHA-256 `ef1e2b9928820baa698d96888fba4ba5a670c945f3191e9ea7c2dcf7d51c8554`.
Packaged code revision `a4665e07`, production identity, upstream auto-update disabled.
Build-Installer fast validation, native packaging checks and size audit passed;
completed 2026-10-15 19:12 MSK. One ZCode desktop shortcut still points to the rebuilt
`dist/win-unpacked/ZCode.exe`; no installer execution or profile replacement performed.

### Active repair — 2026-10-15

User released the stopped runtime for repair. Existing GPT checklist below is historical:
`a79e7ad4`/`0cd2366e` already implemented subscription integration; this repair addresses
defects in that implementation rather than claiming it was absent.

- Root: production wrapper/receipt, ADR integration, build and real GUI validation.
- `repair_openai`: OAuth launcher/login, SIWC tool wire format, account/model refresh,
  account UI and welcome entry; focused protocol/account tests.
- `repair_windows`: native popup policy/platform adapter, stable React portal and
  source navigation lifecycle, child-document UI overlays, window regression tests.
- `repair_performance`: write-guard publication and plugin disposition structural
  sharing; regression tests and bounded CPU replay. Independent auth review follows.

Confirmed regressions: unquoted Windows OAuth URL parsing; unsupported SIWC top-level
function tools; UI-only production rebuild retaining old agent; repeated unchanged
write-guard and plugin publications. Native same-origin Electron proof passed with
sandbox/isolation retained. Production GUI, actual consent/inference and idle-home
performance acceptance remain open until separately measured.

Repair evidence (working tree based on `c3a256c0`, 2026-10-15):

- CLI fully rebuilt and staged, then stable desktop build completed and the production
  receipt validated. Concurrent edits during earlier attempts were correctly rejected.
  `Build-Harness.cmd` now rebuilds/stages CLI; source receipt includes CLI source.
- Product GUI with existing profile: real Lexical draft typed before and after detach;
  real model picker opened inside native child; switching Main to Automations kept child
  alive; Return restored the original draft; temporary unsent test text cleared.
  Child surface background `rgb(22, 22, 22)`; one main window remained, no page errors.
- Clean-profile product GUI: **Continue with ChatGPT** visible on welcome screen without
  API-key entry. Real main-profile startup measured 8.4 s in one run; after settling,
  renderer CPU sample was ~0.24%. This is bounded observation, not a broad performance SLA
  or proof that every user-reported workload is fixed.
- Isolated real Electron/React/Lexical smoke: three simultaneous native surfaces,
  input/state retention, child menus, OS close, main hide/reveal, 20 cycles, no children
  left behind. This does not substitute for actual multi-document/session workload testing.
- CLI auth/wire 29 tests; services/bridge 18; account/selection UI 9; window-focused
  suites 41; independent root regression run 22; build receipt 2. All passed (overlapping
  suites are not additive). Full typecheck passed; final lint 63 warnings/0 errors;
  final architecture check 0 violations. Auth and rendering changes independently reviewed.
- Remaining human/account gate: real SIWC consent, model discovery and live tool roundtrip.
  No model requests, account impersonation, private endpoints or billing fallback used.
  Installed distribution was not overwritten; repaired checkout starts via `Start-Harness.cmd`.

Production packaging follow-up (2026-10-15): built
`packages/desktop/dist/ZCode-3.15.1-win-x64.exe` (170123160 bytes), SHA-256
`f69333402f82b93cbe67c569a6e63946e9fc7833c01d833bc13d24b947246790`.
Production identity `ZCode` / `dev.zcode.app`, automatic upstream updates disabled.
Fixed preparation ordering: full agent preparation restores official plugins/native
dependencies after CLI staging. All packaging/native checks and size audit passed.
Packaged executable launched from `app.asar` and displayed Continue with ChatGPT.
Exactly one related shortcut remains in Desktop/Start Menu/pinned locations:
`C:\Users\user\Desktop\ZCode.lnk` → checkout `dist\win-unpacked\ZCode.exe`.
Old shortcuts backed up under `.tmp/shortcuts-backup-*`; protected duplicates removed
through Windows UAC. Installer was built, not installed over Program Files.

### GPT — подписка ChatGPT в штатном селекторе (2026-10-15)

План: [CHATGPT-SUBSCRIPTION-PLAN.md](CHATGPT-SUBSCRIPTION-PLAN.md).
Добавлен пользователем как будущая интеграция в существующий fork. Все пункты ниже
открыты; наличие плана и внешнего примера не является реализацией или live acceptance.
Текущий runtime gate и другие активные назначения сохраняются.

Исследование 2026-10-15 (root, read-only; исходники и runtime не менялись): составлена
карта штатного селектора/providers (builtin-каталог revision 31 → аккаунт/персональные
оверлеи → resolver → registry → `ModelConfigSelect.tsx`; wire-тип `openai-responses` в
рантайме уже есть); зафиксировано, что подпись запросов (`X-Client-Sig`/`X-Client-Pow`,
`codingPlanSignature`) в открытой редакции отсутствует — `request-security-edition` —
заглушки, форк не менял эти файлы с `aac47556` (по `apps/zcode-cli` — 0 коммитов);
определён фактический GLM-маршрут (`official-coding-plan-gateway.ts:8-11` ultra-rewrite +
Project Token); diff донора `bd5171cb` классифицирован на переносимое/непереносимое
(детали и path:line — раздел 3 плана). GPT-01 остаётся открытым: аудит на уровне
отдельных ханков, лицензии/атрибуция и совместимость с нашим dev не воспроизведены.

- [ ] **GPT-00** Зафиксировать spec/ADR и официальный контракт SIWC; допуск конкретного аккаунта/workspace/региона остаётся отдельным live gate.
- [ ] **GPT-01** Аудировать pinned nasone32/ZCode и определить минимальный перенос с сохранением лицензии, без автоматического переноса изменений маршрута Z.ai.
- [ ] **GPT-02** Реализовать и проверить OAuth, защищённые credentials, межпроцессную refresh rotation, отзыв и очистку без гонок.
- [ ] **GPT-03** Добавить account provider, актуальный каталог и capabilities в штатный selector; заменить CDN revision workaround устойчивым расширением registry.
- [ ] **GPT-04** Проверить Responses wire contract, namespace/tools/result round trip, reasoning state, cancellation и terminal failures.
- [ ] **GPT-05** Реализовать Continue with ChatGPT в Manage models, статус подписки, Usage, reconnect/disconnect и обновление picker.
- [ ] **GPT-06** Пройти релевантные тесты, typecheck/lint/architecture/affected gates и собрать Windows artifact; подтвердить GLM regression.
- [ ] **GPT-07** После разрешения runtime пройти живую приёмку: consent, доступная GPT-модель, tool loop, подтверждённый путь расхода плана без скрытого API fallback.
- [ ] **GPT-08** Проверить fork-safe update, профиль/миграцию, revoke/restart и rollback; принять один поддерживаемый продукт.

### Existing implementation assignments

Root fills this table before starting implementation agents and clears completed
assignments. A reviewer is read-only. Shared schemas, exports, package manifests/lockfile,
platform contracts and cross-package wiring stay with root unless explicitly reassigned.

Wave 1 (2026-10-12/13) is complete: all eight exclusive-path assignments were implemented,
independently reviewed (8/8 passed, no fix round triggered) and integrated by root; the
rows were cleared per the policy above and the evidence lives in the entry below and the
wave-report artifact. All reassigned files, including `DOCUMENT-HOSTS.md` and
`IMPLEMENTATION-PLAN.md`, returned to root ownership at integration.

Wave 2 (2026-10-13) is complete: all five exclusive-path assignments were implemented,
independently reviewed (5/5 passed) and integrated by root; one mid-wave lint gate failure
was repaired within the W-04 owner's paths before the final green re-run. All reassigned
paths returned to root ownership at integration. The active checklist now has 56 unique
items plus parked N-01.

| Item IDs   | Agent / role         | Exclusive paths                       | Depends on         | Reviewer / result                                |
| ---------- | -------------------- | ------------------------------------- | ------------------ | ------------------------------------------------ |
| (wave 4) | To be assigned by root before Wave 4 starts (build-only release work) | — | Frozen Wave 3 tree | — |

## A — Canonical fork and architecture

- Branch policy: `master` is the default/accepted-version branch; `dev` contains all current work. Local/origin `main` and `research/spec-harness` were renamed preserving their commits. No extra permanent branches; merge upstream into `dev`, then fast-forward `master` after acceptance.
- Branch acceptance 2026-10-12: GitHub API rename preserved base `aac47556` and development tip `bec597d5`; `git branch -vv` and `git ls-remote --heads origin` show exactly `master`/`dev`, GitHub default and `origin/HEAD` are `master`. Freshness now resolves the remote default instead of skipping a removed `origin/main`; real `--no-fetch`, syntax, typecheck, lint (67 warnings / 0 errors) and changed architecture checks passed. Active runtime/profile unchanged.

- [x] **A-01** One product, three context lanes, native-host scope and runtime gate are documented. Evidence: implementation plan and team prompt; user clarification 2026-10-12.
- [x] **A-02** Fork has origin/upstream and migrated source modules. Evidence: baseline `bfede821`; [refactoring record](REFRACTORING.md).
- [x] **A-03** Build and start are separate; start rejects changed sources/output and does not start Vite. Evidence: `scripts/spec-harness-production.mjs`, `scripts/test/spec-harness-production.test.mjs`.
- [x] **A-04** Review current call graph and ownership across Main/Host/services/CLI, including existing window-scoped Hosts, remote identity and document gateway; document any unresolved collision. Do not flatten all legitimate owners into one global Host. Evidence: [ARCHITECTURE-REVIEW.md](ARCHITECTURE-REVIEW.md) (Impl F, Wave 1): owners table with path:line citations pinned at `aa8236cf`, collisions C1–C4 and missing boundaries B1–B5 each with status and smallest proposed owner; independent reviewer verified citations resolve; root read and accepted 2026-10-13. Design review only — no live acceptance claimed.
- [x] **A-05** Complete requirement-to-source/test mapping and native screen-element inventory for the current fork. Reconcile inherited overlay requirements; no old-only behavior claimed as current. Evidence: [SCREEN-INVENTORY.md](SCREEN-INVENTORY.md) (Impl H, Wave 1): 110 element rows across desktop shell, conversation controls, document-host pane and launcher sections, each with location/visibility/action/owner/persistence/error/acceptance columns; Appendix B reconciles inherited `Z-*`/`S-*`/`ZR-*` registry (S-01..S-57 explicitly non-current); live acceptance cells stay open; independent reviewer verified citations; root spot-checked and accepted 2026-10-13.

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

  REVIEW-2 (2026-10-14, independent review of candidate 2e52f341, docs/spec-harness/RENDERING-PERFORMANCE-REVIEW-2.md): 8 findings — real timeline cache invalidation (HIGH), inactive-discussion PiP visibility (HIGH), SessionPane owner-document visibility, residual hidden token-frequency scans, highspeed output identity, hidden geometry/reveal coverage, batch oracle edge cases, evidence completion. All previously reported P measurements are INVALIDATED pending repairs and re-measurement; P-02/P-03 acceptance stays open.

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
- [ ] **T-07** Native panes never mount the desktop Root/SessionPane and never spawn eager diff/highlight workers; pane conversations render through the frozen compact surface only. Evidence: ADR 001 pre-live-use expectation; DOCUMENT-HOSTS.md:70 (Wave 2 requirements triage).
- [x] **T-08** Bounded-tool policy is stated explicitly in the specs: bounded document tools do not constrain other agent filesystem/MCP tools, and no global single-writer claim is made without a separate policy for them. Evidence: the explicit policy paragraph in the DOCUMENT-HOSTS.md verification section ("Наличие bounded document tools не ограничивает автоматически сторонние filesystem/MCP инструменты агента; не заявлять глобального единственного writer без отдельной политики этих инструментов") and ADR 001:30; root verified both 2026-10-13 — documentation-only criterion already satisfied.
- [ ] **T-09** Gateway shutdown runs as a bounded phase of Host shutdown: in-flight pane operations drain or fail visibly; no orphaned helper process or listener. Evidence: DOCUMENT-HOSTS.md:68.
- [ ] **T-10** The pane preserves drafts and focus during streaming, including AskUserQuestion rendered through the shared clean ZCODE answer builder. Evidence: DOCUMENT-HOSTS.md:70.

## O — Word and Excel

- [x] **O-00** Word native range/read/locate/comment/tracked replacement and refusal fixtures passed: 8 native + 3 UI checks. Evidence: `Test-Office-Adapters.ps1 -HostName word`, baseline `bfede821`; UI checks use a test command facade.
- [x] **O-01** Excel native range/read/formula/value/freshness/refusal fixtures passed: 7 native + 3 UI checks. Evidence: same fixture with `-HostName excel`; not proof of a live CLI/model loop.
- [ ] **O-02** Word GUI ribbon/ПКМ/selection/thread UX, anchored duplicate-text handling, external edits, comments and revision tracking restore pass with required API checks. Unsupported rich-content replacement refuses; no false atomic-CAS promise.
- [ ] **O-03** Excel GUI menu/selection/thread UX and apply pass for values and invariant formulas; native target identity, dimensions, limits and protection/merged/array/spill refusals hold through real user changes.
- [ ] **O-04** Both hosts share familiar ZCODE controls/themes while preserving host UX, keyboard/IME/focus/accessibility and narrow layout. Every required screen control has an ID, state/action/capability/error description and verification.
- [ ] **O-05** Real Word and Excel agent loop reads live unsaved content, proposes a bounded edit, applies once on user action, verifies receipt, refuses stale/switched/closed targets and recovers after pane reconnect.
- [ ] **O-06** Adapters operate on open documents only through the application API; no adapter path edits an open DOCX/XLSX/DWG by filesystem means (negative constraint across hosts; the AutoCAD analog of C-03's no-LISP rule). Evidence: IMPLEMENTATION-PLAN.md:56; DOCUMENT-HOSTS.md:20.
- [ ] **O-07** Persisting document identity via Office settings keeps pane-side metadata inside the document consistent with gateway bindings across reopen, verified for both hosts. Evidence: DOCUMENT-HOSTS.md:22.

## C — AutoCAD

- [x] **C-00** AutoCAD 2024 net48/x64 plug-in compiled against installed SDK; 14 CoreConsole native checks passed. Evidence: `prototypes/autocad-preview/SpecHarness.AutoCAD.csproj`, `Test-AutoCAD-Adapter.ps1`.
- [ ] **C-01** Actual NETLOAD/SHDOC/WebView2 deployment, docking/floating palette, focus and selection/cancel pass without changing global SECURELOAD or modifying another application's installation.
- [ ] **C-02** Real GUI verifies document activation/navigation epochs, bounded queue, command context/DocumentLock/transaction, explicit INSUNITS/WCS/OCS, native identity and setLayer refusals. No stale drawing is activated automatically.
- [ ] **C-03** Native CLI agent loop reads/locates selected geometry, proposes setLayer and applies once with verified result; no arbitrary LISP/command-string executor is substituted for supported tools.

## R — One release, build, profile and docs

- [x] **R-01** Root plan/prompt/checklist distinguish implemented, fixture-verified and live-unverified work. Earlier Office/preview design documents point to current SRS and are labeled historical.
- [x] **R-02** After implementation, focused tests, root typecheck, lint, changed architecture gate, affected pre-push checks and production receipt validation pass on the final frozen revision. Document prior failures/warnings and checker coverage honestly. Evidence (2026-10-13, frozen tree at 9a001156+fix): typecheck/lint/architecture exit 0 (Wave 4 gates); pnpm verify:pre-push exit 0 after root fixed the one real failure it caught — Wave 2 P-03 clock guard broke two pre-existing highspeedFooterExpiryClock regression cases whose fake clock was static (now: () => 0); fixed by teaching the fakes to advance while preserving the no-catch-up-before-expiry contract; production receipt validateProductionBuild() = VALID.
- [ ] **R-03** Complete Electron/native/runtime preparation and fresh-machine build/install/run instructions using pinned toolchains; verify no Vite, temporary HOME or active-runtime source injection is used.
- [ ] **R-04** Fork uses that machine's normal ZCODE profile, project list and local authorization without shipping credentials. Shared-profile concurrent start is refused/handled; schema/version/fallback data recovery documented and verified with disposable profile copies first.
- [ ] **R-05** One supported launcher/shortcut and original upstream Z icon (including its two slits) appear correctly in first/child windows, Alt+Tab, taskbar/pinning. User-provided replacement art is a later optional input.
- [ ] **R-06** Document every current screen element and workflow with requirement → control → owner → test/evidence links. Build/update/upstream-merge and another-machine setup instructions match actual scripts.
- [ ] **R-07** Full integration is independently reviewed and live release gates pass or user explicitly narrows scope. Retire obsolete overlay launchers/builds within an agreed list; keep user data and project files. Official installer remains fallback; no parallel supported legacy product.
- [ ] **R-08** Implement one root `Build-Installer.cmd` over upstream Windows x64 electron-builder/NSIS bundling. Full and verified-cache rebuild paths prepare/build/package without launching/installing/publishing; fail clearly and print artifact path, upstream/fork version, source revision and SHA-256. Pin CLI/native assets; distinguish desktop package from Office/CAD setup.
- [ ] **R-09** Packaged EXE enables accepted fork functionality without source-launcher environment variables. Verify installer/runtime closure, original icons, install/upgrade/uninstall and normal-profile reuse using owned isolated environments. No shipped credentials/dev cache/certificates, and no profile deletion.
- [ ] **R-10** Define and verify fork-safe update behavior: automatic official update cannot silently replace our changes; reviewed upstream source update/rebuild is documented. Official installer is an explicit fallback; profile-schema/data restoration is separate from application reinstall.
- [ ] **R-11** Each adapter README (Word/Excel/AutoCAD) lists per-capability status and actual acceptance evidence, kept current with each accepted wave. Evidence: DOCUMENT-HOSTS.md:76.

## U — Desktop UX (user requests 2026-10-13)

- [x] **U-01** (live GUI acceptance by the user 2026-10-13: «перестановка окон работает») Layout mode «Документ в центре»: the LEFT navigator (both states: file tree and projects/tasks) stays; the CENTER chat and the RIGHT tabs container (the whole existing container: Open doc, Side conversation, Review, Terminal, Browser) swap places — with Open doc selected the document is in the center, with Browser the browser is. Accessible icon toggles «Документ в центре» / «Чат в центре» and back. In the new mode the document initially takes most of the work area; widths adjustable; mode and sizes persist per workspace. The divider always sits between document and chat; drag and keyboard control follow the actual placement (the divider is currently embedded before the right pane — pane order, divider and control-button placement must be coordinated; boundary: inner pane group at packages/ui/src/app-shell/WorkspaceShellLayout.tsx:2491). Collapse/expand buttons keep their meaning («Развернуть документ» hides the chat; «Вернуть чат» returns it to the chosen side) with matching arrows/tooltips. The toggle preserves open tabs, unsaved document text, chat draft, scroll and the running session; Windows window controls stay top-right; detach/return keep working. Acceptance: open document with unsaved edit + chat draft → several toggles, width change, expand document, return chat, restore after reopen. Concept: user request 2026-10-13, corrected and refined same day.
- [ ] **U-02** ПКМ on a file or folder row in the left project tree offers «Добавить метаданные»: a document/folder passport (назначение, тип, источники, связи, методики — ссылки, не копии) stored in the workspace `.harness/project.json` keyed by normalized path; rows with metadata show a badge; edit reopens the passport; corrupted storage degrades to a visible error. Concept: проектный харнесс design discussion (per-level metadata, references over copies). Optional scope — implement only as a clean solution.

## U (continued)

- [ ] **U-03** (implemented 2026-10-13, live GUI acceptance pending user) Thorough window/panel composition
  LIVE REGRESSION 2026-10-14 (build 9fe78d6c): in document-center mode (doc center, chat right) the middle divider size control still changes size in the WRONG direction — the wave-6 fix covered one path (drag after container resize) but not all (keyboard/arrow path or a second code path suspected). Wave 7 v5 brief mandates re-verifying BOTH drag and keyboard in BOTH arrangements and after resize, finding the missed path, fixing with tests. разведка: every pane (navigator, chat, tabs container, detached/project windows), its owner, sizing/divider math, persistence and interactions (swap, expand/collapse, detach/return, project windows) documented in docs/spec-harness/WINDOW-LAYOUT.md; the user-reported inverted drag direction after window resize in swapped mode is traced to its cause and fixed with focused tests. Concept: user request 2026-10-13 («проведи более тщательную разведку работы с окнами… как они между собой компонуются»).
- [x] **RETIREMENT-2 (user decision 2026-10-13)** The move-to-separate-OS-windows feature is rolled back for now («никаких Move chat to window etc.»): detach chat/panel to window, Return to Main, Open project/conversation in window, the window-role toolbar, specProjectWindows/specDetachedPanels machinery and the ZCODE_SPEC_HARNESS_WINDOWS gate are removed. Not a single-commit revert — the feature predates the wave history; removed as a feature with history preserved. W-01..W-05 items retire open; the in-app layout (swap, expand, tabs) is unaffected and stays. Clarification 2026-10-15: the historical retirement remains recorded; the newly requested U-06/U-07 plan permits a fresh, narrow native chat/discussion window mechanism. It does not restore the removed implementation wholesale. W-01..W-05 supply only the transfer/lifecycle/geometry regression cases referenced by the new plan; all other retired scope stays retired.
- [x] **RETIREMENT (user decision 2026-10-13)** All AutoCAD and Office integration code is removed from the product for now («убери весь код который связан с автокадом и офисом — пока работаем только над функционалом ZCode»): prototypes/autocad-preview, word-preview, excel-preview, the office adapters/Test-Office-Adapters.ps1 in prototypes/document-host, and with them their only consumers — the document gateway/SDK/pane stack (packages/desktop/src/host/documentGateway*, packages/ui/src/document-host) and their tests/docs references. Everything stays recoverable in git history. O-*/C-* items and N-01 are retired-open; the in-app Markdown document workflow (D-*/U-*) is NOT office-related and stays.

- [ ] **U-04** (implemented 2026-10-14, live pending user) Unified position-independent toggles:
  REFINED 2026-10-14 (user): the model is ROLE-based, not region-based. In every arrangement there is a PRIMARY region (center, wide) and an AUXILIARY region (right, narrow); the swap exchanges the ROLES of the chat and the tabs container. Exactly ONE role-based toggle «Скрыть/Показать боковую панель» lives in the primary caption and hides/shows whichever region is currently auxiliary (tabs pane in chat-center, chat in document-center); the primary then takes the full width. Navigator stays a root toggle. U-05 invariant unchanged and still mandatory. chat visibility is ONE root-level toggle (stable place in the tabs-container caption, neutral chat-bubble glyph, labels «Скрыть чат»/«Показать чат», keyboard shortcut analogous to the navigator toggle; hidden chat collapses to full pane width in BOTH arrangements); the tabs container keeps its own root toggle with a neutral panel glyph; the swap toggle stays geometry-only. The position-dependent controls (⤢ in the document header, «Show main chat» caption arrow, PanelLeft/Right glyphs in the side-pane toggle) are merged/retired; toggle semantics never depend on documentCenter. Concept: user request 2026-10-14 («тоглов панелей уже много и они сильно зависят от перемещения окон»).
- [ ] **U-05** (implemented 2026-10-14, live pending user) No dead layout states: in EVERY reachable combination of {sidebar visible, tabs-pane visible, chat collapsed, swap mode} at least one visible affordance to restore each hidden region (and window controls) must exist. Reported live 2026-10-14: some toggle combination hid ALL panes with no way back (suspected «Развернуть документ» + side-pane hide: the restore cluster lives only in the pane caption, which is unmounted when the pane is closed and the pane collapses to 0px, AnimatedSidePanePanel.tsx:989, WorkspaceShellLayout.tsx:2449/1918). Acceptance: a test enumerating all 16 combinations asserts a restore path for each hidden region in every state; the user reproduces nothing dead in the installed EXE.
- [ ] **U-06** (требования уточнены 2026-10-15; реализация desktop и живая приёмка ОТКРЫТЫ) Дискуссия документа открывается в настоящем немодальном окне ОС, свободно перемещается за границы документа и ZCODE между мониторами; поддерживает изменение размера, сворачивание и положение поверх обычных окон. Сохраняются workspace/документ/обсуждение, черновик, вложения, выделение, поиск, прокрутка и та же native session. Return и крестик ОС безопасно возвращают содержимое. Desktop использует отдельное вспомогательное окно Electron с подключением к существующему Host; Document PiP и обычное создание нового окна проекта не являются desktop-механизмом. Это заменяет прежнее ограничение PiP-only/no-Main и прежнюю отметку «реализовано» для desktop. Web PiP сохраняется отдельно при наличии поддержки. План, владельцы, протокол передачи и критерии завершения: [FLOATING-WINDOWS-REFACTOR-PLAN.md](FLOATING-WINDOWS-REFACTOR-PLAN.md). Пользовательская приёмка: раздел 3, пункты 3.1–3.12 в [ACCEPTANCE-CHECKLIST.md](ACCEPTANCE-CHECKLIST.md).
- [ ] **U-07** (требования уточнены 2026-10-15; реализация desktop и живая приёмка ОТКРЫТЫ) Основной чат использует тот же механизм вспомогательных окон ОС, что U-06. Чат и дискуссии остаются вынесенными одновременно: минимум приёмки — один чат и две дискуссии документов. Общего desktop PiP-слота нет. На одну логическую поверхность приходится одно окно; повторное открытие показывает его. Переносимая форма имеет одного отправляющего владельца; правила существующих независимых наблюдающих поверхностей сохраняются. Скрытие/сворачивание/крестик главного окна при наличии отдельных окон сохраняет Host и управление; Return восстанавливает исходное место, явный выход использует штатное завершение. Перемещение не создаёт новый Host, агента или модельный запрос и не меняет provider/auth/protocol. Старые project-window команды и Office/CAD не возвращаются. Приёмка: раздел 4, пункты 4.1–4.10 в [ACCEPTANCE-CHECKLIST.md](ACCEPTANCE-CHECKLIST.md), проверки сохранности/ошибок U-06 и [план рефакторинга](FLOATING-WINDOWS-REFACTOR-PLAN.md).
- [ ] **U-08** (implemented 2026-10-14, live pending user) Open doc: .txt files are first-class (listed in the workspace document picker, open via file links and the picker with the same view/draft/CAS-save semantics as .md), and the document picker becomes a searchable combobox: clicking the file row opens a dropdown with an inline filter field (magnifier icon); typing in the row filters the list immediately (keyboard-first); arrows navigate, Enter opens the top match, double-click on a row opens it directly, Esc closes; filter is case-insensitive over relative paths. The global project-search icon stays a separate action. Concept: user request 2026-10-14 («txt файлы тоже в open doc… не только раскрывающийся список, но и поиск — через иконку или клавиатурой прямо в строке, двойной клик???») — design resolved to the combobox pattern above.
- [ ] **U-09** (implemented 2026-10-14, live pending user) Open doc word wrap: long lines wrap to the pane width in BOTH the read-only rendered view (md/txt) and the edit textarea — no horizontal scrollbar for prose; code blocks follow DESIGN.md conventions if any. (User report 2026-10-14: «сделать в open doc реализацию переноса строк когда показываешь txt or md в режиме просмотра и редактирования».)
- [ ] **U-10** (implemented 2026-10-14, live pending user) REGRESSION (user 2026-10-14, live on the installed build): Edit ↔ View (глаз) toggling breaks rendering and the Discussions panel stops opening; the pane recovers only after closing the document tab and reopening; the Discussions mode appears to be gone entirely. Criterion: with a document and an open discussion, switching Edit ↔ View repeatedly keeps the discussions aside rendered, the Discussions toggle available in both modes, no error state, no unmount, no reopen needed. Suspects: wave-6 detach-UI cleanup or wave-7 pane-header refactor — identify the breaking change (git log/blame on SpecDocumentPane.tsx) and fix at the cause with focused tests.
- [ ] **U-11** (implemented 2026-10-14, live pending user) REGRESSION (user 2026-10-14): only one file ever opens; choosing another file from the pane-header picker (and via + → Open doc) does nothing. Criterion: picking a different file loads it (view + per-path draft), the picker reflects the current document, the + menu re-activates the tab with the picker. Suspects: value/option path normalization mismatch (absolute vs relative) in the always-rendered select (21221728) or an open() guard no-op — find the cause, fix, cover with tests.
- [ ] **U-12** Clicking «+» in the side pane must open a NEW document tab next to the existing ones (multi-tab Open doc: each + adds a tab with the document picker; tab titles reflect the opened document; per-path drafts preserved; closing a tab keeps others). Today the + silently reuses the single «Open doc» tab and, with a document already open, appears to do nothing (user live report 2026-10-14, build d67a52cd). This supersedes the earlier single-tab product note.

- [ ] **U-13** The document picker displays CLEAN workspace-relative paths: forward slashes, no leading «./», no absolute-drive or workspace-folder prefix, no duplicated repo segments; the file name is the primary text and the directory part secondary (muted); the search filter matches over exactly this displayed form. Live report 2026-10-14: the picker currently shows strange paths in the dropdown (user screenshot) — diagnose the actual displayed string source and fix the display + filter together.

- [ ] **U-14** The picker delete (корзина) actually deletes the document (visible confirmation, error state on failure, no silent no-op); disabled state explains why if deletion is not allowed.
- [x] **U-15** Accepted 2026-10-15 after replacing the failed tab-order heuristic from 4413f4f6. Picker IO follows the focused conversation binding or matching active session workspace, never the ZCODE launch root. Product GUI with a separate project listed only its own document; real A/B filesystem and store-focus tests passed. Russian acceptance 10.2 is updated; stale/remote/unresolved session scopes fail closed.

### U-06 / U-07 bounded implementation gates (plan dated 2026-10-15)

- [ ] Contract gate: root records current SHA, isolated worktree, exclusive paths, stable surface identity, single state owner, sender fencing, versioned UI payload, config owner, return target and cleanup rules before source implementation.
- [ ] Native window gate: auxiliary windows attach the existing local/remote Host scope with desktop-continuous; zero new Host/session/agent/model calls on Detach/Return; arbitrary sender/scope/URL rejected.
- [ ] State and fault gate: one transferred-surface writer; stale callbacks rejected; IME/pending attachments handled without loss; delayed ACK, double-open, X, crash, missing session and missing return target covered.
- [ ] Geometry and simultaneous-windows gate: 1 chat + 2 discussions; both layouts; multiple monitors, negative coordinates, mixed DPI, display removal, reachable restore, main hide/close policy.
- [ ] Regression gate: focused tests, typecheck, lint and changed architecture checks; prior failures separated; independent reviewer checks stable integrated diff and rechecks repairs.
- [ ] Live gate: user acceptance 3.x/4.x plus paired renderer metrics on an explicitly permitted isolated environment; no source/mock-only closure. Closed runtime gate keeps this item open.
- [ ] Delivery gate: exact candidate SHA, changed responsibilities, evidence and open risks reported; merging, packaging/install/launch await their own applicable authorization.

Planning evidence 2026-10-15 (source baseline e181522b): root owns the refactor
plan, ADR 002 and these checklist edits. Three read-only architectural options and
independent adversarial review informed the plan. PiP-only/shared-slot desktop
requirements are superseded; RETIREMENT-2 is narrowed only for this new mechanism.
No implementation/GUI acceptance is asserted. Runtime gate remains CLOSED.

- [ ] **U-16** Live updates visible in the UI: the user wants to see real-time agent/subagent/workflow progress (what is running, what changed, intermediate results) in the conversation/task surface instead of asking for status. Record exact screenshot context; design a live progress feed/status panel showing current subagent activity, tool calls in flight, and recent completions, updating as work proceeds (no polling by the user).

- [ ] **U-17** The PiP-unavailable affordance renders compactly: on desktop the «вынести в окно» control must be a small disabled icon with a short badge/tooltip, NOT a long visible text button explaining Electron/PiP limitations (user screenshot 2026-10-15: long Electron explanation shown as a button bottom-right). Hide the explanation behind hover/aria; keep the honest reason accessible but visually compact.

## N — Parked outside this release

- [ ] **N-01** Compact agent capability/reference map for Word/Excel/AutoCAD (object → operation → limits → minimal example; versioned startup index plus lazy resources). Intentionally outside this checklist's release scope as a separate user request. Evidence: IMPLEMENTATION-PLAN.md:277-282.

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

2026-10-12 P0 reconciliation (workflow run `dwfrun-0fee7d67-aaa0-45b0-a995-59973dbae052`,
read-only investigators; no source, profile or runtime change): workspace freshness check
exit 0 at `aa8236cf` (clean, in sync with origin/dev); 37 open checklist items mapped to
source and tests with live-gate classification; preliminary A-04 review recorded 4 ownership
collisions and 5 missing boundaries (full document is Impl F); D/W/P/T investigations
recorded 14 suspected defects with path:line evidence (highest: a child renderer crash
during the Return handshake strands the detached panel,
`packages/desktop/src/main/specDetachedPanels.ts:130-149/248-260`). Toolchain decisions are
recorded in the root-state table above. The exclusive-assignment table was filled from the
reconciliation plan before implementation agents started; A-04/A-05 stay open until the
Impl F/Impl H documents land and pass independent review.

2026-10-13 Wave 1 integration (workflow `dwfrun-0fee7d67-aaa0-45b0-a995-59973dbae052`,
built on `aa8236cf`; implementation agents never committed):

```text
ID(s): W-01, W-02, W-03 (halves), D-01, D-04 (both halves), T-04 (gateway half), P-01
       (isolated half), W-04 (fixture half), T-02..T-05 (design halves), A-04, A-05
Revision / affected files: 8 tasks within their exclusive paths — 15 modified + 7 new
       files (see the commit); no writes outside the assignment table (root diff check)
Check command or manual scenario: pnpm exec vitest run over the 7 new/changed suites;
       pnpm typecheck; pnpm lint; pnpm architecture:check --changed (workflow world.run)
Result and relevant counts: suites 7 files / 52 tests passed (29.3 s, node 24.13.1);
       typecheck exit 0; lint exit 0; architecture:check --changed exit 0
Independent review: fresh read-only reviewer per task, 8/8 passed, no fix round;
       full verdicts in the wave-report artifact
Remaining limits / runtime gate: all live gates stay closed (GUI, model, renderer
       profiling, install, Office/CAD); no item below claims live acceptance
```

Per-item advancement (all remain `[ ]` unless noted): W-02/W-01 — child renderer crash
during quiescing/reattaching now destroys the child and restores the source pane instead of
the close→reattach→15 s-timeout loop, source stays closable, stale ACKs after crash are
inert (`specDetachedPanels.test.mjs` regressions). W-03/W-01 — detach-prepared and
reattach-quiesced ACKs now wait for the pane's explicit cleanup-completion signal; the
50 ms `afterPanelCleanup` timer is no longer a correctness bound
(`specPanelCleanupSignal.test.ts`, 3 tests). D-01 — a missing persisted path renders a
visible recovery state that clears the stale path while retaining the draft
(`specDocumentPaneRecovery.test.ts`, 4 tests). D-04 — delete-refusal reasons derived from
`canRemove` and shown (Impl B); gateway half retracts externally deleted sessions from
persisted bindings on the runtime not-found signal, `deleteSession`-accepted removes and
persists, no resurrection on reopen (4 new cases, `documentGateway.test.ts` 11 total).
T-04 — durable binding restore across gateway restart fixture-covered; failures stay
visible. P-01 — isolated half delivered: `scripts/perf/v4-replay-fixtures.mjs`,
`scripts/perf/run-render-baseline.mjs`, `v4ReplayBaseline.test.ts` (13 tests) with p50/p95
recorded in [RENDERING-BASELINE.md](RENDERING-BASELINE.md); renderer traces and
native-vs-fork comparison stay live-gated, so P-01 stays open. W-04 — coordinator-level
fake-Electron coverage (roles/titles, locate/dedupe-show, return-without-spawn, close-view
vs Quit, duplicate refusal) in `specProjectWindows.test.mjs`; root added the vitest unit
include for it; `main/index.ts` close-predicate seam and visible-label GUI acceptance
remain. T-02..T-05 — design halves frozen in [DOCUMENT-HOSTS.md](DOCUMENT-HOSTS.md)
(three-lane binding model, gateway-binding session marker, no retroactive MCP,
one-composer transfer/observation policy, `conversationRowsRangeV4` pagination, reconnect
anchor-clearing contract) with IMPLEMENTATION-PLAN.md product rules updated; code halves
are derived from this freeze. A-04/A-05 accepted `[x]` above. Root additions at
integration: `vitest.config.ts` unit include lists `specProjectWindows.test.mjs` (the
W-04-flagged root follow-up); stray `nul` artifact removed. The requirements mapper found
7 unmapped requirements pending root triage into new checklist IDs.

2026-10-13 pnpm settings migration (root): `pnpm.overrides` (react/react-dom 19.2.7) and
`patchedDependencies` (5 patches) moved from `package.json` into `pnpm-workspace.yaml`
with a rationale comment — pnpm 10.33.2 reads them only from the workspace file.
Verification: `pnpm install --frozen-lockfile` completed in 21.7 s with `pnpm-lock.yaml`
unchanged (`git diff` empty); installed react/react-dom resolve 19.2.7; root
`pnpm typecheck` passed. Implementation agents may run frozen installs but never
lockfile-refreshing commands.

2026-10-13 Wave 2 integration (workflow `dwfrun-137a77af-0e56-45b0-974d-d065549313d6`,
base `d5ad7ea2`; implementation agents never committed):

```text
ID(s): P-02, P-03 (code halves), T-02 (code half), T-03, T-04 (code halves), W-04 (seam)
Revision / affected files: 16 files within Wave 2 exclusive paths (root diff check);
       stray `nul` artifact removed
Check command or manual scenario: pnpm exec vitest run over 6 new/changed suites;
       node --test prototypes/document-host/pane.test.mjs; pnpm typecheck; pnpm lint;
       pnpm architecture:check --changed
Result: 32 vitest tests passed (11.5 s, node 24.13.1); pane tests 6/6; final gates
       typecheck/lint/architecture all exit 0 (one mid-wave lint failure was repaired
       within the W-04 owner's paths before the final green re-run)
Independent review: fresh read-only reviewer per task, 5/5 passed
Remaining limits / runtime gate: P-02/P-03 acceptance needs P-01-agreed thresholds plus
       live worker-count/memory evidence; T-02/T-03/T-04 and W-04 GUI/model halves stay
       behind the closed runtime gate — no item claims live acceptance
```

Per-item: P-02 — diff/highlight is now lazy: no worker spawned and no main-thread shiki
initialization before the first diff request (`lazyDiffsWorkerPool.ts` new,
`DiffsWorkerPoolProvider.tsx`, `diffsWorkerBudget.test.ts` extended); baseline harness
re-run without regression vs RENDERING-BASELINE.md. P-03 — share-surface rebuilds gated
on an active share surface with the cached navigator builder; idle focus/visibility
toggles no longer bump `liveNowMs` into an O(rows) render-unit rebuild
(`SessionPane.tsx`, `highspeedFooterExpiryClock.ts`; tests
`sessionShareProjectionGate.test.ts`, `highspeedFooterExpiryClockGate.test.ts`); the
resize remeasurement path is intentionally unchanged (trace-gated). T-02 —
gateway-binding session marker set/persisted/restored, not forgeable through command
payloads, document MCP still injected only into gateway-created sessions
(`documentGateway.test.ts`, 15/15). T-03/T-04 — pane reconnect clears stale
quotes/selection/contextPending, old-history pagination via the `conversationRowsRangeV4`
range target, absent-with-reason affordances, visible retraction state (`pane.js`,
`client.ts`; `pane.test.mjs` 6/6, `client.test.ts`). W-04 — close-view predicate extracted
as a minimal Main-owned seam with close-view vs explicit-Quit fixture cases
(`main/index.ts`, `specProjectWindows.test.mjs`); `specDetachedPanels.test.mjs` untouched
and green.

Requirements triage (root, from the read-only researcher's 8 findings): created T-07,
T-08, T-09, T-10, O-06, O-07, R-11 and parked N-01 above; the earlier "7 unmapped"
count is superseded by this verified list.

2026-10-13 Wave 3 integration (workflow `dwfrun-8f213d71-286d-4112-a0bb-28e507c9ee22`,
base `778fd340`; implementation agents never committed):

```text
ID(s): D-02, D-03, D-05, T-07, T-09, T-10 (fixture/code halves), O-02..O-05
       (fixture-depth halves), R-11 (doc half)
Revision / affected files: 21 files within Wave 3 exclusive paths (root diff check);
       stray `nul` artifact removed
Check command or manual scenario: pnpm exec vitest run over 9 spec-document/host/gateway
       suites; node --test paneStructureGuard.test.mjs and pane.test.mjs; the Office task
       ran Test-Office-Adapters.ps1 on owned disposable Word/Excel fixtures (reviewer
       re-ran it); wave gates pnpm typecheck / lint / architecture:check --changed
Result: 57 vitest tests passed, 1 intentionally skipped (15.0 s, node 24.13.1);
       structural guard 1/1; pane tests 8/8; final gates all exit 0
Independent review: fresh read-only reviewer per task, 6/6 passed, no fix round
Remaining limits / runtime gate: every live half stays open — GUI/model acceptance,
       renderer profiling, real Office/CAD GUI, install; no item claims live acceptance
```

Per-item (all stay `[ ]` — live halves remain): D-02/D-03 — payload-level lane separation
and empty-draft composer-before-Send with zero model input at the sendCommand boundary
(`specDiscussionLanes.test.ts` 5/5); Open-doc/Add-in-side-chat for new and existing
parents, capability-derived disabled reasons, byte-exact fragment selection
(`specDocumentEntryPoints.test.ts` 4/4 + byte cases). T-07 — structural guard test fails
on any desktop-Root/worker import in the pane surface (`paneStructureGuard.test.mjs`).
T-10 — streaming keeps draft/caret/focus; AskUserQuestion via the shared builder
(`pane.test.mjs` extended, 8/8). T-09 — gateway shutdown is a bounded Host phase:
in-flight ops fail visibly, helper terminated, port released (`documentGateway.test.ts`
extended). D-05 — expand/restore, hide≠stop/delete, CAS save + reload restore, external
conflict with recoverable Reload, project-collapse persistence, identity-keyed
(`specDocumentPanePersistence.test.ts`, `specProjectCollapsePersistence.test.ts`, 12
cases). O-02..O-05 — real-Word/Excel fixture depth: anchored duplicates, external-edit
refusal (+ adapter fix for collapsed tracked ranges), comments and revision-tracking
restore, table/rich-content refusal; Excel sheetId identity across renames/inserts,
1000-cell limit, protected/merged/spill/legacy-CSE refusals, verified receipts;
fixture-mode control IDs/aria, theme toggle, Enter/Shift+Enter/IME, 320px viewport;
one-shot apply with receipt, duplicate/stale refusal, remount clears proposals
(Test-Office-Adapters.ps1 + office-native-*.mjs; counts in the adapter READMEs).
R-11 — per-capability status tables in all adapter READMEs with commands, counts and
path:line citations. Full detail per task: wave3-report artifact.

2026-10-13 Wave 4 integration (workflow `dwfrun-6725beb9-22b3-48ac-859a-0c1293754b8a`,
base `f4456188`; implementation agents never committed):

```text
ID(s): R-08, R-10, R-03 (build-only), O-06, O-07, T-05 (fixture halves)
Revision / affected files: Build-Installer.cmd (new), docs/spec-harness/README.md,
       prototypes/document-host office tests + READMEs, documentGateway.test.ts,
       + 8 tracked node-repl-host dist-types .d.ts refreshed by the verified build
Check command or manual scenario: Build-Installer.cmd full and validated-cache paths
       (real NSIS build, artifact path + versions + revision + SHA-256 printed, nothing
       launched/installed/published); pnpm exec vitest run documentGateway.test.ts;
       node --test office-adapter.test.mjs; wave gates typecheck/lint/architecture
Result: installer built with hash receipt both paths; documentGateway 23/23; office
       adapter guard/round-trip 14/14; gates all exit 0
Independent review: fresh reviewer per task, 2/2 passed
Remaining limits / runtime gate: installed-EXE and auto-update live confirmation (R-09),
       real Word/Excel O-06/O-07 runs and T-05 live end-to-end stay closed; R-02 stays
       open pending the final frozen-revision pass (pnpm verify:pre-push + production
       receipt) at root's closing step
```

Per-item: R-08 — wrapper with full + validated-cache fast rebuild; prints artifact path,
fork/upstream version, revision, SHA-256; never launches/installs/publishes. R-10 —
packaged auto-update compiled off (ZCODE_AUTO_UPDATE=0 pin + preflight fail-closed;
verified via build-time-config resolution and initAutoUpdater), placeholder feed inert,
upstream merge/rebuild + official-installer fallback documented. R-03 — pinned-toolchain
preparation/build/install/run instructions incl. winCodeSign cache note, no-Vite /
no-temp-HOME / no-runtime-injection claims code-cited. O-06 — static fs-write guard
(self-checked) + external file-write refused-as-stale fixtures both hosts + AutoCAD
analog README rows. O-07 — binding-id round-trip through persisted Office settings across
reopen + gateway-side same-bindingId reopen across restart. T-05 — allowed-origin/pairing
rejection, canonical-workspace key, capability narrowing after disconnect (stale
generation rejected), backpressure/saturation/drain/terminate, durable deletion across
restart (documentGateway.test.ts 23/23). Detail: wave4-report artifact.

2026-10-13 R-02 final frozen pass (root): pnpm verify:pre-push initially failed on 2
pre-existing highspeedFooterExpiryClock.test.ts regression cases — the Wave 2 P-03 guard
(now() < nextExpiryMs skip) is product-correct, but those cases injected a static
now: () => 0 clock so the boundary could never elapse. Root fixed the fakes to advance
time (Chinese cause comment in the test) and added a no-catch-up-before-expiry assertion,
preserving both the regression intent (footer needs no extra message after foreground
return) and the P-03 bound. Re-run: both clock suites green; pnpm verify:pre-push exit 0;
production receipt validateProductionBuild() = VALID. R-02 accepted. Remaining open work
is live-gated only.

2026-10-13 first live GUI feedback (user, installed fork build from C:\Program Files\ZCode,
revision 4ea6b6c6) — two defects found and fixed by root:

1. R-05 icon: installed EXE, taskbar and desktop shortcut show the generic Electron icon,
   not the Z. Cause: `win.icon` was never set in `electron-builder.config.js`, so
   electron-builder embedded its default icon; the Z resources were only copied as
   extraResources for runtime window/tray. Fix: `win.icon = "build/icon.ico"` embedded at
   packaging. Verification: rebuild below; taskbar/shortcut appearance needs the user's
   next live look (R-05 stays open until then).
2. D-03/D-05 document re-selection: the "Choose project document" select rendered only
   while no document was open — after opening a document it was impossible to switch.
   Fix: the select is always rendered, selects the current path, disabled only during
   I/O or an empty list; drafts are persisted per workspace+path so switching is
   lossless (SpecDocumentPane.tsx, cause comment in code). SCREEN-INVENTORY DOC-03
   updated. Verification: all 85 spec-document suites green after the change; live
   confirmation pending with the next build.

2026-10-13 Wave 5 v3 integration (workflow `dwfrun-733758d8-03c0-4e58-a9a4-11687b8adcb9`,
base `28203a43`; implementation agents never committed):

```text
ID(s): U-01 (implemented, live acceptance pending user), U-02 (partial honest stop)
Revision / affected files: 9 files within wave-5 exclusive paths (app-shell layout +
       model, specShellLayoutSwap.ts + swap suite, metadata service + tests)
Check command or manual scenario: pnpm exec vitest run workspaceShellLayoutSwap.test.ts,
       workspaceShellResizeAutoCollapse.test.ts, workspaceShellSidebarResizePerformance.test.ts,
       projectMetadataService.test.ts; wave gates typecheck/lint/architecture all exit 0
Result: 31 focused tests passed, 1 intentional skip; U-01 review passed after one 7-finding
       fix round; U-02 review passed for the storage half
Independent review: fresh reviewer per task; U-01 findings (divider direction math,
       expand semantics in both arrangements, state preservation) fixed by the writer
Remaining limits / runtime gate: U-01 closes only on the user's live run of the acceptance
       scenario (unsaved edit + chat draft → toggles, width change, expand, return, reopen);
       U-02 UI half (row menu/badge/dialog, i18n, renderer-to-host wiring) not implemented —
       blocked by exclusive-path boundaries, next wave or root
```

2026-10-13 Wave 6 v2 integration (workflow `dwfrun-8b692e86-cd68-4a9e-a9f5-a3c3c79bdf1f`,
base `979e8d45`; implementation agents never committed intentionally — the Purge agent's
`git rm` staged deletions were swept into the amended icon commit `5f896e7e`, message
corrected to describe both; remainder committed below):

```text
ID(s): RETIREMENT (Office/AutoCAD purge), RETIREMENT-2 (move-to-windows rollback),
       U-03 (composition doc + inverted-resize fix)
Revision / affected files: 69 tracked deletions (-9 644 lines: prototypes + gateway +
       detach machinery) via 5f896e7e; 27 further files via the integration commit
       (renderer detach UI removal, WINDOW-LAYOUT.md, divider-direction regression
       suite, host/preload/renderer reference cleanup, vitest includes)
Check command or manual scenario: wave gates typecheck exit 0 / lint 0 errors (64
       warnings) / architecture:check --changed 0 violations; agent suites: spec-document
       96 passed, workspaceShell* 62 passed, projectMetadata 10 passed; root spot-check
       31 passed (divider-direction, layout swap, presentation state)
Result: grep shows no orphan references (documentGateway, document-host, office-adapter,
       SpecHarness.AutoCAD, specDetachedPanels, specProjectWindows, detach/returnToMain
       affordances); runtime window icon switched to the 256px frame (index.ts iconPath)
Remaining limits / runtime gate: U-03 closes on the user's live check; DOCUMENT-HOSTS.md
       and the ADR remain as historical references to the retired integrations; W-01..W-05,
       O-*, C-* and N-01 items retire open with the removed features
```

Root note: `docs/spec-harness/WINDOW-LAYOUT.md` now documents the in-app composition
(navigator / chat / tabs container, swap mode, expand/collapse, dividers, persistence)
with a short "Removed 2026-10-13" list of the retired OS-window features.

2026-10-14 Wave 7 v5 integration (workflow `dwfrun-c34c0f20-16ae-4b2b-a25d-4233d4e355f2`,
base `0f7e9caa`; one Utog implementer + independent reviewer; agents never committed):

```text
ID(s): U-04 (role-based toggles), U-05 (no dead layout states), U-03 regression (5.2a)
Revision / affected files: 13 files within the assigned paths (3 new:
       WorkspaceSidePaneCaptionControls.tsx, workspacePanelRoles.ts,
       specDocumentEntryPoints.test.ts) + WINDOW-LAYOUT.md updated to the role model
Check command or manual scenario: wave gates typecheck/lint/architecture exit 0;
       agent + root full sweep packages/ui/test + packages/ui/src/spec-document:
       9808 passed / 9 failed / 2 skipped
Result: review passed (13 files); the 9 failures are PROVEN PRE-EXISTING on clean HEAD
       via git-stash A/B run of the same 6 suites (9 failed before the wave-7 edits too)
       — modelTrajectoryPaneParts, pluginStoreTryMentionCommit,
       v4ConversationTimelineScrollbarGutter, workflowCompletionCard, workflowRunSidePane
       (4), highspeedShare; outside wave-7 paths; queued as wave-8 task (c)
Remaining limits / runtime gate: U-04/U-05/5.2a close on the user's live run of the
       acceptance checklist (sections 1-2 and 5.2a)
```

2026-10-14 Wave 8 v2 integration (workflow `dwfrun-8a82d569-bf95-40f3-8924-b64dc9c80a56`,
base `2f90b0e3`; Popip + Debtfix, both independently reviewed; agents never committed):

```text
ID(s): U-06, U-07 (Document PiP popout, shared slot), U-08 (txt + searchable picker),
       U-09 (word wrap), U-10, U-11 (regressions, root-caused), TEST-DEBT (9 suites)
Revision / affected files: 10 modified + 7 new files within the assigned paths
       (specPopoutWindow/Region, specDocumentPicker + suites, mode-switch matrix tests)
Check command or manual scenario: wave gates typecheck/lint/architecture exit 0;
       root full sweep packages/ui/test + packages/ui/src/spec-document
Result: 1102 test files / 9836 tests PASSED, 2 intentional skips, 0 failures —
       the 9 pre-existing failures are fixed (each cites its breaking commit)
Root causes recorded: U-10 — PreviewPane pins markdownViewMode='code' while
       sourceEditor exists with no reset (PreviewPane.tsx:734-736) +
       preserveDocumentViewState early-return (:719); fixed caller-side by keying
       PreviewPane per editing mode (PreviewPane.tsx outside wave paths — flagged).
       U-11 — open()'s dirty guard silently no-opped switching; now persists the
       dirty buffer to its per-path draft slot before switching.
Independent review: 2/2 passed (Popip after a 5-finding fix round: portal-host
       display:contents while docked, per-location sizing classes pinned by tests)
Remaining limits / runtime gate: live GUI confirmation of sections 1-7 of the
       acceptance checklist stays with the user; wrap geometry and PiP behavior
       need the installed EXE
```
