import type {
  ProjectMetadataEntry,
  ProjectMetadataInput,
  ProjectMetadataStep,
} from "@zcode/services";

export interface ArtifactMetadataDraft {
  purpose: string;
  type: ProjectMetadataInput["type"];
  instructions: string;
  sources: string;
  links: string;
  methods: string;
  skills: string;
  checklist: string;
  steps: string;
}

export function artifactMetadataDraft(entry?: ProjectMetadataEntry): ArtifactMetadataDraft {
  return {
    purpose: entry?.purpose ?? "",
    type: entry?.type ?? "other",
    instructions: entry?.instructions ?? "",
    sources: entry?.sources.join("\n") ?? "",
    links: entry?.links.join("\n") ?? "",
    methods: entry?.methods.join("\n") ?? "",
    skills: entry?.skills?.join("\n") ?? "",
    checklist: entry?.checklist?.join("\n") ?? "",
    steps: JSON.stringify(entry?.steps ?? [], null, 2),
  };
}

export function artifactMetadataScopes(path: string): string[] {
  const parts = path.replaceAll("\\", "/").split("/").filter(Boolean);
  const scopes: string[] = [];
  while (parts.length) {
    const candidate = parts.join("/");
    if (candidate !== ".") scopes.push(candidate);
    parts.pop();
  }
  return [...scopes, "."];
}

function parseSteps(text: string): ProjectMetadataStep[] {
  const value: unknown = JSON.parse(text.trim() || "[]");
  if (!Array.isArray(value)) throw new Error("steps");
  for (const step of value) {
    if (
      !step ||
      typeof step !== "object" ||
      typeof step.title !== "string" ||
      !step.title.trim() ||
      typeof step.instruction !== "string" ||
      !step.instruction.trim()
    ) {
      throw new Error("steps");
    }
    for (const key of ["input", "expected", "onFailure"]) {
      if (step[key] !== undefined && typeof step[key] !== "string") throw new Error("steps");
    }
    if (
      step.tool !== undefined &&
      (!step.tool ||
        typeof step.tool !== "object" ||
        !["file", "mcp", "rest"].includes(step.tool.transport) ||
        (step.tool.connection !== undefined && typeof step.tool.connection !== "string") ||
        typeof step.tool.operation !== "string" ||
        !step.tool.operation.trim())
    ) {
      throw new Error("steps");
    }
  }
  return value as ProjectMetadataStep[];
}

export function metadataInputFromDraft(
  draft: ArtifactMetadataDraft,
  kind: ProjectMetadataInput["kind"],
): ProjectMetadataInput {
  const lines = (value: string) =>
    value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  return {
    kind,
    type: draft.type,
    purpose: draft.purpose.trim(),
    instructions: draft.instructions.trim(),
    sources: lines(draft.sources),
    links: lines(draft.links),
    methods: lines(draft.methods),
    skills: lines(draft.skills),
    checklist: lines(draft.checklist),
    steps: parseSteps(draft.steps),
  };
}
