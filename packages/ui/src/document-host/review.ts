import type { DocumentAdapter, DocumentProposal } from "./types.js";

/** Pending edits and native receipts live only in this pane connection. */
export class DocumentEditReview {
  readonly proposals = new Map<string, DocumentProposal>();
  constructor(
    private adapter: DocumentAdapter,
    private generation: () => string,
    private cancelledTools: Set<string>,
    private changed: () => void,
    private rpc: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  ) {}
  async handleTool(message: Record<string, unknown>) {
    const generation = String(message.generation);
    try {
      const descriptor = await this.adapter.descriptor();
      if (this.cancelledTools.delete(String(message.requestId)))
        throw new Error("Document tool cancelled");
      if (
        generation !== this.generation() ||
        descriptor.documentInstanceId !== message.documentInstanceId
      )
        throw new Error("Document instance changed");
      const args = (message.args ?? {}) as Record<string, unknown>;
      let result;
      if (message.method === "proposeEdit") {
        if (!args.expected || !args.patch)
          throw new Error("An expected snapshot and bounded patch are required");
        const expected = args.expected as Record<string, unknown>;
        if (
          expected.host !== descriptor.host ||
          expected.documentInstanceId !== descriptor.documentInstanceId ||
          !expected.target ||
          !expected.data
        )
          throw new Error("Proposal must use a fresh snapshot from this document");
        this.pruneProposals();
        if (
          [...this.proposals.values()].filter(
            (item) => item.status === "pending" || item.status === "applying",
          ).length >= 100
        )
          throw new Error("Review existing proposals before adding more");
        const proposal: DocumentProposal = {
          operationId: crypto.randomUUID(),
          generation,
          documentInstanceId: descriptor.documentInstanceId,
          expected: args.expected as Record<string, unknown>,
          patch: args.patch as Record<string, unknown>,
          explanation: String(args.explanation ?? ""),
          status: "pending",
        };
        this.proposals.set(proposal.operationId, proposal);
        this.changed();
        result = {
          operationId: proposal.operationId,
          documentInstanceId: descriptor.documentInstanceId,
          status: "pending",
          message:
            "User must review and apply in the document pane; edit_status can read the later result",
        };
      } else if (message.method === "editStatus") {
        const proposal = this.proposals.get(String(args.operationId));
        if (!proposal || proposal.generation !== generation)
          throw new Error("Proposal unavailable in this document connection");
        result = {
          operationId: proposal.operationId,
          status: proposal.status,
          receipt: proposal.receipt,
        };
      } else result = await this.adapter.execute(String(message.method), args);
      if (generation !== this.generation() || this.cancelledTools.delete(String(message.requestId)))
        throw new Error("Stale or cancelled document result");
      await this.rpc("documentResult", { requestId: message.requestId, generation, result });
    } catch (error) {
      await this.rpc("documentResult", {
        requestId: message.requestId,
        generation,
        error: error instanceof Error ? error.message : "Document operation failed",
      }).catch(() => {});
    }
  }
  private pruneProposals() {
    for (const [id, proposal] of this.proposals)
      if (proposal.generation !== this.generation()) this.proposals.delete(id);
    const terminal = [...this.proposals.values()].filter(
      (item) => !["pending", "applying"].includes(item.status),
    );
    for (const proposal of terminal.slice(0, Math.max(0, terminal.length - 100)))
      this.proposals.delete(proposal.operationId);
  }
  async apply(operationId: string) {
    const proposal = this.proposals.get(operationId);
    if (!proposal || proposal.status !== "pending")
      throw new Error("This operation has already been attempted");
    const descriptor = await this.adapter.descriptor();
    if (
      proposal.generation !== this.generation() ||
      descriptor.documentInstanceId !== proposal.documentInstanceId
    )
      throw new Error("Proposal belongs to an old document connection");
    proposal.status = "applying";
    this.changed();
    try {
      const receipt = (await this.adapter.execute(
        "applyEdit",
        proposal as unknown as Record<string, unknown>,
      )) as { status?: DocumentProposal["status"] };
      proposal.receipt = receipt;
      proposal.status = receipt.status ?? "unknown";
      this.changed();
      return receipt;
    } catch (error) {
      proposal.status = "unknown";
      this.changed();
      throw error;
    }
  }
}
