# 005: Independent document surfaces with optional native attachment

Date: 2026-10-18. Status: implementation authorized.

## Context and drivers

A detached conversation currently contains only its Workbench leaf. Documents
remain in the main shell; sidebar focus short-circuits owner navigation, hiding
the path back to those tabs. User explicitly chose independent document windows
instead of a combined chat/document workbench. Preserve stable editors, immutable
project/session ownership, existing Host and shutdown/geometry persistence.

## Options and decision

Three read-only investigations considered an outer document portal, native linked
windows and a combined UI surface. Classification: complicated. Scores 1–5:

| Option                                              | Correctness 40% | Reuse 25% | Delivery 20% | Reversibility 15% | Total |
| --------------------------------------------------- | --------------: | --------: | -----------: | ----------------: | ----: |
| Stable document portal + explicit native attachment |               5 |         5 |            4 |                 4 |  4.65 |
| Combined chat/document UI window                    |               2 |         3 |            3 |                 4 |  2.75 |
| Automatic drag-edge native magnet                   |               4 |         3 |            1 |                 3 |  2.95 |

Choose a stable outer document portal and explicit native attachment. A combined
window contradicts independent OS documents; drag-edge detection adds ambiguous
pairing and monitor complexity. UI retains desired relation by addressed parent;
Main validates opaque frames from the same owner and controls live geometry.

Pre-mortem/Red Team: nested portals can lose drafts if remounted; use one stable
host and union retention of whole-document/discussion popouts. Main project can
retarget documents; retain immutable scope and parent. Programmatic move events
can loop; suppress expected bounds, suspend unfit/maximized pairs. Restore can
race native geometry; link only after hydration and both children exist. Closed
partners must never be recreated by attachment replay. Document dropdowns and
keyboard handlers must use their actual presentation document where necessary.
Separate full-document keys preserve legacy detached discussions.

## Consequences and decision journal

Native windows remain independently closable and document content remains in the
existing React/Host tree. One optional platform command is added, without child
preload privileges or arbitrary native window IDs. Explicit attach is offered for
the original parent conversation; it never selects a different session implicitly.

Expectation: project changes, reload and restart retain exactly one editor and
the same parent; moving a linked pair cannot recurse or strand a partner offscreen.
Review trigger: focused tests and isolated GUI acceptance for this change, then
any report of lost document access, wrong-project edits or grouping failure.
