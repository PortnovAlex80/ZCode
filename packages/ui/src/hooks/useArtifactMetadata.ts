import { useCallback, useEffect, useRef } from "react";
import type { ProjectMetadataInput } from "@zcode/services";
import { useOptionalServices } from "./useServices.js";

/** Metadata IO stays behind the workspace-scoped service; dialogs own only drafts. */
export function useArtifactMetadata(workspacePath: string) {
  const service = useOptionalServices()?.projectMetadataService;
  const scope = useRef({ workspacePath, service, generation: 0, mounted: true });
  if (scope.current.workspacePath !== workspacePath || scope.current.service !== service) {
    scope.current = {
      workspacePath,
      service,
      generation: scope.current.generation + 1,
      mounted: true,
    };
  }
  useEffect(() => {
    scope.current.mounted = true;
    return () => {
      scope.current.mounted = false;
      scope.current.generation += 1;
    };
  }, [workspacePath, service]);

  const invoke = useCallback(
    async <T>(operation: () => Promise<T>) => {
      const generation = scope.current.generation;
      const isCurrent = () =>
        scope.current.mounted &&
        scope.current.workspacePath === workspacePath &&
        scope.current.service === service &&
        scope.current.generation === generation;
      if (!service || !isCurrent())
        throw new Error("Artifact metadata is unavailable in this workspace.");
      try {
        const result = await operation();
        return isCurrent() ? result : null;
      } catch (error) {
        if (!isCurrent()) return null;
        throw error;
      }
    },
    [service, workspacePath],
  );

  const read = useCallback(
    () => invoke(() => service!.read({ workspacePath })),
    [invoke, service, workspacePath],
  );
  const save = useCallback(
    (path: string, entry: ProjectMetadataInput) =>
      invoke(() => service!.save({ workspacePath, path, entry })),
    [invoke, service, workspacePath],
  );
  const remove = useCallback(
    (path: string) => invoke(() => service!.remove({ workspacePath, path })),
    [invoke, service, workspacePath],
  );
  const resolve = useCallback(
    (path: string) => invoke(() => service!.resolve({ workspacePath, path })),
    [invoke, service, workspacePath],
  );

  return { available: Boolean(service), read, save, remove, resolve };
}
