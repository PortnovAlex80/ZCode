# ui-spec-document

Fork document experience on top of the native file UI (user rulings 2026-11-07):
opening/search stays native (upstream file tree + tabs); this module owns the
fork's editing engine, document discussions, independent document windows and
the presentation state that survives reopen.

Invariants:

- Editing always goes through `specDocumentService` (CAS `expectedSha256`,
  500 ms debounced autosave, visible conflict, save paused while an observed
  session is connecting or actively writing). The UI write guard is a hint,
  not a lock — the service CAS is the boundary.
- Editable = any non-binary text file (denylist + content guards); listing
  (`list`/`search`) keeps the prose extension whitelist and never expands
  silently.
- The native preview keeps its own controls; fork controls (Edit/Save/status,
  Discuss, Open-in-window) mount via PreviewPane props and never replace
  native rendering paths.
- Presentation state (path/draft/scroll/threads) is persisted per
  workspace+path with a single writer per pane token; stale writers retire.

Touch points with other modules: PreviewPane/FileManagerPane (ui) render the
overlay via `documentActions`/`sourceEditor` props; services/spec-document owns
IO; project-sidebar resolves the active project context; workspace-file-tree
rows dispatch the three context actions through `workspaceFileEntryPoints`.
