# 002: Desktop-wide chat and discussion windows

Date: 2026-10-15. Status: option B selected after isolated Electron proof; product live
acceptance remains open. Classification: complicated, with an experimental
window-bootstrap risk. Baseline: `e181522b`.
[Plan and gates](../../spec-harness/FLOATING-WINDOWS-REFACTOR-PLAN.md).
The user explicitly released the stopped ZCode runtime for repair and validation on 2026-10-15.

## Repair decision: stable same-origin portal (supersedes original option A selection)

Review of the separate `floating-windows` branch found an unfinished auxiliary renderer
that displayed a placeholder and discarded its transferred port. Importing it would
not deliver working conversations; its ownership grant also preceded readiness.
The branch was not integrated. Use option B for this repair: Main permits only the
bounded conversation popup route; Electron creates the native child and the existing
React owner moves its stable DOM container. No new Host, session or command writer is created.

The isolated Electron proof (`packages/desktop/scripts/conversation-native-window-proof.mjs`)
passed with contextIsolation and sandbox enabled and nodeIntegration disabled:
same input DOM node and changed draft survived detach/return, the original click
handler fired, styles applied, and the child acquired nonzero native layout.
This is feasibility evidence, not full product acceptance. Wait for usable child
layout before adoption; keep return/close handling idempotent and independent per surface.

The child depends on the opener renderer. Do not claim independent crash recovery:
opener shutdown closes its children; preserve existing Host/session persistence semantics.
Verify product draft, attachments, scroll, focus, repeated cycles and multiple windows
before marking GUI acceptance complete. Original option A analysis below is historical.

## Context and decision drivers

The user needs chat/discussion windows that move freely across monitors.
Current floating UI is bounded by the document DOM container; Document PiP is
disabled in Electron. U-06/U-07 demanded OS windows while prohibiting Main-process
machinery. This plan resolves that contradiction without restoring retired
project-window or Office/AutoCAD functionality.

Drivers from AGENTS and current contracts: one native owner; no second Host,
agent or accepted-command queue; UI-state preservation; explicit ownership/ACK;
closed runtime gate; bounded scope; desktop-continuous and web-remote-replayable
semantics retained.

## Options

A. Dedicated auxiliary BrowserWindow, minimal renderer, existing Host attachment,
explicit UI-state handoff and sender-bound ownership.
Advantages: documented OS-window mechanism, independence from main-renderer DOM,
existing AttachServicePort support.
Costs: composer/scroll restoration and fencing require implementation; ordinary
createWindow lifecycle is unsuitable.

B. Controlled same-origin window.open with a stable React portal.
Electron documents opener access to same-origin children:
[window.open](https://www.electronjs.org/docs/latest/api/window-open).
Advantages: preserves React subtree with less serialization.
Risks: UI lifetime depends on opener renderer; ownerDocument, focus/IME and
preload inheritance require actual proof. about:blank inherits opener preferences.
Do not weaken isolation for DOM access. This is a real alternative, not a claim
that arbitrary independent native windows can adopt another renderer's DOM.

C. Retained WebContentsView moved between native containers.
Advantages: the same renderer survives placement changes.
Costs: the surface needs a dedicated renderer from its first docked mount;
a React subtree cannot simply be extracted from the main renderer.
Native overlays/stacking/geometry expand scope. BaseWindow requires explicit
webContents cleanup.
[WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view),
[BaseWindow](https://www.electronjs.org/docs/latest/api/base-window).

## Comparison and decision

Scores: 1-5, higher is better. These are engineering estimates, not measurements.
Implementation ease scores development cost, not runtime price.

| Option | Correctness/recovery 35% | Isolation/ownership 25% | Implementation ease 20% | Testability 10% | Reversibility 10% | Total |
| ------ | -----------------------: | ----------------------: | ----------------------: | --------------: | ----------------: | ----: |
| A      |                        4 |                       5 |                       3 |               5 |                 4 |  4.15 |
| B      |                        3 |                       4 |                       4 |               3 |                 4 |  3.55 |
| C      |                        4 |                       4 |                       1 |               3 |                 2 |  3.10 |

Select A because live-Host attachment already exists and the explicit source/target
boundary permits ownership/failure/recovery checks without relying on live opener
DOM. Selection is conditional on contract Wave 1 and then actual isolated Electron
acceptance. Scores are not feasibility proof. Implement one discussion surface
first, then main chat through the same mechanism.
Keep B available for separate reconsideration if A requires an unacceptable runtime
rewrite. C requires evidence of benefit and separate scope.

## Independent challenge and pre-mortem

Three read-only agents independently explored A/B/C. The C researcher then
challenged A as Red Team.

| Failure mode                                                  | Required mitigation                                                                                                                 |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Both composers submit after ACK, including delayed callbacks. | Host service fences old sender/generation before native dispatch; disabled UI is insufficient; existing queue retained.             |
| New window creates a Host, or X kills a run.                  | Dedicated auxiliary lifecycle, existing Host attachment; main X retains owner while children exist; explicit Quit remains separate. |
| Remount loses draft/attachments.                              | Versioned acknowledged payload, ready references, refusal during IME/pending ingestion; X waits for destination restore.            |
| Main crash makes Return impossible.                           | Addressed restore target, live-Host reattachment, latest ACK revision recovery; no child destruction on timeout.                    |
| Child modifies another session/config.                        | Validated scope/sender, one existing config owner; independent document/web observers remain authorized.                            |

The strongest Red Team objection was that global per-session exclusivity would
change observation semantics. Limit ownership to the transferred logical surface;
retain existing admission rules for independent observers.
Main coordinates placement; Host service owns sender fencing. They are not
competing command authorities.

Document review also separated immutable surfaceId from changing session bindings
and connection generations. Reconnect/draft promotion must not create another
surface or lose its draft. The verification matrix includes these cases.

## Consequences and decision journal

Supersede PiP-only/shared-slot desktop requirements in U-06/U-07.
Multiple windows do not create new agents. Source becomes a placeholder/control
owner, not a hidden heavy presentation copy. Native geometry is independent of
document bounds. Normal transitions preserve the full current draft; crash recovery
guarantees acknowledged revisions only. Hot recovery differs from restart persistence.

Expected outcomes: zero new Hosts/native sessions caused by Detach/Return,
one active writer per transferred surface, zero stale-generation commands after
release, preserved draft/attachments/scroll and no retained auxiliary resources
after 20 cycles.

Revisit if contract gates fail, same-Host attachment is unsafe, GUI input/IME or
recovery fails, or measured costs exceed recorded budgets. A 30/90-day retrospective
does not replace release gates.

Include this record and actual evidence in the future implementation review/commit.
This planning update performs no code change, merge, build or install.
