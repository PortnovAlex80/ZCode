import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONVERSATION_WINDOWS_KEY,
  bindConversationWindow,
  closeConversationWindow,
  conversationWindowKey,
  findConversationWindow,
  openConversationWindow,
  readConversationWindows,
  registerConversationWindowFocus,
} from "../src/spec-document/conversationWindows.js";

const a = { workspacePath: "D:/project-a" };
const b = { workspacePath: "D:/project-b" };
beforeEach(() => {
  for (const scope of [a, b])
    for (const session of ["one", "two", "fork"]) {
      const entry = findConversationWindow(scope, session);
      if (entry) closeConversationWindow(entry.id);
    }
});
describe("addressed conversation windows", () => {
  it("retains A1, A2 and B1 separately and focuses an existing window", () => {
    const a1 = openConversationWindow(a, "one", "A1");
    const a2 = openConversationWindow(a, "two", "A2");
    const b1 = openConversationWindow(b, "one", "B1");
    const focus = vi.fn();
    const dispose = registerConversationWindowFocus(a1.id, focus);
    expect(openConversationWindow(a, "one", "A1").id).toBe(a1.id);
    expect(focus).toHaveBeenCalledOnce();
    closeConversationWindow(a2.id);
    expect(findConversationWindow(a, "one")).toBe(a1);
    expect(findConversationWindow(b, "one")).toBe(b1);
    dispose();
  });
  it("changes a fork binding without changing the surface identity", () => {
    const entry = openConversationWindow(a, "one", "A1");
    bindConversationWindow(entry.id, "fork");
    expect(findConversationWindow(a, "one")).toBeUndefined();
    expect(findConversationWindow(a, "fork")?.id).toBe(entry.id);
  });
  it("retains native placement identity after Return and re-detach", () => {
    const first = openConversationWindow(a, "one", "A1");
    closeConversationWindow(first.id);
    const reopened = openConversationWindow(a, "one", "A1");
    expect(reopened.id).not.toBe(first.id);
    expect(reopened.placementKey).toBe(first.placementKey);
  });
  it("deduplicates restored descriptors and rejects corrupt scope metadata", () => {
    const entry = { id: "saved-one", scope: a, sessionId: "one", title: "A1" };
    const storage = {
      getItem: () =>
        JSON.stringify([
          entry,
          entry,
          { ...entry, id: "bad/path" },
          { ...entry, scope: { workspacePath: a.workspacePath, remoteSessionId: 12 } },
        ]),
      setItem: vi.fn(),
    };
    expect(readConversationWindows(storage)).toEqual([entry]);
    expect(readConversationWindows({ ...storage, getItem: () => "{" })).toEqual([]);
  });
  it("keeps remote identities and endpoints isolated even with identical paths", () => {
    expect(
      conversationWindowKey(
        { ...a, workspaceIdentity: "remote-a", remoteSessionId: "host-a" },
        "one",
      ),
    ).not.toBe(
      conversationWindowKey(
        { ...a, workspaceIdentity: "remote-b", remoteSessionId: "host-b" },
        "one",
      ),
    );
  });
  it("reads the saved open collection for restart without launching a model", () => {
    const entry = { id: "saved-a", scope: b, sessionId: "two", title: "B2" };
    const getItem = vi.fn(() => JSON.stringify([entry]));
    expect(readConversationWindows({ getItem, setItem: vi.fn() })).toEqual([entry]);
    expect(getItem).toHaveBeenCalledWith(CONVERSATION_WINDOWS_KEY);
  });
});
