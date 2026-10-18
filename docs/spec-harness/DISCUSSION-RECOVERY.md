# Recover document discussions from the conversation catalog

2026-10-18. Bug fix: a managed child session remained running, but selecting it
hid the document tab belonging to its parent. Activating that hidden tab did not
change the visibility scope. Closing the document disabled the recovery button.

The durable `SpecThread` remains the authority for the child session, parent
session, document path and discussion ID. Selecting a local managed child uses
its saved parent's side-pane scope, preserving the original document tabs and
their mounted controllers. Ordinary and remote conversations keep their scope.
The agent session itself is never replaced, restarted or forked for navigation.

```text
catalog selects child → saved SpecThread → parent's side-pane scope
                     → document grant ready → activate existing owner
                                            or persist target + open exact file
                     → existing discussion controller → same native session
```

Recovery must work with a mounted but hidden document and with all document tabs
closed, including after restart. A missing mounted owner must not disable the
recovery button. The shell opens the requested file, never an unbound picker or
an arbitrary document tab. Recovery preserves unsaved drafts and never sends a
model command. Loading waits for the local document grant; remote workspaces
are not admitted to this local recovery path.

Regression scenarios: select a child then return to its parent; reopen a closed
document from its child; restore from durable thread/tab storage; choose the
correct discussion among several documents; preserve native draft and one
composer; leave ordinary and remote conversations unchanged. Live acceptance
requires the repaired build; source tests alone do not certify the running app.

Repeatable GUI smoke (isolated profile, seeded native history, no model input):

```powershell
node scripts/test-discussion-recovery-gui.mjs
node scripts/test-discussion-recovery-gui.mjs --executable packages/desktop/dist/discussion-recovery-20261018/win-unpacked/ZCode.exe
```

The fixture explicitly acknowledges storage preparation and sets an absolute
`ZCODE_SESSION_DB_PATH` for its Agent. Skipping welcome is renderer-local, so the
reload scenario repeats that action without adding account credentials.
