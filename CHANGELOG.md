# Changelog

<!-- Форк ZCode-Harness: изменения форка фиксируются здесь по упакованным версиям
     (новейшие сверху). Секция Build = артефакт установки с SHA-256 и исходной
     ревизией (buildCommitId). Upstream-merge — одной сводкой; полная история в git. -->

## 3.17.2 fork — 2026-11-03

### Changed

- Merged upstream v3.17.2 (zai-org/ZCode a9fe401e, released on main without a
  tag): privilege-scoped browser local HTML preview, plugin UI bound to
  draft/prewarm sessions, remote drafts now require a chosen project before
  agent prewarm, interaction dialogs verify snapshot ownership, packaged
  platform-dependency pruning. The merge keeps fork features intact
  (spec-document autosave/find, independent document windows, popouts, GPT/
  SIWC auth, fork updater policy); the dialogs gate combines the fork's
  panePresented visibility with upstream's effectiveSessionId ownership check.
- Upstream retired the tray corner unread dot; the Windows taskbar unread
  overlay badge (the visible red dot) is kept and working.

### Build

- `packages/desktop/dist/ZCode-3.17.2-win-x64.exe`, 215,725,036 bytes, SHA-256
  `5e2260e859a43f4edfac8c9e277c9f69bdb27d067996b1f319431540b1563e39`,
  source revision `a9327d42` (v3.17.2 merge + dialogs-gate pin alignment).

## 3.17.1 fork — 2026-10-31

### Added

- Find-in-document for the document tab (U-19): Ctrl/Cmd+F opens an in-pane
  find bar in both view and edit modes. View mode highlights every match in
  the rendered prose via the CSS Custom Highlight API with the standard find
  tokens; edit mode searches the textarea buffer with the native selection.
  Live `n / m` counter, Enter/F3 next, Shift+Enter prev, Esc closes and clears.
- U-20 registered (open): content search across all documents inside the
  picker — needs a service-side `search` contract, recorded in the checklist.

### Changed

- Merged upstream v3.17.1 (zai-org/ZCode a60ba6a): partition-based timeline
  performance model, Sites plugin panel, request-security edition, Electron 44,
  engineering test model. The fork's presentation freeze and mounted-turn clock
  are preserved on top of the upstream partition model; all fork features
  verified intact after the merge (autosave, popout/independent windows,
  GPT/SIWC auth, fork updater policy).
- Restored 1,938 app-unit test files retired by upstream: 1,787 pass on the
  merged tree; 151 suites pinning pre-3.17.1 module surfaces are reverted and
  listed in `docs/testing/V3-17-1-TEST-DEBT.md`; 2 upstream engineering tests
  are quarantined as Windows-env failures (see `vitest.config.ts`).

### Fixed

- Bundled npm staging on Windows: upstream's extract step passed a
  system-drive cwd, and the GNU tar in PATH parsed `D:/...` as a remote host.
  Extract now uses the tarball directory as cwd (same-drive relative path).
- Document Save/autosave blocked forever by a dead bound session: a document
  bound to a session deleted with old tasks kept the UI write guard blocked
  (store status "error" counted as a writer), disabling the Save button and
  U-18 autosave while no conversation was running. Per the 2026-10-31 user
  ruling, only a connecting store or a live session with real writer activity
  pauses saving; service-side CAS still rejects actual conflicts at write
  time.

### Build

- `packages/desktop/dist/ZCode-3.17.1-win-x64.exe`, 215,736,999 bytes, SHA-256
  `a7c1943b6f9bf8f5c0c681ae0d9f56bad5400500c437464cb5bdfb29db73f858`,
  source revision `fff00bf1` (v3.17.1 merge + U-18/U-19 + dead-session save
  fix; replaces the 03:21Z `77099cf3` artifact of the same name).

## 3.16.2 fork — 2026-10-21 → 2026-10-30

### Added

- ChatGPT/GPT subscription integration: SIWC OAuth login, provider runtime
  and account services, coding-plan (highspeed) surfaces in the model picker
  and composer, share notices and saved-time accounting.
- Multi-tab Open doc (U-12): «+» opens a new document tab each time, per-tab
  drafts and titles; clean workspace-relative picker paths (U-13); searchable
  combobox picker and first-class txt documents with soft wrap (U-08/U-09).
- Documents in independent OS windows and restored concurrent conversation
  layouts; document discussions survive reopen with their native sessions.
- U-18: manual document edits autosave to disk (desktop-local grant + 500 ms
  debounce, CAS conflict guard); the Save button and picker delete go live.

### Fixed

- Fork update policy distinguished from development builds (packaged
  auto-update stays compiled off).
- Full-view integration gaps, chat presentation flags during the collapsed
  full view, and a Windows guard for POSIX-permission skip paths.

### Build

- `packages/desktop/dist/ZCode-3.16.2-win-x64.exe`, SHA-256
  `d22260382e6ebdb97c74eab07fbaf353017b01cd5186ffdd5e5b6fef498375a9`,
  source revision `65e63a39` (includes U-18; superseded by 3.17.1).

## 3.15.1 fork — 2026-10-17

### Added

- Replace the artifact passport form with five prose blocks: role, template,
  data, assembly and acceptance. Send readable instructions to the agent,
  preserve detailed legacy procedures, and migrate only on save to store v2.

## 3.15.1 fork — 2026-10-15

### Added

- Add a project-local DOCX title-sheet renderer with explicit counted text
  replacements, template hashes and output receipts. Preserve the real Word
  template layout and refuse to overwrite an author-modified output.
- Edit artifact passports for files, folders and project roots. Bind instructions,
  sources, skills, checklists and descriptive file/MCP/REST steps to a document.
- Opt into artifact context in document discussions, inspect inherited sources and
  resolve a fresh passport snapshot before each message through the native send path.
  Metadata errors preserve the draft and prevent incomplete submissions.
- Include an ODN title-sheet example with MD/TXT inputs, a local skill and a
  documented manual acceptance procedure using fictional training data.

### Fixed

- Make document search accept project-prefixed and absolute workspace paths,
  match multiple terms, prioritize filenames and open results with one click.
  Show the current project, result count and clear-search control.
- Open a document discussion from the existing Discussions control without
  requiring a selected fragment.

- Show ChatGPT Subscription as its own provider in Model settings, including when
  account discovery is unavailable. Manage explicit model IDs and enable/disable
  them through the existing model selector without introducing API-key credentials.
- Open chats and document discussions in native desktop windows, with independent
  placement, resizing and Return controls. Preserve the existing conversation tree,
  unsent text and model menus when moving between windows.
- Make the desktop discussion Expand button open a native window and remove internal
  dragging and resizing controls from detached discussions.
- Resolve document lists from the focused conversation's project instead of the
  application checkout or the first project tab. Keep explicit draft/session bindings.
- Open ChatGPT authorization in the default browser through Electron Main. Finish
  loopback shutdown even when the browser keeps a speculative TCP connection open.
- Bound OAuth token and model-catalog requests, including response bodies, and retain
  saved credentials after temporary discovery failures.
- Add **Refresh models** without repeating OAuth. Show catalog errors, including HTTP
  status, preserve existing models, and reject stale writes after an account change.
- Connect the ChatGPT OAuth credential source to model runtime assembly while keeping
  the existing ZCode/Z.ai and API-key provider branches separate.
- Suppress repeated unchanged write-guard and plugin UI publications to reduce work
  during streaming.
- Rebuild and stage the current CLI and required native plugins before desktop builds;
  reject stale production receipts and keep upstream automatic updates disabled.
- Keep Windows verification reproducible: preserve UTF-8 PowerShell output, use
  platform-correct file URLs, read patch declarations from the pnpm workspace file,
  and remove the stdio proxy preload before starting its child process.

### Validation and remaining acceptance

- Full pre-push verification passed: 1,975 test files and 18,419 tests passed;
  3 files and 67 tests were skipped. Lint reported no errors and architecture
  checks reported no violations.
- Focused authentication, catalog retry, account service, UI and window tests passed.
  Product GUI checks covered document project roots, native detach/Return and
  catalog failure → retry → appearance in the real model selector using a local fixture.
- Production Windows builds use the ZCode identity and preserve the existing user
  profile. Only one desktop shortcut is maintained.
- Real browser sign-in was confirmed by the user. The authenticated OpenAI model
  endpoint returned HTTP 520 during diagnosis; live GPT inference, tool execution and
  the account's actual quota deduction remain unverified.
- Multi-monitor/DPI, crash recovery, full streaming/permission scenarios and complete
  performance measurements remain explicit acceptance items in the
  [Russian checklist](docs/spec-harness/ACCEPTANCE-CHECKLIST.md).

## 3.15.1 fork — 2026-10-13 → 15 (baseline)

### Added

- Spec Harness port into the fork: the document tab (Open doc) with view /
  edit / per-document drafts and CAS save, native document discussions bound
  to artifact context, project metadata / passports, Word title-sheet
  generation, and the production packaging pipeline (Build-Installer.cmd,
  fork icon, packaged auto-update compiled off, one supported release).
- Document search in the picker: project-prefixed and absolute paths,
  multi-term matches, filename priority, one-click open, result counts.

### Build

- `packages/desktop/dist/ZCode-3.15.1-win-x64.exe`, SHA-256
  `1ee68dc16242c52f5f48414dc5b999a7aff6fd0f70216937ddc2b467372ff09`,
  source revision `a8a0c5ac` (superseded by later versions).
