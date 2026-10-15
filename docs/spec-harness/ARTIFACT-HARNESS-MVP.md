# Artifact harness: MD/TXT pilot

Date: 2026-10-15. Implements AH-01..AH-03 and the bounded instructional part of
AH-04. The user's authorization starts implementation and production packaging.
This extends [the concept](ARTIFACT-HARNESS-PLAN.md); rename/copy/import, evidence
automation and a workflow executor remain later stages.

## Product behavior

An artifact passport contains purpose, sources, links and methods plus optional
instructions, skill references, checklist and ordered procedure steps. A step has
`title`, `instruction`, optional `tool` (`transport`: file/mcp/rest, logical
`connection`, `operation`), `input`, `expected`, and `onFailure`. These are agent
instructions, not executable transport configuration. MCP stdio/HTTP, REST URLs,
credentials, tool permissions and execution remain owned by existing integrations
and the native agent runtime. No command or network request runs on opening metadata.

The existing `.harness/project.json` service is the sole passport writer. Extend
version 1 additively; existing entries remain readable. `.` explicitly identifies
the project root (folder kind). Normalized relative paths identify folders/files;
reject traversal, absolute paths and metadata-store symlinks. Unknown top-level
fields remain preserved, invalid known fields fail visibly, writes stay serialized
and atomic. Expose the existing service through ServiceCollection/accessor/client
RPC rather than direct renderer filesystem access.

`resolve({workspacePath,path})` returns `{path,revision,entries,text}` where entries
are `{path,entry}` in root → ancestor folders → selected artifact order. Only exact
ancestor folder entries inherit; sibling documents never do. The revision identifies
the assembled content. Include provenance and all applicable instructions without
silently resolving contradictory rules. References are listed, not automatically
expanded into full documents. Context is bounded; overflow errors instead of
silently truncating a procedure. Source filenames are not proof of tool availability.

## Activation and UI

Document header offers metadata editing for the current file, its parent folders
and project root. Document picker rows offer a metadata action where practical.
An editor saves purpose, instructions, references, checklist and steps with visible
validation errors. Do not seed real project requisites or overwrite user documents.

Each document discussion has an explicit Context menu: without metadata (default),
use metadata, inspect assembled context, edit passports. Persist this choice with
the existing durable discussion binding; it survives dock/float/native handoff.
Enabling does not dispatch a model request. Show source paths and preview revision.
Explain that previously sent context remains in existing conversation history when
disabled; a new discussion gives a clean history.

Every new send in an enabled document discussion resolves the current passport
before native command admission. A failed resolution prevents sending and leaves
the draft. Freeze the resolved text into the accepted native envelope; reconciliation
never re-resolves/replays an unknown command. Parent chat history and whole documents
are not silently attached. Normal first-send document/fragment binding remains.
Existing attachments, config barriers, send flags, native history and writer leases
must remain intact. Preview is informational and is not the accepted execution owner.
Enabled artifact context supports regular messages and `/plan <task>`. Other
slash actions (including goal creation or opening another conversation) are refused
before command admission rather than silently omitting the artifact context.

```text
editor → metadata service → atomic project.json
send → resolve fresh context → native config/admission → existing runtime/tools
            └── preview snapshot (derived, no second store)
```

Desktop local is supported; remote/nonlocal hosts fail explicitly. No new protocol
queue, model client, runtime, paid prompt or standalone REST executor is introduced.

## ODN pilot

Ship an editable example project under `examples/artifact-harness-odn`: TXT
requisites (clearly fictional training data), MD title template, working MD title,
local skill, project and folder passports and a title-specific procedure/checklist.
The procedure reads the TXT/template, identifies missing fields, updates the title
preserving author text, and reports checks. Leave actual PDF layout and engineering
calculation as separate actions. No claims of GOST compliance or actual ODN results.
Provide Russian instructions to open the folder, enable Context and send a short
request. The same passport can later bind requisite retrieval to an existing MCP or
REST tool; unresolved logical bindings stay visible and must not be invented.

## Verification and delivery

Focused tests cover old records, additive fields/root, invalid storage/path/link,
inheritance/isolation/revision and bounded context; UI editor/activation and send
preparation cover refreshed metadata, failures, drafts and preserved native options.
Run typecheck, lint and changed architecture; isolated Electron GUI smoke exercises
example selection/editor/context preview without calling a model. Rebuild production
and Windows installer into `packages/desktop/dist`, preserve shortcuts/profiles.
User-controlled live agent/title acceptance remains distinct from fixture/GUI checks.
