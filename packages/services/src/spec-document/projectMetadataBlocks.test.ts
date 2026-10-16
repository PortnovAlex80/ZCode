import assert from "node:assert/strict";
import { test } from "vitest";
import type { ProjectMetadataInput } from "./projectMetadata.js";
import { projectMetadataBlocks } from "./projectMetadataBlocks.js";

test("legacy projection preserves all labelled step values and whitespace without guessing a template", () => {
  const legacy: ProjectMetadataInput = {
    kind: "document",
    purpose: "  Document purpose\n",
    type: "note",
    sources: ["  input.txt\nsource detail"],
    links: ["template-maybe.docx"],
    methods: ["  method\n  indentation"],
    instructions: "\n  general instruction\n",
    skills: ["skills/title.md"],
    checklist: ["  criterion one\n  detail", "criterion two"],
    steps: [
      {
        title: "  Prepare  ",
        instruction: "\n  exact instruction\n",
        tool: { transport: "mcp", connection: "  odn local  ", operation: "  documents.read  " },
        input: '```json\n  {"id": "original"}\n```',
        expected: "  expected text\n",
        onFailure: "\n  Stop and report\n",
      },
      {
        title: "REST step",
        instruction: "Use configured connector",
        tool: { transport: "rest", operation: "requisites.read" },
      },
      {
        title: "File step",
        instruction: "Use owned file",
        tool: { transport: "file", operation: "document.edit" },
        input: "",
        expected: "",
        onFailure: "",
      },
    ],
  };
  const before = JSON.stringify(legacy);
  const blocks = projectMetadataBlocks(legacy);
  assert.equal(JSON.stringify(legacy), before);
  assert.match(blocks.role, /^  Document purpose\n/);
  assert.match(blocks.role, /Artifact type:\nnote/);
  assert.equal(blocks.template, "");
  assert.match(blocks.data, /Sources:\n  input\.txt\nsource detail/);
  assert.match(blocks.data, /Related materials:\ntemplate-maybe\.docx/);
  for (const value of [
    legacy.instructions!,
    ...legacy.methods!,
    ...legacy.skills!,
    ...legacy
      .steps!.flatMap((step) => [
        step.title,
        step.instruction,
        step.input,
        step.expected,
        step.onFailure,
        step.tool?.transport,
        step.tool?.connection,
        step.tool?.operation,
      ])
      .filter((value): value is string => value !== undefined),
  ]) {
    assert.ok(
      blocks.assembly.includes(value),
      `Projection lost known step/instruction value: ${JSON.stringify(value)}`,
    );
  }
  assert.ok(blocks.assembly.indexOf("Step 1:") < blocks.assembly.indexOf("Step 2:"));
  assert.match(blocks.assembly, /Input:\n\n\nExpected result:\n\n\nOn failure:\n$/);
  assert.equal(blocks.acceptance, "  criterion one\n  detail\ncriterion two");
});

test("canonical empty text remains intentional and projection returns an independent plain object", () => {
  const empty = { role: "", template: "", data: "", assembly: "", acceptance: "" };
  assert.deepEqual(projectMetadataBlocks(), empty);
  const entry: ProjectMetadataInput = { kind: "document", blocks: empty };
  const projected = projectMetadataBlocks(entry);
  assert.deepEqual(projected, empty);
  projected.role = "Local editor draft";
  assert.equal(entry.blocks?.role, "");
});
