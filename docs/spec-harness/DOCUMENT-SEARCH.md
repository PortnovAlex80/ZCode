# Document picker search repair — 2026-10-15

User report: pasted `ODN-Foundation-Document-Pilot/harness-title-pilot/docs/title-sheet.md`
does not match a workspace-relative document. The picker uses a literal substring
filter and hides the active project, making the search scope hard to understand.

Keep the document service as the owner of current-project paths. Search accepts
filename fragments, multiple terms, workspace-relative paths, paths prefixed by the
current project's folder name and absolute paths inside the current workspace.
Normalize slashes, leading `./`, matching project prefixes and surrounding quotes.
Never silently change projects, open an arbitrary pasted path or fall back to a
same-named file in another workspace. Return the original listed service path.

Prefer filename matches over directory matches; retain original order without a
query. Show filename and parent directory on separate lines, visible project/root,
result count, clear query and keyboard hint. Single click or Enter opens a result;
arrow keys move the active result into view. File deletion remains a separate
confirmed action. Empty results explain that search is limited to the shown project.

Focused component tests cover the reported ODN path, Windows full paths, multiple
terms/ranking, single-click/Enter, clear, project isolation and existing delete
behavior. Validate typecheck/lint/architecture and isolated Electron GUI; rebuild
production. Preserve running user sessions and profile.

Follow-up: the user cannot find where to type the document request. Add an explicit
document discussion through the existing Discussions control (no additional button). It opens/reuses a
document-scoped discussion without requiring text selection. Store optional
`scope:"document"` on its existing thread binding; old threads remain fragments.
First input includes project/document identity and asks the agent to read the file
through existing tools; never silently attach the whole file. Show document scope
instead of a fake selected fragment. Context remains explicitly enabled by the user.
