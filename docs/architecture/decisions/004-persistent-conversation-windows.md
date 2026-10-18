# 004: Persistent addressed conversation windows

Date: 2026-10-18. Status: implementation authorized by the user.

## Decision

Keep the same-origin native portal selected in ADR 002. Retain an application-level
roster of explicitly addressed session surfaces, independent of sidebar selection.
Each detached session uses one unique Workbench leaf and its existing scoped
conversation provider, not another complete App or split workbench. All ordinary
leaves guard against mounting a second composer for a detached session. Native
Main owns normal bounds, maximized state and display recovery; the UI owns desired
open surfaces. Explicit Return/child close clears open intent; reload/quit retains
it. Restoration never submits a prompt or starts a run.

Document discussions retain their document owner and exact thread association.
Per-conversation document state and native geometry must not use a project-only key.
Callbacks must carry the surface's original scope; current-project Git status must
never leak into a different project's conversation. Window-local keyboard handling
uses the actual presentation document.

## Alternatives and review

Classification: complicated. Three independent read-only investigations inspected
the leaf, shell/service binding and native placement paths. Criteria and scores
(1–5, engineering estimates):

| Option | Ownership correctness 40% | Existing runtime reuse 30% | Delivery cost 20% | Testability 10% | Total |
| --- | ---: | ---: | ---: | ---: | ---: |
| Retained explicit leaves and native portal | 5 | 5 | 4 | 4 | 4.7 |
| Clone complete App/workbench per window | 1 | 2 | 3 | 2 | 1.8 |
| Independent renderer and transfer protocol | 4 | 3 | 1 | 3 | 2.9 |

Choose retained leaves: complete workbench copies share global split stores and
primary pane IDs, while independent renderers would reopen ADR 002 and expand the
runtime handoff boundary. Red-team review requires guarding every split leaf,
scoped callbacks, restored-target admission, stable IDs, close/teardown separation
and presentation-window Escape handling. These are implementation requirements.

Pre-mortem: duplicate composers, project retargeting, offscreen windows, lost
reopen intent and global keyboard commands are the main failure modes. Mitigate
with canonical session claims, immutable scope descriptors, work-area recovery,
separate lifecycle causes and window-local listeners. Existing Host and native
command admission remain authoritative. No new dependency or execution queue.

## Verification

Exercise A1+A2+B1 across two projects, independent drafts, sidebar focus without
duplication, return/close, reload and process restart, negative coordinates and
missing displays, document discussion recovery and correct keyboard targets.
Record actual GUI/build evidence in the implementation checklist.
