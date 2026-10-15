import type { IProjectMetadataService } from "@zcode/services";

/** 每次发送重新读取护照；预览不作为发送真相，失败必须保留 composer 草稿。 */
export async function prepareArtifactText(params: {
  service?: IProjectMetadataService;
  workspacePath: string;
  path: string;
  enabled: boolean;
  text: string;
}): Promise<string> {
  if (!params.enabled) return params.text;
  if (!params.service) throw new Error("Artifact metadata is unavailable on this host.");
  const context = await params.service.resolve({
    workspacePath: params.workspacePath,
    path: params.path,
  });
  return context.text ? `${params.text}\n\n${context.text}` : params.text;
}
