// @vitest-environment jsdom
// MPS12 (2026-11-08): the "Discuss fragment" entry carries the selected text
// through both handoffs — the live WORKSPACE_DOCUMENT_DISCUSS_EVENT payload
// (already-mounted panes) and the one-shot pending-quote slot (a pane that
// mounts afterwards, i.e. the freshly opened independent document window).
// The slot contract is pinned here: workspace+document match, single
// consumption, foreign consumers clear it without receiving the quote.
import { beforeEach, describe, expect, it } from "vitest";
import {
  consumePendingDiscussQuote,
  discussWorkspaceFileDocument,
  WORKSPACE_DOCUMENT_DISCUSS_EVENT,
  type WorkspaceFileEntryPointRequest,
} from "./workspaceFileEntryPoints.js";
import {
  defaultDocumentPresentation,
  documentPresentationKey,
  readDocumentPresentation,
} from "./specDocumentPresentationState.js";

const WORKSPACE_PATH = "D:\\ws";
const IDENTITY = "entry-quote";
const DOCUMENT_PATH = "docs/note.md";
const QUOTE = "fragment\twith tabs «и кириллицей» 🎯";
const REQUEST: WorkspaceFileEntryPointRequest = {
  workspacePath: WORKSPACE_PATH,
  workspaceIdentity: IDENTITY,
  path: "D:\\ws\\docs\\note.md",
  name: "note.md",
};

function discussEventListener(): { events: WorkspaceDocumentDetail[]; detach: () => void } {
  const events: WorkspaceDocumentDetail[] = [];
  const listener = (event: Event) => {
    events.push((event as CustomEvent<WorkspaceDocumentDetail>).detail);
  };
  window.addEventListener(WORKSPACE_DOCUMENT_DISCUSS_EVENT, listener);
  return { events, detach: () => window.removeEventListener(WORKSPACE_DOCUMENT_DISCUSS_EVENT, listener) };
}
type WorkspaceDocumentDetail = {
  workspacePath: string;
  workspaceIdentity?: string;
  documentPath: string;
  quote?: string;
};

describe("discussWorkspaceFileDocument quote plumbing (MPS12)", () => {
  beforeEach(() => {
    localStorage.clear();
    // The pending-quote slot is deliberately module-global; drain any leftover
    // from a previous test (consumption clears unconditionally).
    consumePendingDiscussQuote({ workspacePath: "", documentPath: "" });
  });

  it("carries the quote in the live discuss event payload and arms the presentation handoff", () => {
    const { events, detach } = discussEventListener();
    try {
      discussWorkspaceFileDocument({
        request: REQUEST,
        relativeDocumentPath: DOCUMENT_PATH,
        quote: QUOTE,
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        workspacePath: WORKSPACE_PATH,
        workspaceIdentity: IDENTITY,
        documentPath: DOCUMENT_PATH,
        quote: QUOTE,
      });
      const presentation = readDocumentPresentation(
        documentPresentationKey(WORKSPACE_PATH, IDENTITY),
      );
      expect(presentation.path).toBe(DOCUMENT_PATH);
      expect(presentation.discussionsVisible).toBe(true);
      expect(presentation.activeThreadId).toBeNull();
    } finally {
      detach();
    }
  });

  it("omits the quote field when the entry carries no selection (plain Discuss document)", () => {
    const { events, detach } = discussEventListener();
    try {
      discussWorkspaceFileDocument({ request: REQUEST, relativeDocumentPath: DOCUMENT_PATH });
      expect(events).toHaveLength(1);
      expect("quote" in events[0]!).toBe(false);
      // Nothing staged for the fresh-mount handoff either.
      expect(
        consumePendingDiscussQuote({
          workspacePath: WORKSPACE_PATH,
          workspaceIdentity: IDENTITY,
          documentPath: DOCUMENT_PATH,
        }),
      ).toBeNull();
    } finally {
      detach();
    }
  });

  it("stages the quote for the freshly mounted pane: matching scope consumes it exactly once", () => {
    discussWorkspaceFileDocument({
      request: REQUEST,
      relativeDocumentPath: DOCUMENT_PATH,
      quote: QUOTE,
    });
    const scope = {
      workspacePath: WORKSPACE_PATH,
      workspaceIdentity: IDENTITY,
      documentPath: DOCUMENT_PATH,
    };
    expect(consumePendingDiscussQuote(scope)).toBe(QUOTE);
    // One-shot: the same pane activating again must not replay the quote.
    expect(consumePendingDiscussQuote(scope)).toBeNull();
  });

  it("a foreign consumer (other document or workspace) clears the slot without receiving the quote", () => {
    discussWorkspaceFileDocument({
      request: REQUEST,
      relativeDocumentPath: DOCUMENT_PATH,
      quote: QUOTE,
    });
    expect(
      consumePendingDiscussQuote({
        workspacePath: WORKSPACE_PATH,
        workspaceIdentity: IDENTITY,
        documentPath: "other/path.md",
      }),
    ).toBeNull();
    // Cleared: the real pane mounting afterwards gets nothing stale.
    expect(
      consumePendingDiscussQuote({
        workspacePath: WORKSPACE_PATH,
        workspaceIdentity: IDENTITY,
        documentPath: DOCUMENT_PATH,
      }),
    ).toBeNull();
  });

  it("matches by workspace identity key, never by raw path alone", () => {
    discussWorkspaceFileDocument({
      request: REQUEST,
      relativeDocumentPath: DOCUMENT_PATH,
      quote: QUOTE,
    });
    // Same workspace, path-only scope (identity absent on both sides is the
    // local-workspace fallback): path key matches via the same rule.
    expect(
      consumePendingDiscussQuote({
        workspacePath: WORKSPACE_PATH,
        documentPath: DOCUMENT_PATH,
      }),
    ).toBeNull(); // identity "entry-quote" != undefined → foreign, slot cleared
    discussWorkspaceFileDocument({
      request: { ...REQUEST, workspaceIdentity: undefined },
      relativeDocumentPath: DOCUMENT_PATH,
      quote: QUOTE,
    });
    expect(
      consumePendingDiscussQuote({
        workspacePath: WORKSPACE_PATH,
        documentPath: DOCUMENT_PATH,
      }),
    ).toBe(QUOTE);
  });

  it("default presentation state keeps no quote field (schema untouched)", () => {
    expect(defaultDocumentPresentation()).not.toHaveProperty("quote");
  });
});
