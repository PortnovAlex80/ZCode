import { resolveDiffsWorkerBudget } from "./diffsWorkerBudget.js";
import { type ReactNode, useEffect, useMemo } from "react";
import {
  WorkerPoolContextProvider,
  useWorkerPool,
  type WorkerInitializationRenderOptions,
} from "@pierre/diffs/react";
import { createDiffsWorkerHighlighterOptions } from "@/lib/diffsHighlighterEngine.js";
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
  const poolOptions = useMemo(() => ({ workerFactory: createDiffsWorker, poolSize }), [poolSize]);
  const canUseWorkerPool = typeof window !== "undefined" && typeof Worker !== "undefined";

  if (!canUseWorkerPool) {
    return <>{children}</>;
  }

  return (
    <WorkerPoolContextProvider poolOptions={poolOptions} highlighterOptions={highlighterOptions}>
      <WorkerRenderOptionsSync highlighterOptions={highlighterOptions} />
      {children}
    </WorkerPoolContextProvider>
  );
}
