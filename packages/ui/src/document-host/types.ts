export interface DocumentAdapter {
  descriptor(): Promise<{
    host: "word" | "excel" | "autocad";
    documentId: string;
    documentInstanceId: string;
    name: string;
    url?: string;
  }>;
  execute(method: string, args: Record<string, unknown>): Promise<unknown>;
}
export interface DocumentProposal {
  operationId: string;
  generation: string;
  documentInstanceId: string;
  expected: Record<string, unknown>;
  patch: Record<string, unknown>;
  explanation: string;
  receipt?: unknown;
  status: "pending" | "applying" | "applied" | "refused" | "partial" | "unknown";
}
