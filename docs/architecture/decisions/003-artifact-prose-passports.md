# Artifact passports as five prose blocks

Date: 2026-10-17. Status: accepted for this bounded implementation.

## Context and drivers

The user wants detailed document assembly instructions without a field-heavy
form or JSON procedure syntax. Preserve existing instructions, one writer and
explicit context activation. Tools remain the execution owners.

## Options and decision

Considered UI aliases over legacy fields, additive blocks plus a legacy shadow,
and canonical five-block records with legacy reading. Choose canonical blocks:
role, template, data, assembly and acceptance. The shared pure projection serves
both editor and context, keeping one visible instruction representation.

Read stores v1/v2 and write v2. Older writers must refuse rather than erase new
blocks. Unchanged legacy records can coexist with new records; reading does not
migrate them. Preserve the stable passport id when saving. A public pure helper
subpath keeps the UI independent of the service barrel's runtime import graph.

## Consequences and review

Detailed old step fields remain labelled text. No automatic reconstruction of
the original step JSON, agent routing, reference expansion or execution is added.
Explicit limits refuse oversized input without truncation. Service, UI and
independent review considered the transition; no blocking findings remain.
The weighted option matrix, pre-mortem, acceptance and decision-journal trigger
are recorded in [the feature contract](../../spec-harness/ARTIFACT-TEXT-BLOCKS.md).
