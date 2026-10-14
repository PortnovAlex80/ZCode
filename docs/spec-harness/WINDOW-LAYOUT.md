# WINDOW-LAYOUT — Remaining in-app window/panel composition (U-03 разведка)

Status: living reference for the **in-app** shell composition after the 2026-10-13 OS-window
retirement (see «Removed 2026-10-13» at the bottom). All citations are `path:line` against
the working tree of this change; re-verify lines before editing the cited code.

## Composition model (one OS window)

```
DesktopWindowFrame
└── workspace shell (CSS-var split, NOT react-resizable-panels)
    ├── [1] left navigator  (id="sidebar")      + separator (role="separator")
    └── [2] content column   (id="content")
        └── body ResizablePanelGroup (horizontal, react-resizable-panels)
            ├── conversation-column panel (chat column; vertical group inside)
            │   ├── conversation panel (chat + workspace header)
            │   └── terminal panel (animated, collapsible)
            ├── Separator (order 2 — rendered by AnimatedSidePanePanel when visible)
            └── browser panel (the right tabs container, id="browser")
```

Two arrangements of the body group (**«Чат в центре»** default and **«Документ в центре»**
swapped, U-01):

- chat-center: `[conversation-column | sep | browser]` — chat center, tabs right.
- document-center: `[browser | sep | conversation-column]` — tabs center, chat right.
  Visual swap is done with CSS `order` only; DOM/React tree order never changes
  (packages/ui/src/app-shell/WorkspaceShellLayout.tsx:614-636,
  packages/ui/src/app-shell/AnimatedSidePanePanel.tsx:589-595).

## Owners

| Piece | Owner | Evidence |
| --- | --- | --- |
| Whole shell composition & CSS-var sidebar split | `WorkspaceShellLayout` (memo component) | packages/ui/src/app-shell/WorkspaceShellLayout.tsx:282 |
| Left navigator DOM (`<aside id="sidebar">`) | `WorkspaceShellLayout` renders `WorkspaceSidebar` inside it | packages/ui/src/app-shell/WorkspaceShellLayout.tsx:2291-2315 |
| Sidebar show/hide state (`isSidebarVisible`) | shell props (root-level toggle, shortcut) | packages/ui/src/app-shell/WorkspaceShellLayout.tsx:347 |
| Body split (chat ⇄ tabs) | RRP `ResizablePanelGroup` + `ResizablePanel`s | packages/ui/src/app-shell/WorkspaceShellLayout.tsx:2430-2444 |
| Right tabs container panel (`id="browser"`) | `AnimatedSidePanePanel` (rendered by the shell as `sidePanePanel`) | packages/ui/src/app-shell/AnimatedSidePanePanel.tsx:1638-1665, packages/ui/src/app-shell/WorkspaceShellLayout.tsx:2799 |
| Side-pane tab inventory/kinds | `WorkspaceSidePaneTab` union (21 kinds: background-bash, browser, browser-permissions, git, code-viewer, treemapping, whiteboard, model-trajectory, developer-tools, terminal, browser-use, subagent-session, subagent-directory, selection-side-chat, plan-detail, plugin-ui, workflow-run, workflow-directory, workflow-actor-session, workflow-workspace, workflow-artifact) | packages/ui/src/lib/workspaceSidePane.ts:530-551, kind literals at :13,:44,:52,:66,:75,:85,:96,:104,:116,:185,:199,:244,:287,:327,:379,:430 |
| Side-pane open/collapsed animation & imperative size | `useAnimatedResizablePanel` (rAF-deferred `panel.resize`/`panel.collapse`/`panel.expand`) | packages/ui/src/app-shell/useAnimatedResizablePanel.ts:56-130 |
| Swap mode persistence | `specShellLayoutSwap.ts` helpers, called from the shell | packages/ui/src/spec-document/specShellLayoutSwap.ts:18-58, packages/ui/src/app-shell/WorkspaceShellLayout.tsx:516-541 |
| Chat collapse («Развернуть документ») state | `generalChatCollapsedWorkspaceKey` state + `resolveSpecGeneralChatCollapsed`/`toggleSpecGeneralChatCollapse` | packages/ui/src/app-shell/WorkspaceShellLayout.tsx:637-665, packages/ui/src/spec-document/specGeneralChatCollapse.ts |
| Terminal open/size | `useAnimatedResizablePanel({open: isTerminalOpen, expandedSize: "30%"})` | packages/ui/src/app-shell/WorkspaceShellLayout.tsx:590-596 |
| Conversation auto-collapse policy (window resize) | effect in the shell reading `conversationPanelElementRef` width | packages/ui/src/app-shell/WorkspaceShellLayout.tsx:711-798 |

## Sizing & divider math

### Left navigator (both states: expanded / collapsed)

- Width state: `workspaceSidebarPanelWidthPx` (px, single source)
  packages/ui/src/app-shell/WorkspaceShellLayout.tsx:568-571.
- Default 264px, min 264px, max 50% of shell container
  packages/ui/src/app-shell/WorkspaceShellLayout.tsx:136-138 (`WORKSPACE_SIDEBAR_*`).
- Clamp: `clampWorkspaceSidebarWidth` = round(max(min, min(width, 50%·container)))
  packages/ui/src/app-shell/WorkspaceShellLayout.tsx:178-188.
- Applied via CSS variables on the shell element — **not** RRP; plain browser layout on
  window resize (no React state per frame):
  `--workspace-sidebar-panel-width` (0/4px when hidden), `--workspace-sidebar-width`
  packages/ui/src/app-shell/WorkspaceShellLayout.tsx:1217-1236 (vars declared at :143-144),
  width class at :2293.
- Drag: pointer capture session `WorkspaceSidebarResizeSession`
  (packages/ui/src/app-shell/WorkspaceShellLayout.tsx:171-175); during drag writes only
  the CSS vars via `applyWorkspaceSidebarWidthDuringDrag`
  (:805-824, perf rationale in comment); on release commits React state + persists
  `finishWorkspaceSidebarResize` (:916-941).
- Keyboard on the separator (`role="separator"`, `data-testid="resizable-handle"`):
  ←/→ ±16px, Home = min, End = max (:943-976, const at :142; markup at :2391-2412).
- Persistence: `zcode:workspace-shell:sidebar-width-px` (localStorage, px)
  packages/ui/src/app-shell/WorkspaceShellLayout.tsx:139, :225-236. Legacy RRP ratio
  migrated once from `react-resizable-panels:workspace-shell-layout:sidebar:content`
  (:140-141, :824-851).

### Body group (chat ⇄ tabs container) — the divider between document and chat

- Group: `ResizablePanelGroup` with `layoutId =
  specShellBodyLayoutId(specGeneralChatLayoutId(workspaceKey, isSpecDocumentActive),
  isDocumentCenterLayout)`; `panelIds` follow the visual arrangement so the RRP storage
  key (built from panel order) reads back what it saved
  packages/ui/src/app-shell/WorkspaceShellLayout.tsx:2430-2444,
  packages/ui/src/spec-document/specShellLayoutSwap.ts:64-78,
  packages/ui/src/spec-document/specGeneralChatCollapse.ts:29-32.
- Panel ids are module-level constants (chat-center `[conversation-column, browser]`,
  document-center `[browser, conversation-column]`)
  packages/ui/src/app-shell/WorkspaceShellLayout.tsx:158-162.
- conversation-column constraints: collapsible only while chat is hidden
  (`collapsible={generalChatCollapsed}`, collapsedSize "0px"); min 35% (chat-center) /
  20% (document-center); default 52% / 38% when the side pane is visible
  packages/ui/src/app-shell/WorkspaceShellLayout.tsx:2446-2471
  (constants in packages/ui/src/spec-document/specShellLayoutSwap.ts:11-14).
- browser (tabs container) constraints from `resolveAnimatedSidePanePanelLayout`:
  normal default 0px (opens via imperative resize), min 240px, max 65%; document-center
  default 62%, max 80%; `collapsible`/`disabled` only while hidden (`isDragCollapsible =
  isResizeDisabled = !isVisible`)
  packages/ui/src/app-shell/animatedSidePanePanelModel.ts:61-96,
  packages/ui/src/app-shell/AnimatedSidePanePanel.tsx:455-456, :1638-1653.
- The separator lives between the two panels with `order: 2` and mounts only while the
  side pane is visible and chat is not hidden
  packages/ui/src/app-shell/AnimatedSidePanePanel.tsx:1619-1636.
- Open/resize flow: `useAnimatedResizablePanel` defers one rAF, then `panel.resize(
  expandedSize)` on open and `panel.collapse()` on close; `rememberExpandedSize` stores
  the last expanded % so the manual width survives collapse cycles
  packages/ui/src/app-shell/useAnimatedResizablePanel.ts:80-130.
- Drag/keyboard direction: RRP sorts panels by `offsetLeft` (which reflects CSS `order`)
  at (re)registration and pairs the separator to the visually-ordered panel pair, so
  direction follows the actual visual arrangement. The shell therefore re-asserts the
  orders on **every render** (`applySpecShellLayoutSwapOrders`, diff-aware writes)
  packages/ui/src/app-shell/WorkspaceShellLayout.tsx:614-636,
  packages/ui/src/spec-document/specShellLayoutSwap.ts:94-113 — this is the U-03 fix
  for the inverted-direction-after-resize report (see below).

### Conversation column (vertical, inside conversation-column)

- Vertical group `workspace-conversation-column-layout`, panelIds
  `["conversation", "terminal"]`
  packages/ui/src/app-shell/WorkspaceShellLayout.tsx:159, :2478-2483.
- conversation panel min 35% (:2485-2488); terminal animated panel expandedSize "30%"
  with remember-expanded-size (:590-596).

## Interactions

| Interaction | Entry point | Mechanics |
| --- | --- | --- |
| Toggle sidebar | shell header/shortcut (`handleToggleSidebar`) | only visibility; width state and CSS var persist |
| Drag sidebar separator | pointer session | CSS-var during drag, state+persist on release (see above) |
| Open/close side pane | `WorkspaceSidePaneToggleButton` in tabs caption | `useAnimatedResizablePanel` rAF resize/collapse |
| Toggle swap «Чат в центре»/«Документ в центре» | icon button in tabs caption (`data-spec-shell-layout-swap-toggle`, aria-pressed) | writes swap storage + in-memory mode; constraints flip → RRP re-registration re-sorts by offsetLeft; DOM order stable, zero remounts packages/ui/src/app-shell/AnimatedSidePanePanel.tsx:1009-1017, packages/ui/src/app-shell/WorkspaceShellLayout.tsx:533-543 |
| «Развернуть документ» (⤢) | document actions in `SpecDocumentPane` | sets `generalChatCollapsed` → conversation-column collapses to 0 (collapsible only in this state); «Вернуть чат» restores packages/ui/src/spec-document/SpecDocumentPane.tsx:809-820, packages/ui/src/app-shell/WorkspaceShellLayout.tsx:637-679 |
| Show-main-chat arrow | tabs caption when chat hidden | `onToggleGeneralChat`; icon side follows the arrangement packages/ui/src/app-shell/AnimatedSidePanePanel.tsx:987-1006 |
| Window resize → auto-collapse | resize listener, 300ms idle | conversation < 480px ⇒ collapse side pane, then conversation < 360px ⇒ collapse sidebar; only reacts to window resizes (not panel opens) packages/ui/src/app-shell/WorkspaceShellLayout.tsx:145-155, :711-798 |
| Body divider drag/keyboard | RRP separator | direction follows visual order; persisted per layoutId namespace |

## Persistence keys (summary)

| Key | Scope | Value | Owner |
| --- | --- | --- | --- |
| `zcode:workspace-shell:sidebar-width-px` | global | sidebar px width | packages/ui/src/app-shell/WorkspaceShellLayout.tsx:139 |
| `spec-harness-shell-layout-swap:v1:<workspaceIdentity \|\| path>` | per workspace | `{version:1, mode:"chat-center"\|"document-center"}` | packages/ui/src/spec-document/specShellLayoutSwap.ts:18-22 |
| `react-resizable-panels:<body layoutId>[:document-center]:<panelIds…>` | per workspace × arrangement × spec-doc-active | panel % layout (RRP `useDefaultLayout`) | packages/ui/src/app-shell/WorkspaceShellLayout.tsx:2434-2441, packages/ui/src/spec-document/specGeneralChatCollapse.ts:29-32 |
| `workspace-conversation-column-layout` | global | conversation/terminal % | packages/ui/src/app-shell/WorkspaceShellLayout.tsx:2480 |

## U-03 bug note — inverted divider direction after window resize (fixed)

Root cause: RRP re-sorts panels at (re)registration using `offsetLeft`; the shell's
render-phase order re-assertion was latched on the swap-mode string, so re-registrations
driven by window-resize auto-collapse (`collapsible`/`disabled`/`defaultSize` flips in
AnimatedSidePanePanel.tsx:455-456 and WorkspaceShellLayout.tsx:2464-2471) could read a
reset `order` with the mode unchanged, sorting panels back into the pre-swap arrangement —
the divider stayed bound to the pre-swap side (drag right grows the panel the user sees on
the *other* side; toward the max-constrained side the move died entirely).
Fix: re-assert orders on every render with diff-aware writes
(packages/ui/src/spec-document/specShellLayoutSwap.ts:94-113,
packages/ui/src/app-shell/WorkspaceShellLayout.tsx:614-636). Regression matrix:
packages/ui/test/workspaceShellDividerDirection.test.ts (both modes, container shrink/grow,
mode toggle, collapse/reopen, reload with swapped mode persisted).

## Removed 2026-10-13 (RETIREMENT-2, user decision)

The move-to-separate-OS-windows feature was rolled back (history preserved in git):
detach chat/panel to window («Move chat to window», «Move active panel to window»),
«Return to Main», «Open project in window» (sidebar ⋯ menu), «Open conversation in
window» (task list context menu), the window-role toolbar and role label, the ↗
locatable-window indicators, `SpecDetachedPanelRoot`, `useSpecDetachedPanels`,
`specWindowBridge`, `useSpecWindowLocations`, the cross-window project catalog
(`useSpecProjectCatalog`), and the `ZCODE_SPEC_HARNESS_WINDOWS` gate (Main side).
The in-app layout (swap, expand, tabs) is unaffected and stays.
