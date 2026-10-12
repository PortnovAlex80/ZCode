import type { IFileWatcherService, SpecDocumentSnapshot } from "@zcode/services";

export interface SpecDocumentViewState {
  snapshot: SpecDocumentSnapshot | null;
  draft: string;
  ioPending: boolean;
}

/** Native parent-directory watch; immutable generation prevents stale async reads installing state. */
export function watchSpecDocument(options: {
  absolutePath: string;
  relativePath: string;
  watcher: Pick<IFileWatcherService, "watch" | "unwatch" | "onDynamicChange">;
  documents: { read(params: { path: string }): Promise<SpecDocumentSnapshot> };
  current: () => SpecDocumentViewState;
  apply: (snapshot: SpecDocumentSnapshot) => void;
  conflict: (snapshot: SpecDocumentSnapshot) => void;
  error: (error: unknown) => void;
}): () => void {
  let disposed = false;
  let generation = 0;
  let watcherId: string | null = null;
  let subscription: { dispose(): void } | null = null;
  const normalize = (path: string) => path.replaceAll("\\", "/").toLowerCase();
  const absolute = options.absolutePath.replaceAll("\\", "/");
  const directory = absolute.slice(0, absolute.lastIndexOf("/"));
  async function refresh() {
    const requested = ++generation;
    try {
      const next = await options.documents.read({ path: options.relativePath });
      const current = options.current();
      if (disposed || requested !== generation || current.snapshot?.path !== options.relativePath)
        return;
      if (current.snapshot.sha256 === next.sha256) return; // Save echo / repeated native event.
      if (current.ioPending || current.draft !== current.snapshot.content) options.conflict(next);
      else options.apply(next);
    } catch (error) {
      if (!disposed && requested === generation) options.error(error);
    }
  }
  void options.watcher
    .watch({ path: directory })
    .then(({ id }) => {
      if (disposed) {
        void options.watcher.unwatch({ id }).catch(options.error);
        return;
      }
      watcherId = id;
      subscription = options.watcher.onDynamicChange(id)((event) => {
        if (disposed || (event.changedPath && normalize(event.changedPath) !== normalize(absolute)))
          return;
        void refresh();
      });
      void refresh(); // Closes read-before-watch-registration freshness gap.
    })
    .catch((error) => {
      if (!disposed) options.error(error);
    });
  return () => {
    disposed = true;
    generation++;
    subscription?.dispose();
    if (watcherId) void options.watcher.unwatch({ id: watcherId }).catch(options.error);
  };
}
