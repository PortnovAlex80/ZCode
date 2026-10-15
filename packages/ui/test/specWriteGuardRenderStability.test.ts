// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useSpecWriteGuard } from "../src/spec-document/useSpecDiscussion.js";

const fixtures = vi.hoisted(() => {
  const stores = new Map<string, ReturnType<typeof makeStore>>();
  function makeStore() {
    const listeners = new Set<() => void>();
    return {
      state: {
        status: "live",
        snapshot: {
          control: { phase: "running", activeWorks: [] as string[], stopState: "none" },
          queue: { items: [] as string[] },
          backgroundWorks: [] as { status: string }[],
        },
        optimisticCommands: [] as string[],
      },
      getState() {
        return this.state;
      },
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      publish() {
        listeners.forEach((listener) => listener());
      },
    };
  }
  const release = vi.fn();
  const layer = {
    acquire(sessionId: string) {
      let store = stores.get(sessionId);
      if (!store) {
        store = makeStore();
        stores.set(sessionId, store);
      }
      return { sessionId, store, release };
    },
  };
  return { stores, layer, release };
});
vi.mock("../src/v4/V4ConversationContext.js", () => ({
  useV4Conversation: () => ({ layer: fixtures.layer }),
}));
afterEach(() => {
  cleanup();
  fixtures.stores.clear();
  fixtures.release.mockClear();
});

it("does not render document owners on unchanged stream frames, but observes every session control change", () => {
  let renders = 0;
  const { result, unmount } = renderHook(() => {
    renders++;
    return useSpecWriteGuard(["parent", "child", "parent"]);
  });
  const before = renders;
  const initial = result.current;
  for (let frame = 0; frame < 100; frame++) {
    act(() => fixtures.stores.get("parent")!.publish());
    act(() => fixtures.stores.get("child")!.publish());
  }
  expect(renders - before).toBe(0);
  expect(result.current).toBe(initial);
  const child = fixtures.stores.get("child")!;
  act(() => {
    child.state.snapshot.control.phase = "completedSuccess";
    child.publish();
  });
  expect(result.current.phases.child).toBe("completedSuccess");
  expect(result.current.blocked).toBe(true);
  const parent = fixtures.stores.get("parent")!;
  act(() => {
    parent.state.snapshot.control.phase = "completedSuccess";
    parent.publish();
  });
  expect(result.current.blocked).toBe(false);
  act(() => {
    child.state.optimisticCommands.push("pending");
    child.publish();
  });
  expect(result.current.blocked).toBe(true);
  act(() => {
    child.state.optimisticCommands = [];
    child.state.status = "error";
    child.publish();
  });
  expect(result.current.phases.child).toBe("error");
  expect(result.current.blocked).toBe(true);
  unmount();
  expect(fixtures.release).toHaveBeenCalledTimes(2);
});
