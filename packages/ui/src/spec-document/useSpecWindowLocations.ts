import { useMemo, useSyncExternalStore } from "react";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import type { SpecWindowBridge } from "./specWindowBridge.js";

type Locations = Awaited<ReturnType<SpecWindowBridge["projectWindowState"]>>["windows"];
const EMPTY: Locations = [];
const registries = new WeakMap<SpecWindowBridge, ReturnType<typeof createRegistry>>();
function createRegistry(bridge: SpecWindowBridge) {
  let snapshot: Locations = EMPTY;
  const listeners = new Set<() => void>();
  let stop: (() => void) | undefined;
  let pending = false;
  let refreshAgain = false;
  async function refresh() {
    if (pending) {
      refreshAgain = true;
      return;
    }
    pending = true;
    try {
      snapshot = (await bridge.projectWindowState()).windows;
      for (const listener of listeners) listener();
    } catch {
      /* Optional native capability: an unavailable registry does not change session state. */
    } finally {
      pending = false;
      if (refreshAgain) {
        refreshAgain = false;
        void refresh();
      }
    }
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) {
        const off = bridge.onProjectWindowsChanged(() => void refresh());
        const focused = () => void refresh();
        window.addEventListener("focus", focused);
        stop = () => {
          off();
          window.removeEventListener("focus", focused);
        };
        void refresh();
      }
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          stop?.();
          stop = undefined;
        }
      };
    },
  };
}
const unavailable = { getSnapshot: () => EMPTY, subscribe: (_listener: () => void) => () => {} };
export function useSpecWindowLocation(workspacePath: string, sessionId?: string): boolean {
  const bridge = useOptionalPlatform()?.specWindows;
  const registry = useMemo(() => {
    if (!bridge) return unavailable;
    let result = registries.get(bridge);
    if (!result) {
      result = createRegistry(bridge);
      registries.set(bridge, result);
    }
    return result;
  }, [bridge]);
  const locations = useSyncExternalStore(registry.subscribe, registry.getSnapshot, () => EMPTY);
  const normalized = workspacePath.replaceAll("\\", "/").toLowerCase();
  return locations.some(
    (location) =>
      location.visible &&
      location.target?.workspacePath.replaceAll("\\", "/").toLowerCase() === normalized &&
      (!sessionId || location.target.taskId === sessionId),
  );
}
