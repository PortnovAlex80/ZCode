import type {
  ProjectMetadataBlocks,
  ProjectMetadataEntry,
  ProjectMetadataInput,
  ProjectMetadataStep,
} from "./projectMetadata.js";

function labelled(label: string, text: string | undefined): string {
  return text === undefined ? "" : `${label}:\n${text}`;
}

function lines(label: string, values: readonly string[] | undefined): string {
  return values?.length ? `${label}:\n${values.join("\n")}` : "";
}

function stepText(step: ProjectMetadataStep, index: number): string {
  return [
    `Step ${index + 1}: ${step.title}`,
    labelled("Instruction", step.instruction),
    ...(step.tool === undefined
      ? []
      : [
          labelled("Transport", step.tool.transport),
          labelled("Connection", step.tool.connection),
          labelled("Operation", step.tool.operation),
        ]),
    labelled("Input", step.input),
    labelled("Expected result", step.expected),
    labelled("On failure", step.onFailure),
  ]
    .filter((text) => text !== "")
    .join("\n\n");
}

/** 纯投影：不改磁盘、不猜模板、不执行工具；旧记录的每个已知指令值原样保留。 */
export function projectMetadataBlocks(
  entry?: ProjectMetadataEntry | ProjectMetadataInput,
): ProjectMetadataBlocks {
  if (entry?.blocks !== undefined) return { ...entry.blocks };
  return {
    role: [entry?.purpose ?? "", labelled("Artifact type", entry?.type)]
      .filter((text) => text !== "")
      .join("\n\n"),
    template: "",
    data: [lines("Sources", entry?.sources), lines("Related materials", entry?.links)]
      .filter((text) => text !== "")
      .join("\n\n"),
    assembly: [
      labelled("Instructions", entry?.instructions),
      lines("Methods", entry?.methods),
      lines("Skills", entry?.skills),
      ...(entry?.steps?.map(stepText) ?? []),
    ]
      .filter((text) => text !== "")
      .join("\n\n"),
    acceptance: entry?.checklist?.join("\n") ?? "",
  };
}
