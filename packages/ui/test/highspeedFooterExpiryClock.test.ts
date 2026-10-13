// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { armHighspeedFooterExpiryClock } from "@/highspeed/highspeedFooterExpiryClock.js";

type Listener = () => void;

/**
 * 可注入的假 window/document：手动持有定时器与监听，模拟 Chromium 在窗口隐藏时冻结
 * renderer setTimeout（定时器不触发），从而验证窗口唤醒补偿是否把 footer 时钟追平。
 */
function createFakeTargets(initialVisibility: DocumentVisibilityState = "visible") {
  let visibilityState = initialVisibility;
  const timers = new Map<number, Listener>();
  let nextTimerId = 1;
  const docListeners = new Map<string, Set<Listener>>();
  const winListeners = new Map<string, Set<Listener>>();

  const add = (map: Map<string, Set<Listener>>, type: string, listener: Listener) => {
    if (!map.has(type)) map.set(type, new Set());
    map.get(type)!.add(listener);
  };
  const remove = (map: Map<string, Set<Listener>>, type: string, listener: Listener) => {
    map.get(type)?.delete(listener);
  };
  const dispatch = (map: Map<string, Set<Listener>>, type: string) => {
    for (const listener of map.get(type) ?? []) listener();
  };

  const windowTarget = {
    setTimeout: (handler: () => void, _timeout: number) => {
      const id = nextTimerId++;
      timers.set(id, handler);
      return id;
    },
    clearTimeout: (id: number) => {
      timers.delete(id);
    },
    addEventListener: (type: string, listener: Listener) => add(winListeners, type, listener),
    removeEventListener: (type: string, listener: Listener) => remove(winListeners, type, listener),
  };

  const documentTarget = {
    get visibilityState() {
      return visibilityState;
    },
    addEventListener: (type: string, listener: Listener) => add(docListeners, type, listener),
    removeEventListener: (type: string, listener: Listener) => remove(docListeners, type, listener),
  };

  return {
    windowTarget: windowTarget as unknown as Window & typeof globalThis,
    documentTarget: documentTarget as unknown as Document,
    /** 手动触发到期 setTimeout（窗口可见、未被冻结时的正常路径）。 */
    fireExpiryTimer() {
      for (const handler of timers.values()) handler();
    },
    hasPendingTimer() {
      return timers.size > 0;
    },
    /** 模拟窗口恢复可见/切到隐藏，派发 visibilitychange。 */
    setVisibility(next: DocumentVisibilityState) {
      visibilityState = next;
      dispatch(docListeners, "visibilitychange");
    },
    /** 模拟窗口获得焦点。 */
    focus() {
      dispatch(winListeners, "focus");
    },
    listenerCount() {
      const count = (map: Map<string, Set<Listener>>) =>
        [...map.values()].reduce((total, set) => total + set.size, 0);
      return count(docListeners) + count(winListeners);
    },
  };
}

describe("armHighspeedFooterExpiryClock", () => {
  it("到期 setTimeout 正常触发时刷新一次 footer 时钟", () => {
    const targets = createFakeTargets();
    const onExpire = vi.fn();
    armHighspeedFooterExpiryClock(1_000, onExpire, {
      windowTarget: targets.windowTarget,
      documentTarget: targets.documentTarget,
      now: () => 0,
    });

    expect(targets.hasPendingTimer()).toBe(true);
    targets.fireExpiryTimer();
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it("窗口隐藏冻结 setTimeout 后，恢复可见时补偿刷新（回归：footer 不再需要用户再发消息）", () => {
    const targets = createFakeTargets();
    const onExpire = vi.fn();
    // Bug 修复说明：P-03 之后补偿只在真实越过到期边界时触发。原用例注入恒定 now()=0，
    // 边界永远未越过，补偿被合法跳过。这里让 fake 时钟前进到已过期，保留回归语义：
    // 隐藏期间定时器被冻结错过边界，回到前台必须立即追平 footer 时钟。
    let fakeNow = 0;
    armHighspeedFooterExpiryClock(1_000, onExpire, {
      windowTarget: targets.windowTarget,
      documentTarget: targets.documentTarget,
      now: () => fakeNow,
    });

    // 模拟窗口隐藏：到期 setTimeout 被冻结（不触发）。切到隐藏态本身不应补偿。
    targets.setVisibility("hidden");
    expect(onExpire).not.toHaveBeenCalled();

    // 未到期时回到前台/聚焦不补偿（P-03：空闲唤醒不得触发 O(rows) 重建）。
    fakeNow = 500;
    targets.setVisibility("visible");
    expect(onExpire).not.toHaveBeenCalled();

    // 卡此时已到期。窗口回到前台，必须立即把 footer 时钟追平——无需触发原定时器。
    fakeNow = 1_500;
    targets.setVisibility("visible");
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it("窗口获得焦点时也补偿刷新", () => {
    const targets = createFakeTargets();
    const onExpire = vi.fn();
    let fakeNow = 0;
    armHighspeedFooterExpiryClock(1_000, onExpire, {
      windowTarget: targets.windowTarget,
      documentTarget: targets.documentTarget,
      now: () => fakeNow,
    });

    fakeNow = 1_500;
    targets.focus();
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it("dispose 后清理定时器与监听，窗口唤醒不再触发", () => {
    const targets = createFakeTargets();
    const onExpire = vi.fn();
    const dispose = armHighspeedFooterExpiryClock(1_000, onExpire, {
      windowTarget: targets.windowTarget,
      documentTarget: targets.documentTarget,
      now: () => 0,
    });

    dispose();
    expect(targets.hasPendingTimer()).toBe(false);
    expect(targets.listenerCount()).toBe(0);

    targets.setVisibility("visible");
    targets.focus();
    expect(onExpire).not.toHaveBeenCalled();
  });
});
