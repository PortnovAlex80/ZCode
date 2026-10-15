import { createServiceDescriptor } from "../descriptors.js";

/** Local document IO follows the native workspace-per-request boundary. */
export interface SpecDocumentSnapshot {
  path: string;
  content: string;
  sha256: string;
}

export interface ISpecDocumentService {
  getWorkspace(params: { workspacePath: string }): Promise<{ root: string; writable: boolean }>;
  list(params: { workspacePath: string }): Promise<string[]>;
  read(params: { workspacePath: string; path: string }): Promise<SpecDocumentSnapshot>;
  save(params: {
    workspacePath: string;
    path: string;
    content: string;
    expectedSha256: string;
  }): Promise<SpecDocumentSnapshot>;
  /**
   * U-14：删除工作区文档（真实 unlink）。与 save 共用同一写许可（writer lease）
   * 和写队列；拒绝时抛错（UI 负责可见呈现），绝不静默成功。
   */
  remove(params: { workspacePath: string; path: string }): Promise<{ path: string }>;
}

export const ISpecDocumentService = createServiceDescriptor<ISpecDocumentService>("specDocument");
