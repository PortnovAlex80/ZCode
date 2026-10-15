# Changelog

## 3.15.1 fork — 2026-10-15

### Added

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
