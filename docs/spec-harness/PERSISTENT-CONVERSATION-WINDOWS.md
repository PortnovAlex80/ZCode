# Persistent conversation windows

Date: 2026-10-18. User-authorized extension of U-06/U-07 and D-01.
Decision: [ADR 004](../architecture/decisions/004-persistent-conversation-windows.md).

## Behavior

On Desktop, detach an existing conversation with the chat window control. Each
session keeps an independently addressed native window; two sessions from one
project and sessions from other projects can remain visible simultaneously.
Selecting an already open conversation in the project tree focuses its existing
window. Other main/split panes show a reveal action instead of another composer.
The saved open collection survives renderer reload and application restart.
Restoring a history view may start its existing scoped read-only runtime; it never
creates a session, resumes a run or sends a model prompt. A missing/offline target
shows an honest unavailable/retry view without falling back to another project.

Native placement remembers normal bounds, maximized state and display hint in
DIP. Re-detaching the same conversation reuses its placement even after Return.
Unavailable displays recover onto a connected work area, including negative
monitor coordinates. Geometry belongs to Main; no renderer-supplied arbitrary
native window IDs, URLs or privileged geometry IPC are added.

Explicit child X and Return remove only that view from the open collection.
Reload, quit and teardown retain open intent. The existing app quit barrier
acknowledges owner shutdown before child disposal and flushes geometry. Native
pagehide is deferred to the opener's next task so an owner reload is not mistaken
for an explicit Return. Closing a view never sends Stop/Delete to its session.

Document discussions retain one document owner across project navigation and
persist its original workspace, parent, tab and selected thread. Presentation is
scoped per conversation/tab, while file drafts keep their existing workspace/file
identity. Saved document tabs, per-owner active tab and collapsed state survive
restart. Shell arrangement and panel sizing use conversation scope; legacy shell
arrangement is the fallback for the first per-conversation restoration.

Each native chat uses a unique Workbench leaf and the existing scoped provider.
File/browser/workflow/side-chat actions first address their owning project in the
main shell, then invoke its current callbacks. Ambient Git/status from another
project is not passed to detached leaves. Keyboard Stop and one-shot composer
events use the actual presentation document and window focus.

## Validation and limits

Repeatable isolated scenarios: `scripts/test-conversation-windows-gui.mjs` and
`scripts/test-discussion-recovery-gui.mjs --persistent-windows`. They use seeded
history and unsent drafts without credentials or model requests. Record actual
test/build results in the implementation checklist. Pure geometry tests cover
missing displays and negative coordinates; physical mixed-DPI monitors remain a
separate hardware acceptance check. Multi-window presentation does not change
the existing runtime's agent execution concurrency policy. Browser Web retains
its existing single Document PiP capability.
