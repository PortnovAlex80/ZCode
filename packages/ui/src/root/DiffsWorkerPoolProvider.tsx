import { resolveDiffsWorkerBudget } from "./diffsWorkerBudget.js";
import { type ReactNode, useEffect, useMemo, useRef } from "react";
import {
  WorkerPoolContext,
  useWorkerPool,
  type WorkerInitializationRenderOptions,
} from "@pierre/diffs/react";
import {
  getOrCreateWorkerPoolSingleton,
  terminateWorkerPoolSingleton,
  type WorkerPoolManager,
} from "@pierre/diffs/worker";
import { createDiffsWorkerHighlighterOptions } from "@/lib/diffsHighlighterEngine.js";
import { LazyDiffsWorkerPool } from "./lazyDiffsWorkerPool.js";
import { logger } from "@/logger.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/store/index.js";
import { useZCodeStore } from "@/store/StoreProvider.js";

function createDiffsWorker(): Worker {
  return new Worker(new URL("../workers/diffs.worker.ts", import.meta.url), {
    type: "module",
    name: "zcode-diffs-worker",
  });
}

function resolveWorkerPoolSize(maximum: number): number {
  return resolveDiffsWorkerBudget(
    typeof navigator === "undefined" ? NaN : navigator.hardwareConcurrency,
    maximum,
  );
}

// 与库版 WorkerPoolContextProvider 的 instanceCount 语义一致：renderer 内若同时存在
// 多个 provider（当前 app 每个 renderer 只有一个），只有最后一个卸载才终止共享的
// renderer-local 单例池，避免先卸载的 provider 杀掉仍在使用的 worker。
let diffsWorkerPoolProviderInstanceCount = 0;

function WorkerRenderOptionsSync({
  highlighterOptions,
}: {
  highlighterOptions: WorkerInitializationRenderOptions;
}) {
  const workerPool = useWorkerPool();

  useEffect(() => {
    if (!workerPool) {
      return;
    }

    void workerPool
      .setRenderOptions({
        theme: highlighterOptions.theme,
        lineDiffType: highlighterOptions.lineDiffType,
        maxLineDiffLength: highlighterOptions.maxLineDiffLength,
        tokenizeMaxLineLength: highlighterOptions.tokenizeMaxLineLength,
        useTokenTransformer: highlighterOptions.useTokenTransformer,
      })
      .catch((error: unknown) => {
        logger.warn("[DiffsWorkerPoolProvider] 同步渲染参数失败", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }, [highlighterOptions, workerPool]);

  return null;
}

export function DiffsWorkerPoolProvider({
  children,
  maxWorkers = 4,
}: {
  children: ReactNode;
  maxWorkers?: number;
}) {
  const codePreviewSettings = useZCodeStore(
    (state) => state.codePreviewSettings ?? DEFAULT_CODE_PREVIEW_SETTINGS,
  );

  const highlighterOptions = useMemo<WorkerInitializationRenderOptions>(
    () =>
      createDiffsWorkerHighlighterOptions({
        lightTheme: codePreviewSettings.lightTheme,
        darkTheme: codePreviewSettings.darkTheme,
      }),
    [codePreviewSettings.darkTheme, codePreviewSettings.lightTheme],
  );

  const poolSize = useMemo(() => resolveWorkerPoolSize(maxWorkers), [maxWorkers]);
  const canUseWorkerPool = typeof window !== "undefined" && typeof Worker !== "undefined";

  // 修复原因：库版 WorkerPoolContextProvider 挂载即构造 WorkerPoolManager，构造函数会立刻
  // spawn 整池 worker 并初始化主线程 shiki highlighter（P-02 的 eager 成本）。这里改用
  // WorkerPoolContext.Provider + 惰性代理：挂载零 spawn，首个 diff/highlight 请求才通过
  // delegate 构造 renderer-local 单例池；池上限仍由 resolveDiffsWorkerBudget 决定
  // （主窗口默认 4、面板 2），渲染器之间不共享。
  const highlighterOptionsRef = useRef(highlighterOptions);
  highlighterOptionsRef.current = highlighterOptions;

  const lazyPoolRef = useRef<LazyDiffsWorkerPool | null>(null);
  if (!lazyPoolRef.current) {
    lazyPoolRef.current = new LazyDiffsWorkerPool({
      getHighlighterOptions: () => highlighterOptionsRef.current,
      createManager: (options) =>
        getOrCreateWorkerPoolSingleton({
          poolOptions: { workerFactory: createDiffsWorker, poolSize },
          highlighterOptions: options,
        }),
    });
  }
  const lazyPool = lazyPoolRef.current;

  useEffect(() => {
    diffsWorkerPoolProviderInstanceCount += 1;
    return () => {
      diffsWorkerPoolProviderInstanceCount -= 1;
      if (diffsWorkerPoolProviderInstanceCount > 0) {
        return;
      }
      // 与库版卸载语义一致：最后一个使用方卸载时终止 renderer-local 单例池；未唤醒时
      // 只丢弃休眠记录，不产生任何 worker。单例置空后重新挂载可按需再次构造。
      terminateWorkerPoolSingleton();
      lazyPoolRef.current?.terminate();
    };
  }, []);

  if (!canUseWorkerPool) {
    return <>{children}</>;
  }

  return (
    <WorkerPoolContext.Provider value={lazyPool as unknown as WorkerPoolManager}>
      <WorkerRenderOptionsSync highlighterOptions={highlighterOptions} />
      {children}
    </WorkerPoolContext.Provider>
  );
}
