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
}

export const ISpecDocumentService = createServiceDescriptor<ISpecDocumentService>("specDocument");
