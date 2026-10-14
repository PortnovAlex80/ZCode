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

### Roles (U-04, user refinement 2026-10-14)

Every arrangement has a PRIMARY region (center, wide) and an AUXILIARY region (right,
narrow). The swap **exchanges the roles** of the chat and the tabs container; visibility
never flips on a swap (each region keeps its own visibility state):

| Arrangement     | PRIMARY (center, wide)     | AUXILIARY (right, narrow)  |
| --------------- | -------------------------- | -------------------------- |
| chat-center     | chat (conversation column) | tabs pane (`browser`)      |
| document-center | tabs pane (`browser`)      | chat (conversation column) |

Resolver (single source for the role math): `resolveWorkspaceBodyRoleState`
packages/ui/src/spec-document/workspacePanelRoles.ts. Full width = auxiliary hidden,
regardless of roles (chat-center + tabs hidden ⇒ chat full width; document-center +
chat hidden ⇒ tabs full width).

Panel controls after U-04 (exactly two, both position-independent):

1. **Role toggle «Скрыть/Показать боковую панель»** — ONE control rendered by
   `WorkspaceSidePaneToggleButton` (neutral `Columns2` glyph; labels via the existing
   `sidePane.collapse`/`sidePane.expand` intl ids). It hides/shows whichever region is
   currently AUXILIARY; when some region is hidden it restores that region first
   (U-05 restore-first, covers a hidden PRIMARY whose caption is unreachable). It lives
   in the top-right caption cluster: the tabs-pane caption
   (packages/ui/src/app-shell/WorkspaceSidePaneCaptionControls.tsx, rendered by
   AnimatedSidePanePanel) whenever the tabs pane is visible, and the chat-column
   WorkspaceHeader while the tabs pane is hidden (persistent shell-anchored reopen
   affordance). The migration merged into it: the ⤢ «Развернуть документ» button in the
   document header, the «Show main chat» caption arrow, and the fixed-region
   PanelRight* side-pane toggle. No PanelLeft*/PanelRight\* Open/Close glyphs remain in
   the shell (remaining uses outside the shell are position-true: the fixed-left
   navigator DesktopTopOverlay/quickpick/collapsed-rail icons and the left-edge
   selection-share reopen tab).
2. **Swap toggle** (ArrowLeftRight, target-state label, `aria-pressed`) — geometry-only:
   exchanges roles, never changes visibility. Unchanged from U-01.

The navigator (left sidebar) stays a root toggle, unchanged.

## Owners

| Piece                                                 | Owner                                                                                                                                                                                                                                                                                                                                                                           | Evidence                                                                                                                                                                |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Whole shell composition & CSS-var sidebar split       | `WorkspaceShellLayout` (memo component)                                                                                                                                                                                                                                                                                                                                         | packages/ui/src/app-shell/WorkspaceShellLayout.tsx:282                                                                                                                  |
| Left navigator DOM (`<aside id="sidebar">`)           | `WorkspaceShellLayout` renders `WorkspaceSidebar` inside it                                                                                                                                                                                                                                                                                                                     | packages/ui/src/app-shell/WorkspaceShellLayout.tsx:2291-2315                                                                                                            |
| Sidebar show/hide state (`isSidebarVisible`)          | shell props (root-level toggle, shortcut)                                                                                                                                                                                                                                                                                                                                       | packages/ui/src/app-shell/WorkspaceShellLayout.tsx:347                                                                                                                  |
| Body split (chat ⇄ tabs)                              | RRP `ResizablePanelGroup` + `ResizablePanel`s                                                                                                                                                                                                                                                                                                                                   | packages/ui/src/app-shell/WorkspaceShellLayout.tsx:2430-2444                                                                                                            |
| Right tabs container panel (`id="browser"`)           | `AnimatedSidePanePanel` (rendered by the shell as `sidePanePanel`)                                                                                                                                                                                                                                                                                                              | packages/ui/src/app-shell/AnimatedSidePanePanel.tsx:1638-1665, packages/ui/src/app-shell/WorkspaceShellLayout.tsx:2799                                                  |
| Side-pane tab inventory/kinds                         | `WorkspaceSidePaneTab` union (21 kinds: background-bash, browser, browser-permissions, git, code-viewer, treemapping, whiteboard, model-trajectory, developer-tools, terminal, browser-use, subagent-session, subagent-directory, selection-side-chat, plan-detail, plugin-ui, workflow-run, workflow-directory, workflow-actor-session, workflow-workspace, workflow-artifact) | packages/ui/src/lib/workspaceSidePane.ts:530-551, kind literals at :13,:44,:52,:66,:75,:85,:96,:104,:116,:185,:199,:244,:287,:327,:379,:430                             |
| Side-pane open/collapsed animation & imperative size  | `useAnimatedResizablePanel` (rAF-deferred `panel.resize`/`panel.collapse`/`panel.expand`)                                                                                                                                                                                                                                                                                       | packages/ui/src/app-shell/useAnimatedResizablePanel.ts:56-130                                                                                                           |
| Swap mode persistence                                 | `specShellLayoutSwap.ts` helpers, called from the shell                                                                                                                                                                                                                                                                                                                         | packages/ui/src/spec-document/specShellLayoutSwap.ts:18-58, packages/ui/src/app-shell/WorkspaceShellLayout.tsx:516-541                                                  |
| Body role math (U-04)                                 | `resolveWorkspaceBodyRoleState` pure resolver (primary/auxiliary/hidden/role-toggle target)                                                                                                                                                                                                                                                                                     | packages/ui/src/spec-document/workspacePanelRoles.ts                                                                                                                    |
| Role toggle presentation (U-04)                       | shell computes target+action+disabled and passes to the tabs caption; chat header receives the restore action via `onToggleSidePane`                                                                                                                                                                                                                                            | packages/ui/src/app-shell/WorkspaceShellLayout.tsx (sidePaneRoleToggle / handleChatCaptionRestorePanel), packages/ui/src/app-shell/WorkspaceSidePaneCaptionControls.tsx |
| Chat hide state («Скрыть чат» side of the role model) | `generalChatCollapsedWorkspaceKey` state + `resolveSpecGeneralChatCollapsed`/`toggleSpecGeneralChatCollapse` (visibility preserved across swaps)                                                                                                                                                                                                                                | packages/ui/src/app-shell/WorkspaceShellLayout.tsx:637-665, packages/ui/src/spec-document/specGeneralChatCollapse.ts                                                    |
| Spec namespace layout restore (5.2a re-key)           | `transitionSpecGeneralChatLayout` + `rekeyLayoutToCurrentPanelOrder` — the only shell-side `setLayout` caller; re-keys the restored ordinary layout to the current registry order so RRP's positional math stays aligned                                                                                                                                                        | packages/ui/src/spec-document/specGeneralChatCollapse.ts, packages/ui/src/app-shell/WorkspaceShellLayout.tsx (handleSpecDocumentActiveChange)                           |
| Terminal open/size                                    | `useAnimatedResizablePanel({open: isTerminalOpen, expandedSize: "30%"})`                                                                                                                                                                                                                                                                                                        | packages/ui/src/app-shell/WorkspaceShellLayout.tsx:590-596                                                                                                              |
| Conversation auto-collapse policy (window resize)     | effect in the shell reading `conversationPanelElementRef` width                                                                                                                                                                                                                                                                                                                 | packages/ui/src/app-shell/WorkspaceShellLayout.tsx:711-798                                                                                                              |

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
  packages/ui/src/spec-document/specShellLayoutSwap.ts:94-113 — the wave-6 U-03 fix.
  Layout objects must also keep their **key order == current registry order** (RRP reads
  them positionally); the only shell-side `setLayout` caller
  (`transitionSpecGeneralChatLayout`) re-keys the restored layout to the current order
  before committing — the 5.2a live-regression fix (see the U-03 bug notes below).

### Conversation column (vertical, inside conversation-column)

- Vertical group `workspace-conversation-column-layout`, panelIds
  `["conversation", "terminal"]`
  packages/ui/src/app-shell/WorkspaceShellLayout.tsx:159, :2478-2483.
- conversation panel min 35% (:2485-2488); terminal animated panel expandedSize "30%"
  with remember-expanded-size (:590-596).

## Interactions

| Interaction                                         | Entry point                                                                                                                                                                   | Mechanics                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Toggle sidebar (navigator)                          | shell header/shortcut (`handleToggleSidebar`)                                                                                                                                 | root toggle, unchanged; only visibility, width state and CSS var persist                                                                                                                                                                                                                                                                                                                                                     |
| Drag sidebar separator                              | pointer session                                                                                                                                                               | CSS-var during drag, state+persist on release (see above)                                                                                                                                                                                                                                                                                                                                                                    |
| Role toggle «Скрыть/Показать боковую панель» (U-04) | tabs caption (`WorkspaceSidePaneCaptionControls` → `WorkspaceSidePaneToggleButton`) while the tabs pane is visible; chat-column WorkspaceHeader while the tabs pane is hidden | ONE position-independent control: hides/shows the current AUXILIARY region (tabs pane in chat-center, chat in document-center); restores any hidden region first (U-05). Shell resolves target via `resolveWorkspaceBodyRoleState` and routes to `handleToggleSidePane` / `handleToggleGeneralChat`; hiding the chat still requires an active document (`canCollapseSpecGeneralChat`), the button renders disabled otherwise |
| Swap «Чат в центре»/«Документ в центре»             | icon button in tabs caption (`data-spec-shell-layout-swap-toggle`, aria-pressed, target-state label)                                                                          | exchanges the ROLES of chat and tabs container; visibility of each region is preserved. Writes swap storage + in-memory mode; constraints flip → RRP re-registration re-sorts by offsetLeft; DOM order stable, zero remounts packages/ui/src/app-shell/WorkspaceSidePaneCaptionControls.tsx, packages/ui/src/app-shell/WorkspaceShellLayout.tsx:533-543                                                                      |
| Window resize → auto-collapse                       | resize listener, 300ms idle                                                                                                                                                   | conversation < 480px ⇒ collapse side pane, then conversation < 360px ⇒ collapse sidebar; only reacts to window resizes (not panel opens) packages/ui/src/app-shell/WorkspaceShellLayout.tsx:145-155, :711-798                                                                                                                                                                                                                |
| Body divider drag/keyboard                          | RRP separator                                                                                                                                                                 | direction follows visual order; persisted per layoutId namespace                                                                                                                                                                                                                                                                                                                                                             |

### Removed 2026-10-14 (U-04 migration)

The position-dependent controls were merged into the single role toggle above:
the ⤢ «Развернуть документ»/«Вернуть чат» button in the document header
(packages/ui/src/spec-document/SpecDocumentPane.tsx), the «Show main chat» caption arrow
and the fixed-region PanelRight* side-pane toggle in the tabs caption
(packages/ui/src/app-shell/AnimatedSidePanePanel.tsx,
packages/ui/src/WorkspaceSidePaneToggleButton.tsx). No
PanelLeft*/PanelRight\* Open/Close glyphs remain in the shell.

## Persistence keys (summary)

| Key                                                                    | Scope                                         | Value                                                | Owner                                                                                                                        |
| ---------------------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `zcode:workspace-shell:sidebar-width-px`                               | global                                        | sidebar px width                                     | packages/ui/src/app-shell/WorkspaceShellLayout.tsx:139                                                                       |
| `spec-harness-shell-layout-swap:v1:<workspaceIdentity \|\| path>`      | per workspace                                 | `{version:1, mode:"chat-center"\|"document-center"}` | packages/ui/src/spec-document/specShellLayoutSwap.ts:18-22                                                                   |
| `react-resizable-panels:<body layoutId>[:document-center]:<panelIds…>` | per workspace × arrangement × spec-doc-active | panel % layout (RRP `useDefaultLayout`)              | packages/ui/src/app-shell/WorkspaceShellLayout.tsx:2434-2441, packages/ui/src/spec-document/specGeneralChatCollapse.ts:29-32 |
| `workspace-conversation-column-layout`                                 | global                                        | conversation/terminal %                              | packages/ui/src/app-shell/WorkspaceShellLayout.tsx:2480                                                                      |

## U-03 bug notes — inverted divider direction (two root causes, both fixed)

### 1. Stale `order` at re-registration (fixed in wave 6, 2026-10-13)

RRP re-sorts panels at (re)registration using `offsetLeft`; the shell's render-phase order
re-assertion was latched on the swap-mode string, so re-registrations driven by
window-resize auto-collapse (`collapsible`/`disabled`/`defaultSize` flips in
AnimatedSidePanePanel.tsx ~1739-1742 and WorkspaceShellLayout.tsx ~2854-2860) could read a
reset `order` with the mode unchanged, sorting panels back into the pre-swap arrangement —
the divider stayed bound to the pre-swap side. Fix: re-assert orders on every render with
diff-aware writes (packages/ui/src/spec-document/specShellLayoutSwap.ts:94-113,
packages/ui/src/app-shell/WorkspaceShellLayout.tsx:614-636).

### 2. Foreign-key-order layout restore (live regression 5.2a, fixed 2026-10-14)

User report on build 9fe78d6c: in document-center the middle divider still moved sizes in
the WRONG direction — wave 6 covered the drag-after-resize path only. Root cause (traced
against react-resizable-panels 4.10.0 dist): the library treats a Group layout
**positionally** — `adjustLayoutByDelta` reads `Object.values(layout)` by index, while
pivot/panel indices come from the panel registry (visual order). `transitionSpecGeneralChatLayout`
(packages/ui/src/spec-document/specGeneralChatCollapse.ts) restores
`memory.ordinaryLayout` captured under the OLD arrangement; the user swaps while a spec
document is active (the swap control sits right in the tabs caption), so the restored
object's key order no longer matches the current registry order. The committed layout puts
each size in the wrong slot; from then on **every** input path — pointer drag (fresh
pairing, but positional flex), keyboard arrows (cached pairing), imperative
`panel.resize/collapse` (index-based pivots and registry-position sign flip) — moves the
divider the wrong way until the layout is rebuilt from persistence.
Fix: re-key the restored layout to the group's current key order before `setLayout`
(`rekeyLayoutToCurrentPanelOrder`, specGeneralChatCollapse.ts) — per-panel values are
kept, only their positions follow the current registry. Direction is therefore derived
from the actual placement for all input paths.
Regression matrix: packages/ui/test/workspaceShellDividerDirection.test.ts — drag AND
keyboard (both directions) in both modes, before/after container shrink/grow,
auto-collapse/reopen, chat hide/restore, mode toggle, reload with the swapped layout
persisted, and both transition-restore directions (cc-ordered saved layout restored into
dc and vice versa — this last block reproduces the live bug pre-fix).

## Removed 2026-10-13 (RETIREMENT-2, user decision)

The move-to-separate-OS-windows feature was rolled back (history preserved in git):
detach chat/panel to window («Move chat to window», «Move active panel to window»),
«Return to Main», «Open project in window» (sidebar ⋯ menu), «Open conversation in
window» (task list context menu), the window-role toolbar and role label, the ↗
locatable-window indicators, `SpecDetachedPanelRoot`, `useSpecDetachedPanels`,
`specWindowBridge`, `useSpecWindowLocations`, the cross-window project catalog
(`useSpecProjectCatalog`), and the `ZCODE_SPEC_HARNESS_WINDOWS` gate (Main side).
The in-app layout (swap, expand, tabs) is unaffected and stays.
