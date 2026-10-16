import { projectMetadataBlocks } from "@zcode/services/artifact-metadata";
import type {
  ProjectMetadataBlocks,
  ProjectMetadataEntry,
  ProjectMetadataInput,
} from "@zcode/services";

export type ArtifactMetadataDraft = ProjectMetadataBlocks;

export function artifactMetadataDraft(entry?: ProjectMetadataEntry): ArtifactMetadataDraft {
  return projectMetadataBlocks(entry);
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

export function metadataInputFromDraft(
  draft: ArtifactMetadataDraft,
  kind: ProjectMetadataInput["kind"],
): ProjectMetadataInput {
  // Текст может содержать отступы команд и Markdown: не trim и не разбирать его как JSON.
  return { kind, blocks: { ...draft } };
}
