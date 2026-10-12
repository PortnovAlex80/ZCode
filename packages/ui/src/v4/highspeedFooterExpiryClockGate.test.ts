import assert from "node:assert/strict";
import { test } from "vitest";
import {
  armHighspeedFooterExpiryClock,
  type HighspeedFooterExpiryClockDeps,
} from "../highspeed/highspeedFooterExpiryClock.js";

/**
 * P-03 热点 2 的行为约束：到期时钟的窗口唤醒补偿只允许在「本次挂起的到期边界已被越过」
 * 时触发 onExpire。空闲的 focus/visibilitychange（边界未到）不得触发——那会推进
 * ConversationTimeline 的 liveNowMs 并全量重建 render units（O(rows)），而 footer 只在
 * nowMs 越过 expiresAt 时才有显隐变化。定时器被冻结错过边界的补偿语义必须保留。
 */

interface FakeTimer {
  deadlineMs: number;
  callback: () => void;
}

function createFakeEnvironment() {
  let nowMs = 1_000;
  let nextTimerId = 1;
  const timers = new Map<number, FakeTimer>();
  const listeners = {
    window: new Map<string, Set<() => void>>(),
    document: new Map<string, Set<() => void>>(),
  };
  const addListener =
    (target: "window" | "document") => (name: string, handler: () => void) => {
      if (!listeners[target].has(name)) listeners[target].set(name, new Set());
      listeners[target].get(name)!.add(handler);
    };
  const removeListener =
    (target: "window" | "document") => (name: string, handler: () => void) => {
      listeners[target].get(name)?.delete(handler);
    };
  const windowTarget = {
    setTimeout: (callback: () => void, delay: number) => {
      const id = nextTimerId++;
      timers.set(id, { deadlineMs: nowMs + Math.max(0, delay), callback });
      return id;
    },
    clearTimeout: (id: number) => {
      timers.delete(id);
    },
    addEventListener: addListener("window"),
    removeEventListener: removeListener("window"),
  };
  const documentTarget = {
    visibilityState: "visible" as "visible" | "hidden",
    addEventListener: addListener("document"),
    removeEventListener: removeListener("document"),
  };
  return {
    windowTarget,
    documentTarget,
    timers,
    clockDeps: (): HighspeedFooterExpiryClockDeps => ({
      // 假目标只实现最小面；结构类型对 DOM 重载签名过严，按既有测试先例经 unknown 收敛。
      windowTarget: windowTarget as unknown as HighspeedFooterExpiryClockDeps["windowTarget"],
      documentTarget: documentTarget as unknown as HighspeedFooterExpiryClockDeps["documentTarget"],
      now: () => nowMs,
    }),
    get nowMs() {
      return nowMs;
    },
    set nowMs(value: number) {
      nowMs = value;
    },
    fire(target: "window" | "document", name: string) {
      for (const handler of listeners[target].get(name) ?? []) handler();
    },
    listenerCount(target: "window" | "document", name: string) {
      return listeners[target].get(name)?.size ?? 0;
    },
    runDueTimers() {
      let ran = 0;
      for (const [id, timer] of timers.entries()) {
        if (timer.deadlineMs > nowMs) continue;
        timers.delete(id);
        timer.callback();
        ran += 1;
      }
      return ran;
    },
  };
}

test("idle focus/visibility toggles before the armed boundary never fire onExpire", () => {
  const env = createFakeEnvironment();
  let expired = 0;
  armHighspeedFooterExpiryClock(60_000, () => {
    expired += 1;
  }, env.clockDeps());

  // 窗口空闲 focus（点击/切回）与可见性切换，边界（60000）远未到。
  env.fire("window", "focus");
  env.fire("document", "visibilitychange");
  assert.equal(expired, 0);

  env.nowMs = 10_000;
  env.fire("window", "focus");
  env.fire("document", "visibilitychange");
  assert.equal(expired, 0, "repeated idle toggles stay silent");

  env.documentTarget.visibilityState = "hidden";
  env.fire("document", "visibilitychange");
  assert.equal(expired, 0, "hiding never compensates");

  env.documentTarget.visibilityState = "visible";
  env.fire("document", "visibilitychange");
  assert.equal(expired, 0, "waking before the boundary has no visible expiry to catch up");

  env.nowMs = 59_999;
  env.fire("window", "focus");
  assert.equal(expired, 0, "one tick before the boundary is still idle");
  assert.equal(env.timers.size, 1, "the boundary timer itself stays armed and untouched");
});

test("wake after the frozen timer missed the boundary catches up immediately", () => {
  const env = createFakeEnvironment();
  let expired = 0;
  armHighspeedFooterExpiryClock(5_000, () => {
    expired += 1;
  }, env.clockDeps());

  // 隐藏期间 Chromium 冻结了定时器，真实时钟已越过边界。
  env.nowMs = 9_000;
  env.documentTarget.visibilityState = "hidden";
  env.fire("document", "visibilitychange");
  assert.equal(expired, 0, "hidden documents do not compensate");

  env.documentTarget.visibilityState = "visible";
  env.fire("document", "visibilitychange");
  assert.equal(expired, 1, "showing after the boundary catches the footer up without a new message");

  env.fire("window", "focus");
  assert.equal(expired, 2, "focus after the crossed boundary still compensates this arming");
});

test("the setTimeout boundary itself still fires while the window stays visible", () => {
  const env = createFakeEnvironment();
  let expired = 0;
  armHighspeedFooterExpiryClock(5_000, () => {
    expired += 1;
  }, env.clockDeps());

  // delay = max(0, 5000 - 1000) + 20 → 4020ms 后触发；此前不触发。
  env.nowMs = 5_019;
  assert.equal(env.runDueTimers(), 0);
  assert.equal(expired, 0);
  env.nowMs = 5_020;
  assert.equal(env.runDueTimers(), 1);
  assert.equal(expired, 1);
});

test("wake exactly at the boundary compensates and dispose removes timer and listeners", () => {
  const env = createFakeEnvironment();
  let expired = 0;
  const dispose = armHighspeedFooterExpiryClock(5_000, () => {
    expired += 1;
  }, env.clockDeps());

  env.nowMs = 5_000;
  env.fire("window", "focus");
  assert.equal(expired, 1, "now() >= nextExpiryMs counts as crossed (footer shows at equality)");

  dispose();
  assert.equal(env.timers.size, 0, "dispose clears the pending boundary timer");
  assert.equal(env.listenerCount("window", "focus"), 0);
  assert.equal(env.listenerCount("document", "visibilitychange"), 0);

  env.nowMs = 50_000;
  env.fire("window", "focus");
  env.fire("document", "visibilitychange");
  assert.equal(env.runDueTimers(), 0);
  assert.equal(expired, 1, "a disposed clock never wakes again");
});
