# Artifact passports: five prose blocks

2026-10-17. Supersedes the field-heavy editor in ARTIFACT-HARNESS-MVP.md.
The user requested a document assembly map written as ordinary text, stored in JSON.

## Contract

Each passport has five multiline strings in `blocks`: `role`, `template`, `data`,
`assembly`, `acceptance`. Role describes purpose and project position; template
describes structure/layout and the actual template; data binds document elements
to explicit sources; assembly describes operations and exact available tool calls;
acceptance contains criteria and evidence requirements. Markdown, checklists,
paths and fenced call examples are ordinary text. No JSON steps editor or type
selector is required. Empty blocks are valid; whitespace is preserved.

The existing service remains the sole writer of `.harness/project.json`.
Path, kind, id and updatedAt remain service/binding metadata. New records store
only those and blocks. The implementation reads stores version 1 and 2; writes
version 2 so an older binary refuses instead of dropping a new-format passport.
Reject mixed legacy+blocks records, malformed known fields and oversized content.

Legacy records remain readable and are not rewritten on opening. A shared pure
projection maps purpose/type to role, sources/links to data, instructions/methods/
skills/ordered steps to assembly, checklist to acceptance. Template remains empty:
do not guess it from arbitrary references. Every step retains title, instruction,
transport, connection, operation, input, expected and failure text. A user save
replaces that record with its five visible blocks, retaining id/kind. There is no
second hidden instruction snapshot to conflict with the edited text.

Root/folder/file inheritance, explicit per-discussion activation, fresh resolve
before sending and existing permissions/admission remain unchanged. Agent context
contains one readable projection per source passport, in five named sections;
omit empty sections and service-only IDs/timestamps. Do not duplicate raw JSON.
Referenced sources are not automatically expanded. Prose tool calls are never
executed by the metadata service. No automatic agent routing is introduced.

```text
five-text editor → existing service → atomic project.json v2
legacy record ── pure projection ──┬─ editor draft (no write)
                                 └─ resolve root/folders/file → native send
```

## Acceptance

- Existing detailed steps and checklists survive projection, save and reopen.
- Exactly five prose fields, with scope selection; code examples need no JSON parsing.
- Deliberately empty blocks stay empty; significant whitespace survives round-trip.
- Agent text is readable, source-labelled and contains each instruction once.
- Invalid input/read failures preserve the current file and the user's draft.
- Focused service/UI/send tests; typecheck, lint, architecture; isolated GUI.
- Existing real documents and unrelated local changes are preserved.

## Decision record

Complicated compatibility decision; options independently reviewed by service, UI
and review agents. Criteria weights: correctness/data preservation 40%, user fit
30%, single owner/representation 20%, reversibility/cost 10%. Scores 1–5:

| Option | Correctness | User fit | One representation | Cost | Weighted |
|---|---:|---:|---:|---:|---:|
| UI aliases over legacy fields | 2 | 3 | 2 | 5 | 2.6 |
| Five blocks plus active legacy shadow, v1 | 3 | 5 | 2 | 4 | 3.5 |
| Canonical five blocks, legacy read, v2 write | 5 | 5 | 5 | 3 | 4.8 |

Root chooses canonical blocks: the editor and sent context share one projection;
the store version makes old-writer refusal explicit. A single Markdown string
would require parsing user headings back into five UI fields and is not selected.

Pre-mortem: lossy legacy mapping (retain all labelled values, test real call shapes);
old binary overwrites blocks (v2 refusal); empty values resurrect old instructions
(no shadow fallback); long procedures silently truncate (explicit bounds/errors).
The original legacy structure is not reconstructible from prose after saving;
Git/backups retain history, and opening alone performs no conversion on disk.

Decision journal: 2026-10-17. Expect users to edit complete document instructions
without JSON syntax and agent previews to match the five fields. Review on the
next real title-sheet revision. Engineering validation/execution remain with tools.
