# Architecture review: ownership and call graph (A-04)

Status: design review, source evidence only. No GUI, model, installer or live-runtime
acceptance is claimed here. Every `path:line` citation below was read at and resolves at
revision `aa8236cfaa3e87eac03000e397720d0ec1cb878c` (`git rev-parse HEAD` at task start;
full SHA recorded in the verification section). The working tree additionally contains
in-flight Wave 1 edits by other implementation agents (notably
`packages/desktop/src/main/specDetachedPanels.ts` and
`packages/ui/src/spec-document/*`), so working-tree line numbers may drift from the
citations; the citations pin HEAD. Scope: checklist item A-04
([IMPLEMENTATION-CHECKLIST.md](IMPLEMENTATION-CHECKLIST.md) at HEAD line 50) — review the
call graph and ownership across Main/Host/services/CLI, including window-scoped Hosts,
remote identity and the document gateway; document unresolved collisions. The review
explicitly does **not** propose flattening legitimate owners into one global Host; each
collision gets a targeted owner, not a consolidation.

## 1. Ownership model at `aa8236cf`

```mermaid
flowchart TB
    subgraph Main["Main (Electron main, packages/desktop/src/main)"]
        M1[Window lifecycle, IPC, native ops, process scheduling]
        M2[windowHostProcessMap: one utilityProcess per window]
        M3[Detached-panel coordinator: transfer state machine, owner/lease, timeout rollback]
    end
    subgraph HostW["Window-scoped Local Host (utilityProcess, packages/desktop/src/host)"]
        H1[Local workspace services + agent scope desktop-continuous]
        H2[Window remote connection registry: remote sessions keyed by trimmed workspaceIdentity else workspacePath]
        H3[Host attachment registry: local + remote attachment ports, one generation each]
        H4[Opt-in document gateway (web-remote-replayable scope) when env is set]
    end
    subgraph Services["packages/services"]
        S1[ZCodeAgentService: one CLI child per workspace]
        S2[Spec document service: read-only CAS until a writer lease exists]
    end
    subgraph CLI["CLI runtime (apps/zcode-cli, app-server --stdio)"]
        C1[CommandInbox: serial per-session command admission]
        C2[Canonical workspace key: trimmed workspaceIdentity, else workspacePath]
    end
    Renderer[Renderer windows: draft + optimistic overlay only] --> M1
    M1 -->|fork + MessagePort| H1
    M3 -->|attach: reuse source window Host| H1
    H1 --> S1 --> C1
    H2 --> S1
    H4 -->|own agent scope, path-keyed bindings| S1
    NativePane[Word/Excel/AutoCAD pane] -->|HTTPS/WSS loopback| H4
```

| Owner                    | Owns (evidence at HEAD)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Does not own                                                                                       |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Main                     | Window lifecycle and one host `utilityProcess` per window: `packages/desktop/src/main/desktopHostProcess.ts:160-163` (fork per `win`/`label`), `packages/desktop/src/main/index.ts:663` (`windowHostProcessMap = Map<number, ElectronUtilityProcess>` keyed by window id), spawn wiring `packages/desktop/src/main/index.ts:1877-1878`. Detached-panel transfer ownership, generation and timeout rollback: `packages/desktop/src/main/specDetachedPanels.ts:192-229` (detach), `:230-268` (boot), `:276-298` (ready commit), `:130-149` (rollback), `:150-156` (timeout arm). Env passed to every host fork: `packages/desktop/src/main/desktopRuntimeEnv.ts:488-505` spreading `readDefinedProcessEnv()` (`:285-293`).                                              | Task/session business state (none of the maps above hold conversation state).                      |
| Window-scoped Local Host | One process per window; the local workspace's services and agent scope: `packages/desktop/src/host/index.ts:196-198` (per-process singletons), warmup consumes main's fixed per-window workspace list incl. `workspaceIdentity` `:3068-3078`. Remote sessions live in the same window host through the registry: `packages/desktop/src/host/windowRemoteConnectionRegistry.ts:1` (single state-machine comment), session keyed by trimmed `workspaceIdentity` else `workspacePath` `:542`, ownership change releases the previous key `:640-653`, attachment scope must match path **and** identity `:656-673`. Attachments (local re-attach, remote) go through the attachment registry: `packages/desktop/src/host/windowHostAttachmentRegistry.ts:4-27`, `:35-40`. | Native window handles; second agent cores (detached panels reuse the source window's Host, below). |
| Services                 | Agent connection scopes with two client modes `desktop-continuous` / `web-remote-replayable`: `packages/services/src/zcode-agent/zcodeAgentConnectionScope.ts:26`, `:202`. Workspace targets carry `workspaceIdentity`/`remoteSessionId`: `packages/services/src/zcode-agent/zcodeAgentPluginParams.ts:9-14`. Spec document service registered in the product service collection: `packages/services/src/node.ts:2381-2385`.                                                                                                                                                                                                                                                                                                                                          | Renderer draft state; window lifecycle.                                                            |
| CLI runtime              | Serial per-session command admission (busy/running input): `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/command-inbox.ts:107-131` (`keyGates`/`sessionGates` acquire before handling). Canonical workspace key: `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/persistent-command-index.ts:28`.                                                                                                                                                                                                                                                                                                                                                                                                                                                 | UI policy (which surface may compose); document bindings.                                          |
| Renderer (UI)            | Uncommitted drafts and presentation state in `localStorage`, optimistic overlay: `packages/ui/src/spec-document/SpecDocumentPane.tsx:252-303` (presentation + draft writes), `packages/ui/src/spec-document/specDocumentPresentationState.ts:91-109` (draft keys). Explicitly a guard, not a lock: `packages/ui/src/spec-document/useSpecDiscussion.ts:33-34` ("this is a UI guard, not a runtime-wide writer lock").                                                                                                                                                                                                                                                                                                                                                 | Durable truth; admission.                                                                          |

### 1.1 Detached panels keep one owner and one Host

The coordinator in Main owns the transfer: source release → child attach → readiness →
return, with rollback on timeout or child crash
(`packages/desktop/src/main/specDetachedPanels.ts:130-156`, `:248-260`). The child window
is created by Main with the default session (`packages/desktop/src/main/index.ts:2080-2108`)
and attaches to the **source window's existing Host** — never a second agent:
`packages/desktop/src/main/index.ts:2110-2114` throws "Original Host is unavailable; no
replacement is started." and `:2143-2155` posts `AttachServicePort` with
`clientMode: "desktop-continuous"`, `scope: { kind: "local" }`; child close posts
`DetachServicePort` `:2117-2125`. This is the correct one-Host-per-window shape and is kept
by this review.

### 1.2 Native document panes (gateway)

Per ADR [001](../architecture/decisions/001-document-host-adapters.md) (`:19-21`): one
opt-in gateway inside the existing desktop Host, no second agent, session-isolated MCP
helper; pre-mortem items `:23-30` already name the risks this review localizes in code.
The gateway lives in a window Host process (`packages/desktop/src/host/index.ts:3033-3051`),
serves the loopback HTTPS tool endpoint and WSS pane channel
(`packages/desktop/src/host/documentGateway.ts:148-223`), pairs panes into a
`web-remote-replayable` agent scope (`:236-265`), and routes per document binding
(`:268-309`). Native CLI commands are constrained to the binding's sessions
(`packages/desktop/src/host/documentGatewayAgent.ts:25-44`, `:126-146`) and the document
MCP server is injected only into gateway-created sessions (`:147-190`).

## 2. Recorded ownership collisions

All four are **unresolved** at `aa8236cf`. None is a reason to merge owners; each names
the smallest owner that can resolve it.

| ID  | Collision                                                                                     | Status     | Proposed owner                                                                               |
| --- | --------------------------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------- |
| C1  | Stale `binding.sessions` allow-list survives runtime restart and out-of-band deletion         | Unresolved | Gateway in the winning Host, fed by runtime session-lifecycle events from services           |
| C2  | Shared presentation `localStorage` key written by source and detached renderers with no lease | Unresolved | Renderer presentation-state module, keyed by surface with a single writer per panel identity |
| C3  | First-port-bind-wins document gateway; no `statePath` lease; dies with its host; no failover  | Unresolved | Main as single gateway broker for the app instance                                           |
| C4  | Gateway dispatch omits `workspaceIdentity` (path-only routing and binding key)                | Unresolved | Gateway protocol + dispatch, adopting the canonical identity key                             |

### C1 — stale `binding.sessions` allow-list

`requireSession` accepts any session id in the persisted list
(`packages/desktop/src/host/documentGatewayAgent.ts:36-39`). The list grows on create
(`:120`, `:198-199`) and shrinks **only** when `deleteSession` is acknowledged through
this gateway connection (`:201-204`). The list is persisted to `statePath` and restored
wholesale on start (`packages/desktop/src/host/documentGateway.ts:39-57`), and `bind`
re-attaches to the stored binding and returns the old sessions as truth (`:289-299`,
`:306`). The only runtime-lifecycle listener is `onAgentRuntimeRestarted`
(`:260-263`), which forwards an event but prunes nothing. Therefore: after a CLI runtime
restart, or after a session is deleted from the desktop app / another surface, the
allow-list still admits the dead id; the pane discovers it only when `subscribe`/rows
calls fail at use time. Checklist D-04 tracks delete-honesty through the gateway;
out-of-band invalidation is absent at HEAD.
Proposed owner: the gateway (in whichever Host holds it, see C3), subscribing to
session-lifecycle events from `IZCodeAgentService` and retracting dead ids from every
persisted binding — not a global session registry.

### C2 — unleased shared presentation `localStorage` key

The presentation key is `spec-harness-document-view:v1:<workspaceIdentity || path>`
(`packages/ui/src/spec-document/specDocumentPresentationState.ts:21-23`) and
`writeDocumentPresentation` is an unconditional `setItem` with no lease, generation or
surface identity (`:77-90`). `SpecDocumentPane` reads it once at mount
(`packages/ui/src/spec-document/SpecDocumentPane.tsx:120-121`) and writes it on every
state change and scroll (`:252-256`, `:272-292`, `:301-303`). A detached document panel
mounts the same pane (`packages/ui/src/spec-document/SpecDetachedPanelRoot.tsx:155-156`)
in a child window created with the default session
(`packages/desktop/src/main/index.ts:2080-2096`), i.e. sharing the same `localStorage`
origin. During handoff windows (boot before source release commits, rollback after
`panel-reattach-rollback` `packages/desktop/src/main/specDetachedPanels.ts:139-143`) two
renderers can transiently mount the same document; last writer wins and the reopen state
(scroll, layout, active thread) silently follows whichever surface wrote last. The draft
keys under the same prefix (`packages/ui/src/spec-document/specDocumentPresentationState.ts:91-109`) share the exposure.
Proposed owner: the presentation-state module (same file) — either a per-surface key
segment (source vs detached generation from the transfer `generation`) or an explicit
lease token handed over by the Main transfer state machine; localStorage stays
renderer-owned, no new global state.

### C3 — first-port-bind-wins gateway, no `statePath` lease

`ZCODE_DOCUMENT_GATEWAY_CONFIG` is process env set for the whole app launch by the
prototype launcher (`prototypes/document-host/Start-Document-Harness.ps1:9-13`) and is
inherited by **every** host fork (`packages/desktop/src/main/desktopRuntimeEnv.ts:488-505`
→ `:285-293`; fork at `packages/desktop/src/main/desktopHostProcess.ts:270-292`). Each
host process independently attempts `startDocumentGateway`
(`packages/desktop/src/host/index.ts:3033-3034`); the guard `!documentGatewayStart` is
per-process only. The gateway binds `config.port` on loopback
(`packages/desktop/src/host/documentGateway.ts:384-387`), so whichever window's host
forks first wins — it need not be the window that enabled the gateway. Losers reject on
`EADDRINUSE` and log "document gateway unavailable; desktop continues normally"
(`packages/desktop/src/host/index.ts:3048-3050`) and never retry (the settled promise
keeps the guard). Consequences: (a) ownership is implicit and unauditable; (b) when the
winning host's window closes and the host disposes, the gateway dies with it and no other
host takes over (`:3041-3043`); (c) `config.statePath`
(`packages/desktop/src/host/documentGatewayProtocol.ts:30`) has no lease — `persist()`
is a plain tmp-file + rename (`packages/desktop/src/host/documentGateway.ts:58-68`), so
any future second instance on a different port sharing a `statePath` would silently
last-write-win the bindings file. Today only the port winner can reach `persist()`, so
(c) is latent, not active.
Proposed owner: Main — one explicit broker decides which host (or main itself) owns the
gateway for the app instance, records it, and either relocates it on owner exit or fails
loudly; plus a `statePath` lease (lock file or exclusive create) inside
`startDocumentGateway` before any write. Not a second global Host.

### C4 — `workspaceIdentity` omitted in gateway dispatch

Every agent call from the gateway is built as
`const workspace = { workspacePath: binding.workspacePath }`
(`packages/desktop/src/host/documentGatewayAgent.ts:44`, used at `:59-67`, `:87-99`,
`:112`, `:192`). The persisted `Binding` schema has `workspacePath` only — no
`workspaceIdentity` field (`packages/desktop/src/host/documentGateway.ts:40-52`) — and
`bind` canonicalizes the workspace by `realpath` alone
(`:272-286`), so the binding key collapses any identity distinction onto one path. This
contradicts the rest of the stack: the agent target type carries optional
`workspaceIdentity`/`remoteSessionId`
(`packages/services/src/zcode-agent/zcodeAgentPluginParams.ts:9-14`), the CLI canonical
key is `workspaceIdentity?.trim() || workspacePath`
(`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/persistent-command-index.ts:28`),
the window remote registry keys and validates by identity
(`packages/desktop/src/host/windowRemoteConnectionRegistry.ts:542`, `:656-673`), and the
spec-document composer sends `workspaceId: workspaceIdentity?.trim() || workspacePath`
(`packages/ui/src/spec-document/useSpecDiscussion.ts:264`). Practically the gateway is
local-path-only today (the pane is a native document host on the same machine), but that
limit is undeclared: nothing in the config schema or bind rejects a remote-identity
workspace, and `createSession` through the gateway requires `payload.workspaceId ===
binding.workspacePath` (`packages/desktop/src/host/documentGatewayAgent.ts:150`), so a remote-identity workspace
cannot be expressed at all. Collision risk: two identities sharing one path would merge
into one binding with one secret.
Proposed owner: `documentGatewayProtocol.ts` (add `workspaceIdentity` to the persisted
binding, identity-aware binding key) + `packages/desktop/src/host/documentGatewayAgent.ts:44` (dispatch the
canonical key). Local-path-only can remain an accepted, now-explicit, constraint.

## 3. Missing boundaries

| ID  | Missing boundary                                                                                 | Status                                                        | Proposed owner                                         |
| --- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- | ------------------------------------------------------ |
| B1  | Runtime-wide writer lease for verified Markdown saves                                            | Accepted interim (saves refused, read-only); lease unresolved | Services runtime / CLI as sole writer via document MCP |
| B2  | Cross-surface composer policy (one policy for main window, detached panel, gateway pane, remote) | Unresolved                                                    | CLI runtime admission with surface attribution         |
| B3  | External-deletion retraction for document bindings                                               | Unresolved (extends C1)                                       | Gateway via services session-lifecycle events          |
| B4  | Gateway single-owner negotiation (cross-process)                                                 | Unresolved (extends C3)                                       | Main broker + `statePath` lease                        |
| B5  | Real-GUI handoff verification unexecuted                                                         | Unresolved, blocked by the closed live-runtime gate           | Root, when the user releases the gate                  |

### B1 — runtime-wide writer lease for verified Markdown saves

The service is explicit that the lease does not exist:
`packages/services/src/spec-document/specDocumentService.ts:9-12` — `allowUnleasedWrites`
is "Disposable development fixtures only, until a runtime-wide writer lease exists"; the
product registration passes no such flag
(`packages/services/src/node.ts:2381-2385`), so `save` always throws "Documents is
read-only until a shared writer lease is implemented" (`packages/services/src/spec-document/specDocumentService.ts:106-108`).
The internal `writeQueue` serializes only this one service instance ("External tools are
not part of this queue", `:109-110`); correctness against external writers is detection,
not serialization: CAS on `expectedSha256` (`:113-120`) plus revalidation after staging
(`:128-131`). Acceptance status: the read-only refusal is an **accepted** interim
behavior; the lease itself is **unresolved**. Proposed owner: a workspace-scoped write
lease issued by the services runtime (or funneling all writes through the CLI session's
document MCP tool, making the CLI runtime the single writer — consistent with ADR 001
`:30`, which already warns that the chat can write files through other tools and needs a
separate policy). The CAS stays as the last line of defense either way.

### B2 — cross-surface composer policy

Each surface invents its own gate. The spec-document prototype: idle-only sends, no queue
or guide policy (`packages/ui/src/spec-document/useSpecDiscussion.ts:221`), gated on a
local projection snapshot (`:222-228`) using `nativeSessionHasWriters`, a phase heuristic
over the observed snapshot (`:22-31`); the companion hook states outright it is "a UI
guard, not a runtime-wide writer lock" (`:33-34`). The detached panel checks composition
only within its own renderer DOM before returning
(`packages/ui/src/spec-document/SpecDetachedPanelRoot.tsx:63-71`). The gateway pane sends
`sendText` after only session-ownership and command-envelope checks
(`packages/desktop/src/host/documentGatewayAgent.ts:126-146`). The desktop main composer
applies its own policy. The only runtime-level serializer is the CLI `CommandInbox`
per-session gate (`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/command-inbox.ts:107-131`),
which is surface-agnostic: it cannot express "this surface may compose while that one is
queued", so two surfaces targeting the same session interleave by arrival order. Status:
**unresolved**. Proposed owner: the CLI runtime admission as the single policy point (it
already serializes per session), extended with surface attribution in the envelope so
every surface renders the same admission verdict; surfaces keep only drafts and the
optimistic overlay, which matches the existing rule that renderers never own admission.

### B3 — no external-deletion retraction

There is no path by which a session deleted outside this gateway connection removes the
id from persisted bindings: the gateway subscribes to dynamic conversation frames
(`packages/desktop/src/host/documentGatewayAgent.ts:57-62`) and runtime restarts
(`packages/desktop/src/host/documentGateway.ts:260-263`) only; deletion bookkeeping
exists solely for `deleteSession` acked through the connection
(`packages/desktop/src/host/documentGatewayAgent.ts:201-204`). Durable bindings therefore outlive their sessions
across restarts (`packages/desktop/src/host/documentGateway.ts:39-57`, `:289-299`). This is the persistence half of
C1; the checklist tracks the UX half as D-04
([IMPLEMENTATION-CHECKLIST.md](IMPLEMENTATION-CHECKLIST.md) HEAD `:59`). Status:
**unresolved**. Proposed owner: same as C1 — the gateway retracting from services
session-lifecycle events, so reopening a document never offers a resurrected thread
(deleting must also remove durable bindings, per D-04's wording).

### B4 — no gateway single-owner negotiation

The "one active pane per document" check compares only live connections inside the single
winning process (`packages/desktop/src/host/documentGateway.ts:287-288`); there is no
negotiation across host processes or app instances (see C3: implicit port winner, no
`statePath` lease, no failover when the owner exits). A second app instance with the same
config would race for the port and, on a differing port with a shared `statePath`, race
for the bindings file. Status: **unresolved**; accepted only in the single-instance,
single-host reality the prototype launcher produces today. Proposed owner: Main broker +
exclusive `statePath` lease, as in C3.

### B5 — real-GUI handoff verification unexecuted

The detach/return state machine is verified only against a hand-rolled fake
`BrowserWindow` in a VM fixture (`packages/desktop/test/specDetachedPanels.test.mjs:12-59`;
checklist W-00 at HEAD `:64` records "passed with fake Electron"). W-01 (handshake
correctness in real GUI) and W-02 (early/repeated Return, X, hidden Main, missing parent,
renderer crash, lost Host) remain open (`:65-66`), and the live runtime gate is closed
(`:28`), so no real-GUI evidence exists or is claimed. Status: **unresolved, blocked** by
the runtime gate, not by missing code. Proposed owner: root, executing W-01/W-02 only
after an explicit fresh user release of the gate.

## 4. What this review does not change

No source, protocol, manifest or runtime artifact was modified. No owner consolidation is
proposed: window-scoped Hosts, the per-window remote registry, Main's transfer/coordinator
role, the services scopes and the CLI admission each keep their legitimate ownership; the
proposals above only add leases, retraction events, identity keys and a broker where a
boundary is missing. Live GUI/model/performance acceptance remains open per the checklist.

## 5. Verification record

- Revision: `git rev-parse HEAD` → `aa8236cfaa3e87eac03000e397720d0ec1cb878c` (branch
  `dev`), recorded before writing. All citations were obtained by reading HEAD content:
  unmodified files by direct `Read`/`git grep` (working tree equals HEAD for them:
  `documentGateway.ts`, `documentGatewayAgent.ts`, `documentGatewayProtocol.ts`,
  `zcodeAgentPluginParams.ts`, `zcodeAgentConnectionScope.ts`, `command-inbox.ts`,
  `persistent-command-index.ts`, `desktopHostProcess.ts`, `desktopRuntimeEnv.ts`,
  `specDetachedPanels.test.mjs`, `host/index.ts`, `main/index.ts`); files with in-flight
  Wave 1 working-tree edits by `git show aa8236cf:<path>` with line numbering
  (`specDetachedPanels.ts`, `specDocumentPresentationState.ts`, `SpecDocumentPane.tsx`,
  `SpecDetachedPanelRoot.tsx`, `useSpecDiscussion.ts`, `specDocumentService.ts`,
  `services/node.ts`, `windowRemoteConnectionRegistry.ts`,
  `docs/spec-harness/IMPLEMENTATION-CHECKLIST.md`).
- Post-write spot-check: a scripted re-read of every cited `path:line` range against
  `git show aa8236cf:<path>` (command and output in the task result, not stored here).
- Format: `node_modules\.bin\oxfmt --check docs/spec-harness/ARCHITECTURE-REVIEW.md`.
- Local links: relative links in this file resolve to files present at HEAD
  (`IMPLEMENTATION-CHECKLIST.md`, `../architecture/decisions/001-document-host-adapters.md`).
- Toolchain: shell node 24.13.1 (`node --version`); `mise.toml` pins 24.14.0 and mise is
  not on PATH — patch-level deviation, accepted and recorded per checklist root state.
- Not run (and why): `pnpm typecheck`, `pnpm lint`, architecture checks — this task
  changed one markdown file only; the trio runs once at wave end under the orchestrator.
  No unit/fixture test was run because no code changed. No live runtime, Electron app,
  Office/CAD host or model prompt was touched (runtime gate honored).
