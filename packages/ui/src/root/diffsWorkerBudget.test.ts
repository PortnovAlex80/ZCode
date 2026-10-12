// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSingularPatch, type FileContents, type FileDiffMetadata } from "@pierre/diffs";
import { useWorkerPool } from "@pierre/diffs/react";
import { WorkerPoolManager, type WorkerInitializationRenderOptions } from "@pierre/diffs/worker";
import { resolveDiffsWorkerBudget } from "./diffsWorkerBudget.js";
import { DiffsWorkerPoolProvider } from "./DiffsWorkerPoolProvider.js";
import { LazyDiffsWorkerPool, type DiffsWorkerPoolSurface } from "./lazyDiffsWorkerPool.js";
import { createDiffsWorkerHighlighterOptions } from "@/lib/diffsHighlighterEngine.js";

vi.mock("@/store/StoreProvider.js", () => ({
  useZCodeStore: (selector: (state: unknown) => unknown) =>
    selector({
      codePreviewSettings: { lightTheme: "github-light", darkTheme: "github-dark" },
    }),
}));
vi.mock("@/store/index.js", () => ({
  DEFAULT_CODE_PREVIEW_SETTINGS: { lightTheme: "github-light", darkTheme: "github-dark" },
}));

describe("renderer worker budget", () => {
  it("bounds auxiliary windows independently of a large CPU count", () => {
    expect(resolveDiffsWorkerBudget(32, 2)).toBe(2);
    expect(resolveDiffsWorkerBudget(32)).toBe(4);
    expect(resolveDiffsWorkerBudget(1, 2)).toBe(1);
  });
  it("keeps invalid capacities finite and retains the minimum worker", () => {
    expect(resolveDiffsWorkerBudget(NaN, 2)).toBe(2);
    expect(resolveDiffsWorkerBudget(Infinity, 2)).toBe(2);
    expect(resolveDiffsWorkerBudget(0, 2)).toBe(2);
    expect(resolveDiffsWorkerBudget(8, NaN)).toBe(1);
    expect(resolveDiffsWorkerBudget(8, 0)).toBe(1);
  });
});

const HIGHLIGHTER_OPTIONS: WorkerInitializationRenderOptions = createDiffsWorkerHighlighterOptions({
  lightTheme: "github-light",
  darkTheme: "github-dark",
});

/** 记录转发调用并返回哨兵值的假池，用于验证惰性包装的休眠/唤醒/转发语义。 */
class FakeDiffsWorkerPool implements DiffsWorkerPoolSurface {
  readonly highlightCalls: Array<{ instance: unknown; payload: unknown }> = [];
  themeSubscribers = new Set<{ rerender(): void }>();
  terminateCount = 0;
  readonly diffCacheSentinel = { sentinel: "diff-cache" } as never;
  readonly fileCacheSentinel = { sentinel: "file-cache" } as never;
  readonly plainDiffSentinel = { sentinel: "plain-diff" } as never;
  readonly plainFileSentinel = { sentinel: "plain-file" } as never;
  readonly diffRenderOptions = { sentinel: "diff-render-options" } as never;
  readonly fileRenderOptions = { sentinel: "file-render-options" } as never;
  readonly statsSentinel = { sentinel: "stats" } as never;

  isWorkingPool() {
    return true;
  }
  isInitialized() {
    return true;
  }
  async initialize() {}
  async setRenderOptions() {}
  getFileRenderOptions() {
    return this.fileRenderOptions;
  }
  getDiffRenderOptions() {
    return this.diffRenderOptions;
  }
  getFileResultCache() {
    return this.fileCacheSentinel;
  }
  getDiffResultCache() {
    return this.diffCacheSentinel;
  }
  getPlainFileAST() {
    return this.plainFileSentinel;
  }
  getPlainDiffAST() {
    return this.plainDiffSentinel;
  }
  highlightFileAST(instance: unknown, file: unknown) {
    this.highlightCalls.push({ instance, payload: file });
  }
  highlightDiffAST(instance: unknown, diff: unknown) {
    this.highlightCalls.push({ instance, payload: diff });
  }
  subscribeToThemeChanges(instance: { rerender(): void }) {
    this.themeSubscribers.add(instance);
    return () => this.unsubscribeToThemeChanges(instance);
  }
  unsubscribeToThemeChanges(instance: { rerender(): void }) {
    this.themeSubscribers.delete(instance);
  }
  subscribeToStatChanges() {
    return () => {};
  }
  cleanUpPendingTasks() {}
  getStats() {
    return this.statsSentinel;
  }
  terminate() {
    this.terminateCount += 1;
  }
}

function createLazyPool() {
  const state: { manager?: FakeDiffsWorkerPool } = {};
  const lazyPool = new LazyDiffsWorkerPool({
    getHighlighterOptions: () => HIGHLIGHTER_OPTIONS,
    createManager: (options) => {
      expect(options).toBe(HIGHLIGHTER_OPTIONS);
      state.manager = new FakeDiffsWorkerPool();
      return state.manager;
    },
  });
  return { lazyPool, state };
}

const diffFixture = { name: "demo.ts", hunks: [] } as unknown as FileDiffMetadata;
const fileFixture = { name: "demo.ts", contents: "const value = 1;\n" } as FileContents;
const diffRendererInstance = {
  __id: "diff-renderer-instance",
  onHighlightSuccess: vi.fn(),
  onHighlightError: vi.fn(),
};
const fileRendererInstance = {
  __id: "file-renderer-instance",
  onHighlightSuccess: vi.fn(),
  onHighlightError: vi.fn(),
};

describe("lazy diffs worker pool（P-02：eager diff/highlight 成本惰性化）", () => {
  it("首个 diff/highlight 请求前零构造：读取/订阅/清理/参数同步都保持休眠", async () => {
    const { lazyPool, state } = createLazyPool();
    const themeSubscriber = { rerender: vi.fn() };
    const statCallback = vi.fn();

    expect(lazyPool.isWorkingPool()).toBe(true);
    expect(lazyPool.isInitialized()).toBe(false);
    expect(lazyPool.getDiffResultCache(diffFixture)).toBeUndefined();
    expect(lazyPool.getFileResultCache(fileFixture)).toBeUndefined();

    const unsubscribeTheme = lazyPool.subscribeToThemeChanges(themeSubscriber);
    lazyPool.subscribeToStatChanges(statCallback);
    expect(statCallback).toHaveBeenCalledTimes(1);
    expect(statCallback.mock.calls[0]?.[0]).toEqual({
      managerState: "waiting",
      workersFailed: false,
      totalWorkers: 0,
      busyWorkers: 0,
      queuedTasks: 0,
      pendingTasks: 0,
      themeSubscribers: 1,
      fileCacheSize: 0,
      diffCacheSize: 0,
    });

    lazyPool.cleanUpPendingTasks(diffRendererInstance);
    await lazyPool.setRenderOptions({ lineDiffType: "word-alt" });
    // 休眠期 setRenderOptions 只通知已订阅实例重渲染，绝不构造真实池
    // （真实池的 setRenderOptions 会 await initialize() 主动拉起 worker）。
    expect(themeSubscriber.rerender).toHaveBeenCalledTimes(1);

    expect(state.manager).toBeUndefined();
    unsubscribeTheme();
    expect(state.manager).toBeUndefined();
  });

  it("休眠期渲染参数与未初始化真实池一致（主题来自最新期望配置）", () => {
    const { lazyPool } = createLazyPool();
    expect(lazyPool.getDiffRenderOptions()).toEqual({
      theme: { light: "github-light", dark: "github-dark" },
      useTokenTransformer: false,
      lineDiffType: "word-alt",
      maxLineDiffLength: 1_000,
      tokenizeMaxLineLength: 1_000,
    });
    expect(lazyPool.getFileRenderOptions()).toEqual({
      theme: { light: "github-light", dark: "github-dark" },
      useTokenTransformer: false,
      tokenizeMaxLineLength: 1_000,
    });
  });

  it("首个 diff/highlight 请求唤醒真实池，且整个生命周期只构造一次", () => {
    const { lazyPool, state } = createLazyPool();
    lazyPool.highlightDiffAST(diffRendererInstance, diffFixture);
    const firstManager = state.manager;
    expect(firstManager).toBeDefined();
    expect(firstManager!.highlightCalls).toEqual([
      { instance: diffRendererInstance, payload: diffFixture },
    ]);

    lazyPool.highlightFileAST(fileRendererInstance, fileFixture);
    lazyPool.getPlainDiffAST(diffFixture, 0, Number.POSITIVE_INFINITY);
    lazyPool.getPlainFileAST(fileFixture, 0, Number.POSITIVE_INFINITY);
    expect(state.manager).toBe(firstManager);
  });

  it("唤醒后所有调用逐引用转发到底层池，返回值与底层池完全一致", () => {
    const { lazyPool, state } = createLazyPool();
    lazyPool.getPlainDiffAST(diffFixture, 0, Number.POSITIVE_INFINITY);
    const manager = state.manager!;

    expect(lazyPool.isWorkingPool()).toBe(true);
    expect(lazyPool.isInitialized()).toBe(true);
    expect(lazyPool.getDiffResultCache(diffFixture)).toBe(manager.diffCacheSentinel);
    expect(lazyPool.getFileResultCache(fileFixture)).toBe(manager.fileCacheSentinel);
    expect(lazyPool.getDiffRenderOptions()).toBe(manager.diffRenderOptions);
    expect(lazyPool.getFileRenderOptions()).toBe(manager.fileRenderOptions);
    expect(lazyPool.getStats()).toBe(manager.statsSentinel);
    expect(lazyPool.getPlainDiffAST(diffFixture, 3, 7)).toBe(manager.plainDiffSentinel);
    expect(lazyPool.getPlainFileAST(fileFixture, 3, 7)).toBe(manager.plainFileSentinel);

    lazyPool.highlightDiffAST(diffRendererInstance, diffFixture);
    expect(manager.highlightCalls.at(-1)?.instance).toBe(diffRendererInstance);
    expect(manager.highlightCalls.at(-1)?.payload).toBe(diffFixture);
  });

  it("休眠期登记的主题订阅在唤醒时补登记，退订穿透到底层池", () => {
    const { lazyPool, state } = createLazyPool();
    const themeSubscriber = { rerender: vi.fn() };
    const unsubscribeTheme = lazyPool.subscribeToThemeChanges(themeSubscriber);
    expect(state.manager).toBeUndefined();

    lazyPool.highlightDiffAST(diffRendererInstance, diffFixture);
    expect(state.manager!.themeSubscribers.has(themeSubscriber)).toBe(true);

    unsubscribeTheme();
    expect(state.manager!.themeSubscribers.has(themeSubscriber)).toBe(false);
  });

  it("terminate 回到休眠并释放订阅，后续请求按需重新唤醒", () => {
    const { lazyPool, state } = createLazyPool();
    const themeSubscriber = { rerender: vi.fn() };
    lazyPool.subscribeToThemeChanges(themeSubscriber);
    lazyPool.highlightDiffAST(diffRendererInstance, diffFixture);
    const firstManager = state.manager!;

    lazyPool.terminate();
    expect(firstManager.terminateCount).toBe(1);
    expect(lazyPool.isAwake()).toBe(false);
    expect(lazyPool.getStats().themeSubscribers).toBe(0);

    lazyPool.highlightDiffAST(diffRendererInstance, diffFixture);
    expect(state.manager).toBeDefined();
    expect(state.manager).not.toBe(firstManager);
    // 重新唤醒后休眠期订阅不应重复登记（前一次 terminate 已释放）。
    expect(state.manager!.themeSubscribers.has(themeSubscriber)).toBe(false);
  });
});

/** ACK initialize/set-render-options 的假 Worker，让真实 WorkerPoolManager 完成初始化。 */
class AckWorker {
  static instances: AckWorker[] = [];
  readonly posted: unknown[] = [];
  terminated = false;
  private readonly listeners: Array<(event: { data: unknown }) => void> = [];

  constructor() {
    AckWorker.instances.push(this);
  }

  addEventListener(_type: string, listener: (event: { data: unknown }) => void) {
    this.listeners.push(listener);
  }

  postMessage(message: unknown) {
    this.posted.push(message);
    const request = message as { id?: string; type?: string };
    if (request?.type === "initialize" || request?.type === "set-render-options") {
      queueMicrotask(() => {
        for (const listener of this.listeners) {
          listener({ data: { type: "success", requestType: request.type, id: request.id } });
        }
      });
    }
    // file/diff 高亮任务在本测试中保持 pending：plain AST 走主线程路径，不需要 worker 应答。
  }

  terminate() {
    this.terminated = true;
  }
}

describe("lazy diffs worker pool · 真实 WorkerPoolManager 集成", () => {
  it("惰性包装构造零 spawn；唤醒后与直接构造的真实池产出相同的 plain diff AST", async () => {
    const spawnCountBeforeLazy = AckWorker.instances.length;
    const stubWorkerFactory = (): Worker => new AckWorker() as unknown as Worker;
    const lazyPool = new LazyDiffsWorkerPool({
      getHighlighterOptions: () => HIGHLIGHTER_OPTIONS,
      createManager: (options) =>
        new WorkerPoolManager({ workerFactory: stubWorkerFactory, poolSize: 2 }, options),
    });
    // 惰性包装构造本身不 spawn 任何 worker（对照：直接构造的初始化会 spawn 整池）。
    expect(AckWorker.instances.length).toBe(spawnCountBeforeLazy);

    const directPool = new WorkerPoolManager(
      { workerFactory: stubWorkerFactory, poolSize: 2 },
      HIGHLIGHTER_OPTIONS,
    );
    // 直接构造的旧路径：构造函数排队初始化，initialize 完成时已 spawn 满整池 worker。
    await directPool.initialize();
    expect(AckWorker.instances.length).toBe(spawnCountBeforeLazy + 2);

    await lazyPool.initialize();
    expect(AckWorker.instances.length).toBe(spawnCountBeforeLazy + 4);
    expect(directPool.getStats().managerState).toBe("initialized");
    expect(lazyPool.getStats().managerState).toBe("initialized");

    const diff = getSingularPatch(
      [
        "diff --git a/demo.ts b/demo.ts",
        "index 111..222 100644",
        "--- a/demo.ts",
        "+++ b/demo.ts",
        "@@ -1,3 +1,3 @@",
        " const a = 1;",
        "-const b = 2;",
        "+const b = 3;",
        " const c = 4;",
        "",
      ].join("\n"),
    );
    const directResult = directPool.getPlainDiffAST(diff, 0, Number.POSITIVE_INFINITY);
    const lazyResult = lazyPool.getPlainDiffAST(diff, 0, Number.POSITIVE_INFINITY);
    // 非空断言防止“两边都是 undefined”的空等价。
    expect(directResult).toBeDefined();
    expect(lazyResult).toEqual(directResult);

    directPool.terminate();
    lazyPool.terminate();
    expect(AckWorker.instances.filter((worker) => !worker.terminated)).toHaveLength(0);
  }, 60_000);
});

class ProviderStubWorker {
  static instances: ProviderStubWorker[] = [];
  static get constructions() {
    return ProviderStubWorker.instances.length;
  }
  readonly posted: unknown[] = [];
  terminated = false;
  private readonly listeners: Array<(event: { data: unknown }) => void> = [];

  constructor(_url?: unknown, _options?: unknown) {
    ProviderStubWorker.instances.push(this);
  }

  addEventListener(_type: string, listener: (event: { data: unknown }) => void) {
    this.listeners.push(listener);
  }

  postMessage(message: unknown) {
    this.posted.push(message);
  }

  terminate() {
    this.terminated = true;
  }
}

function PoolProbe({ onPool }: { onPool: (pool: unknown) => void }) {
  onPool(useWorkerPool());
  return null;
}

describe("DiffsWorkerPoolProvider 挂载零 spawn（P-02）", () => {
  beforeEach(() => {
    ProviderStubWorker.instances.length = 0;
    (globalThis as { Worker?: unknown }).Worker = ProviderStubWorker;
  });

  afterEach(() => {
    cleanup();
    delete (globalThis as { Worker?: unknown }).Worker;
  });

  it("挂载（含参数同步 effect）不 spawn worker；首个 highlight 请求按预算 spawn", () => {
    let poolFromContext: unknown;
    render(
      createElement(
        DiffsWorkerPoolProvider,
        null,
        createElement(PoolProbe, { onPool: (pool) => (poolFromContext = pool) }),
      ),
    );

    // 挂载 + WorkerRenderOptionsSync 的 setRenderOptions effect 全部跑完仍是零 spawn。
    expect(ProviderStubWorker.constructions).toBe(0);
    expect(poolFromContext).toBeDefined();

    act(() => {
      (poolFromContext as DiffsWorkerPoolSurface).highlightDiffAST(
        diffRendererInstance,
        diffFixture,
      );
    });

    const expectedPoolSize = resolveDiffsWorkerBudget(
      typeof navigator.hardwareConcurrency === "number"
        ? navigator.hardwareConcurrency
        : Number.NaN,
      4,
    );
    expect(ProviderStubWorker.constructions).toBe(expectedPoolSize);

    cleanup();
    // 卸载终止 renderer-local 单例池，不留存活 worker。
    expect(ProviderStubWorker.instances.every((worker) => worker.terminated)).toBe(true);
  });
});
