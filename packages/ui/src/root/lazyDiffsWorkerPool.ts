import type {
  DiffRendererInstance,
  FileRendererInstance,
  WorkerInitializationRenderOptions,
  WorkerPoolManager,
  WorkerRenderingOptions,
  WorkerStats,
} from "@pierre/diffs/worker";
import { DEFAULT_THEMES } from "@pierre/diffs";
import type {
  FileContents,
  FileDiffMetadata,
  HunkExpansionRegion,
  RenderDiffOptions,
  RenderDiffResult,
  RenderFileOptions,
  RenderFileResult,
  SupportedLanguages,
  ThemedDiffResult,
  ThemedFileResult,
} from "@pierre/diffs";

/**
 * @pierre/diffs 渲染实例（File/FileDiff/UnresolvedFile 及其 renderer）实际消费的
 * WorkerPoolManager 公开方法子集。未列入的成员（缓存检查、worker 内部调度等）只被
 * 库自身内部调用，惰性代理不需要复制。
 */
export type DiffsWorkerPoolSurface = Pick<
  WorkerPoolManager,
  | "cleanUpPendingTasks"
  | "getDiffRenderOptions"
  | "getDiffResultCache"
  | "getFileRenderOptions"
  | "getFileResultCache"
  | "getPlainDiffAST"
  | "getPlainFileAST"
  | "getStats"
  | "highlightDiffAST"
  | "highlightFileAST"
  | "initialize"
  | "isInitialized"
  | "isWorkingPool"
  | "setRenderOptions"
  | "subscribeToStatChanges"
  | "subscribeToThemeChanges"
  | "terminate"
  | "unsubscribeToThemeChanges"
>;

export interface LazyDiffsWorkerPoolDelegate {
  /** 唤醒构造真实池时读取最新期望配置（主题、引擎选择等）。 */
  getHighlighterOptions(): WorkerInitializationRenderOptions;
  /** 构造 renderer-local 真实 worker 池；单测注入假实现验证唤醒语义。 */
  createManager(highlighterOptions: WorkerInitializationRenderOptions): DiffsWorkerPoolSurface;
}

type ThemeSubscriberInstance = Parameters<DiffsWorkerPoolSurface["subscribeToThemeChanges"]>[0];
type StatChangeCallback = Parameters<DiffsWorkerPoolSurface["subscribeToStatChanges"]>[0];

// 与 WorkerPoolManager 构造函数的默认值保持一致（dist/worker/WorkerPoolManager.js），
// 休眠期 getDiffRenderOptions/getFileRenderOptions 返回的形状必须与真实池未初始化时相同。
const DEFAULT_RENDER_OPTION_FALLBACKS = {
  useTokenTransformer: false,
  lineDiffType: "word-alt",
  maxLineDiffLength: 1_000,
  tokenizeMaxLineLength: 1_000,
} as const;

/**
 * 修复原因：@pierre/diffs 的 WorkerPoolManager 在构造函数里无条件 queueInitialization，
 * 即刻 spawn 全部 worker 并初始化主线程 shiki highlighter。此前 Root 与
 * SpecDetachedPanelRoot 挂载 DiffsWorkerPoolProvider 时，渲染器在没有任何 diff/highlight
 * 请求的情况下就付出整池 worker + 主线程高亮器的启动成本。
 *
 * 修复方式：提供context的值换成本惰性代理——在首个 diff/highlight 请求（highlight*AST /
 * getPlain*AST / initialize）之前不构造真实池；构造后所有调用原样转发，输出与 eager 池
 * 逐字节一致（同一 manager、同一参数）。休眠期的返回值对齐“未初始化的真实池”：
 * cache 查询为 undefined、plain AST 为 undefined（highlighter == null 分支）、
 * isWorkingPool 为 true、stats 为 waiting/0 worker。
 */
export class LazyDiffsWorkerPool implements DiffsWorkerPoolSurface {
  private manager: DiffsWorkerPoolSurface | undefined;
  private readonly dormantThemeSubscribers = new Set<ThemeSubscriberInstance>();
  private readonly dormantStatSubscribers = new Set<StatChangeCallback>();

  constructor(private readonly delegate: LazyDiffsWorkerPoolDelegate) {}

  /** 真实池是否已被首个 diff/highlight 请求唤醒（测试与诊断用）。 */
  isAwake(): boolean {
    return this.manager !== undefined;
  }

  private wake(): DiffsWorkerPoolSurface {
    if (!this.manager) {
      const manager = this.delegate.createManager(this.delegate.getHighlighterOptions());
      this.manager = manager;
      // 休眠期登记的主题/stat 订阅在唤醒时补登记，保证唤醒前后变更通知都可达。
      for (const instance of this.dormantThemeSubscribers) {
        manager.subscribeToThemeChanges(instance);
      }
      this.dormantThemeSubscribers.clear();
      for (const callback of this.dormantStatSubscribers) {
        manager.subscribeToStatChanges(callback);
      }
      this.dormantStatSubscribers.clear();
    }
    return this.manager;
  }

  isWorkingPool(): boolean {
    // 休眠池没有失败过，语义与未失败的真实池一致（true），渲染器据此继续走 worker 池路径。
    return this.manager ? this.manager.isWorkingPool() : true;
  }

  isInitialized(): boolean {
    // 未初始化的真实池 isInitialized() 为 false；唤醒后转发。
    return this.manager ? this.manager.isInitialized() : false;
  }

  async initialize(languages?: SupportedLanguages[]): Promise<void> {
    await this.wake().initialize(languages);
  }

  async setRenderOptions(options: Partial<WorkerRenderingOptions>): Promise<void> {
    if (!this.manager) {
      // 真实池的 setRenderOptions 会 `await this.initialize()` 主动拉起 worker；休眠期绝不能
      // 这样做，否则挂载期的 WorkerRenderOptionsSync 会把惰性化完全抵消。这里只让休眠期
      // 订阅的实例重渲染（主题读取走 getDiffRenderOptions 的最新期望值），唤醒时用
      // delegate.getHighlighterOptions() 的最新配置构造，最终输出与立即同步一致。
      for (const instance of this.dormantThemeSubscribers) {
        instance.rerender();
      }
      return;
    }
    await this.manager.setRenderOptions(options);
  }

  getFileRenderOptions(): RenderFileOptions {
    if (this.manager) {
      return this.manager.getFileRenderOptions();
    }
    const {
      theme = DEFAULT_THEMES,
      useTokenTransformer = DEFAULT_RENDER_OPTION_FALLBACKS.useTokenTransformer,
      tokenizeMaxLineLength = DEFAULT_RENDER_OPTION_FALLBACKS.tokenizeMaxLineLength,
    } = this.delegate.getHighlighterOptions();
    return { theme, useTokenTransformer, tokenizeMaxLineLength };
  }

  getDiffRenderOptions(): RenderDiffOptions {
    if (this.manager) {
      return this.manager.getDiffRenderOptions();
    }
    const {
      theme = DEFAULT_THEMES,
      useTokenTransformer = DEFAULT_RENDER_OPTION_FALLBACKS.useTokenTransformer,
      lineDiffType = DEFAULT_RENDER_OPTION_FALLBACKS.lineDiffType,
      maxLineDiffLength = DEFAULT_RENDER_OPTION_FALLBACKS.maxLineDiffLength,
      tokenizeMaxLineLength = DEFAULT_RENDER_OPTION_FALLBACKS.tokenizeMaxLineLength,
    } = this.delegate.getHighlighterOptions();
    return { theme, useTokenTransformer, lineDiffType, maxLineDiffLength, tokenizeMaxLineLength };
  }

  getFileResultCache(file: FileContents): RenderFileResult | undefined {
    // 休眠池没有任何缓存；与全新真实池的 LRU 未命中（undefined）一致。
    return this.manager?.getFileResultCache(file);
  }

  getDiffResultCache(diff: FileDiffMetadata): RenderDiffResult | undefined {
    return this.manager?.getDiffResultCache(diff);
  }

  getPlainFileAST(
    file: FileContents,
    startingLine: number,
    totalLines: number,
    lines?: string[],
  ): ThemedFileResult | undefined {
    // 真实池在主线程 highlighter 未就绪时同样返回 undefined，并且该调用本身会触发
    // queueInitialization——这里“先唤醒再转发”正好复刻该语义：本次调用返回 undefined，
    // 异步初始化完成后（worker 结果或重渲染到达时）后续调用返回真实结果。
    return this.wake().getPlainFileAST(file, startingLine, totalLines, lines);
  }

  getPlainDiffAST(
    diff: FileDiffMetadata,
    startingLine: number,
    totalLines: number,
    expandedHunks?: Map<number, HunkExpansionRegion> | true,
    collapsedContextThreshold?: number,
  ): ThemedDiffResult | undefined {
    return this.wake().getPlainDiffAST(
      diff,
      startingLine,
      totalLines,
      expandedHunks,
      collapsedContextThreshold,
    );
  }

  highlightFileAST(instance: FileRendererInstance, file: FileContents): void {
    this.wake().highlightFileAST(instance, file);
  }

  highlightDiffAST(instance: DiffRendererInstance, diff: FileDiffMetadata): void {
    this.wake().highlightDiffAST(instance, diff);
  }

  subscribeToThemeChanges(instance: ThemeSubscriberInstance): () => void {
    if (!this.manager) {
      this.dormantThemeSubscribers.add(instance);
      return () => {
        this.unsubscribeToThemeChanges(instance);
      };
    }
    return this.manager.subscribeToThemeChanges(instance);
  }

  unsubscribeToThemeChanges(instance: ThemeSubscriberInstance): void {
    this.dormantThemeSubscribers.delete(instance);
    this.manager?.unsubscribeToThemeChanges(instance);
  }

  subscribeToStatChanges(callback: StatChangeCallback): () => void {
    if (!this.manager) {
      this.dormantStatSubscribers.add(callback);
      // 与真实池一致：订阅时立即回播一次当前 stats（休眠期即 waiting/0 worker）。
      callback(this.getStats());
      return () => {
        this.dormantStatSubscribers.delete(callback);
      };
    }
    return this.manager.subscribeToStatChanges(callback);
  }

  cleanUpPendingTasks(instance: FileRendererInstance | DiffRendererInstance): void {
    // 休眠池没有排队/进行中的任务；与真实池对空队列清理等价，保持 no-op。
    this.manager?.cleanUpPendingTasks(instance);
  }

  getStats(): WorkerStats {
    if (this.manager) {
      return this.manager.getStats();
    }
    return {
      managerState: "waiting",
      workersFailed: false,
      totalWorkers: 0,
      busyWorkers: 0,
      queuedTasks: 0,
      pendingTasks: 0,
      themeSubscribers: this.dormantThemeSubscribers.size,
      fileCacheSize: 0,
      diffCacheSize: 0,
    };
  }

  terminate(): void {
    // 与库版 WorkerPoolContextProvider 的卸载语义对齐：终止真实池并释放休眠期登记的
    // 订阅引用；下次请求会按需重新唤醒（由 provider 侧清理 renderer-local 单例）。
    this.manager?.terminate();
    this.manager = undefined;
    this.dormantThemeSubscribers.clear();
    this.dormantStatSubscribers.clear();
  }
}
