import { usePanelRef } from "react-resizable-panels";
import { logger } from "@/logger.js";
import { useEffect, useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import {
  AppWindowIcon,
  FolderOpenIcon,
  MessageSquare,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
} from "lucide-react";
import { PreviewPane } from "@/PreviewPane.js";
import { WorkspaceFileTree } from "@/workspace-file-tree/WorkspaceFileTree.js";
import {
  isTextCompatibleDocumentPath,
  useNativeFileEditing,
} from "@/spec-document/nativeFileEditing.js";
import {
  discussWorkspaceFileDocument,
  openWorkspaceFileDocumentWindow,
  type WorkspaceFileEntryPointRequest,
} from "@/spec-document/workspaceFileEntryPoints.js";
import { getWorkspaceFileRelativePath } from "@/workspace-file-tree/model.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { getPathLeaf, isAbsoluteFilePath, joinFilePath } from "@/lib/path.js";
import type { FileManagerTarget } from "@/lib/workspaceSidePane.js";

import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  WORKSPACE_VERTICAL_RESIZE_HANDLE_CLASS_NAME,
} from "@/components/ui/resizable.js";

export { WorkspaceFileTree };
const FILE_MANAGER_PANEL_IDS = ["directory", "preview"];

/**
 * CORR-1 follow-up (user ruling 2026-11-07 #3): the file tree produces lazy
 * `type: "file"` sources for documents (createCodeViewerSourceForWorkspaceFile),
 * while only inline tool previews arrive as `type: "text"`. The edit overlay and
 * the fork document entry points must therefore key off the source path for both
 * source types; gating on the "text" type alone left every tree-opened document
 * on a native-only header.
 *
 * 2026-11-07 #4 (user ruling): any text-compatible document is editable — the
 * gate is a binary denylist (isTextCompatibleDocumentPath), not a prose
 * extension whitelist. Binaries are additionally refused by the service-side
 * content guards on the first read.
 */
function getNativeEditableTextDocumentPath(source: CodeViewerSource | null): string | null {
  if (!source || (source.type !== "file" && source.type !== "text")) {
    return null;
  }
  // "text" sources carry an optional path; only a real path can be edited.
  if (typeof source.path !== "string") {
    return null;
  }
  return isTextCompatibleDocumentPath(source.path) ? source.path : null;
}

type FileManagerPaneProps = Omit<ComponentProps<typeof PreviewPane>, "source"> & {
  source: CodeViewerSource | null;
  target: FileManagerTarget;
  mobileOverlay: boolean;
  canOpenLocalFileManager: boolean;
  onNavigate: (source: CodeViewerSource) => void;
};

export function FileManagerPane({
  source,
  target,
  mobileOverlay,
  canOpenLocalFileManager,
  onNavigate,
  ...previewProps
}: FileManagerPaneProps) {
  const { intl } = useZCodeIntl();
  const editableTextDocumentPath = getNativeEditableTextDocumentPath(source);
  const nativeEditing = useNativeFileEditing({
    workspacePath: target.workspacePath,
    workspaceIdentity: target.workspaceIdentity,
    enabled: !target.workspaceRemoteSessionId && editableTextDocumentPath !== null,
    path: editableTextDocumentPath,
  });
  // CORR-1 (2026-11-07 #3): surface the context-menu document entry points on
  // the open native tab header too — editing/discussion controls must be visible
  // on the document, not only behind the right-click. Same eligibility as the
  // tree menu: local workspace, text document, string path. The request format
  // mirrors the row handlers in WorkspaceFileTreeRowView (workspace/target/path).
  const forkDocumentRequest: WorkspaceFileEntryPointRequest | null =
    editableTextDocumentPath !== null && !target.workspaceRemoteSessionId && canOpenLocalFileManager
      ? {
          workspacePath: target.workspacePath,
          ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
          // The entry-point contract carries an absolute row path; tool text
          // previews may hold a workspace-relative one, so normalize it here.
          path: isAbsoluteFilePath(editableTextDocumentPath)
            ? editableTextDocumentPath
            : joinFilePath(target.workspacePath, editableTextDocumentPath),
          name: getPathLeaf(editableTextDocumentPath),
        }
      : null;
  const forkDocumentRelativePath = forkDocumentRequest
    ? getWorkspaceFileRelativePath(target.workspacePath, forkDocumentRequest.path)
    : null;
  const forkDocumentEntryActions =
    forkDocumentRequest && forkDocumentRelativePath ? (
      <>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Discuss document"
          title="Discuss this document"
          onClick={() =>
            discussWorkspaceFileDocument({
              request: forkDocumentRequest,
              relativeDocumentPath: forkDocumentRelativePath,
            })
          }
        >
          <MessageSquare className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Open document in window"
          title="Open this document in a separate window"
          onClick={() => openWorkspaceFileDocumentWindow(forkDocumentRequest)}
        >
          <AppWindowIcon className="size-4" />
        </Button>
      </>
    ) : null;
  const [headerContainer, setHeaderContainer] = useState<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isNarrow, setIsNarrow] = useState(mobileOverlay);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 0) setIsNarrow(entry.contentRect.width < 384);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);
  const workspaceKey = target.workspaceIdentity?.trim() || target.workspacePath;
  const storedNavigationPreferenceOpen = useZCodeStore(
    (state) => state.fileManagerNavigationOpenByWorkspace[workspaceKey],
  );
  const setNavigationPreferenceOpen = useZCodeStore((state) => state.setFileManagerNavigationOpen);
  // 空白文件标签需要先显示目录供用户选择；仅覆盖当前标签，不改写工作区的历史偏好。
  const [initialNavigationOpenOverride, setInitialNavigationOpenOverride] = useState<true | null>(
    source ? null : true,
  );
  const [compactNavigationOpenOverride, setCompactNavigationOpenOverride] = useState<
    boolean | null
  >(mobileOverlay ? !source : null);
  const compactLayout = mobileOverlay || isNarrow;
  // 已选文件继承 workspace 偏好；空白标签默认展开，紧凑布局选中文件后仅临时收起当前面板。
  const navigationOpen = compactLayout
    ? (compactNavigationOpenOverride ??
      initialNavigationOpenOverride ??
      storedNavigationPreferenceOpen ??
      (!mobileOverlay || !source))
    : (initialNavigationOpenOverride ?? storedNavigationPreferenceOpen ?? true);
  const canNavigate = Boolean(target.workspacePath && (!source || source.path));
  const showNavigation = canNavigate && navigationOpen;
  const previewPanelRef = usePanelRef();
  const directoryPanelRef = usePanelRef();
  const navigationOnly = showNavigation && (isNarrow || mobileOverlay);
  useLayoutEffect(() => {
    // Panel 的 className 只作用于内层，hidden 会留下外层占位；用库的布局状态收起并恢复宽度。
    if (navigationOnly) previewPanelRef.current?.collapse();
    else previewPanelRef.current?.expand();
    if (showNavigation) directoryPanelRef.current?.expand();
    else directoryPanelRef.current?.collapse();
    logger.debug("[FileManager] 更新目录布局", { showNavigation, navigationOnly });
  }, [showNavigation, navigationOnly, previewPanelRef, directoryPanelRef]);
  const navigationLabel = intl.formatMessage({
    id: showNavigation ? "fileManager.hideNavigation" : "fileManager.showNavigation",
  });
  const navigate = (nextSource: CodeViewerSource) => {
    onNavigate({
      ...nextSource,
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
      workspaceRemoteSessionId: target.workspaceRemoteSessionId,
    });
    if (mobileOverlay || isNarrow) {
      setCompactNavigationOpenOverride(false);
    }
  };
  const toggleNavigation = () => {
    const nextOpen = !navigationOpen;
    setNavigationPreferenceOpen(workspaceKey, nextOpen);
    setInitialNavigationOpenOverride(null);
    setCompactNavigationOpenOverride(null);
  };

  return (
    <div
      ref={containerRef}
      className="@container flex h-full min-h-0 min-w-0 flex-col"
      data-file-manager-pane
    >
      <div className="flex h-10 shrink-0 items-center border-b border-border bg-surface/30">
        {canNavigate ? (
          <div className="flex shrink-0 items-center border-r border-border px-1.5">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={toggleNavigation}
              aria-label={navigationLabel}
              title={navigationLabel}
              aria-expanded={showNavigation}
            >
              {showNavigation ? (
                <PanelLeftCloseIcon className="size-4" />
              ) : (
                <PanelLeftOpenIcon className="size-4" />
              )}
            </Button>
          </div>
        ) : null}
        <div ref={setHeaderContainer} className="min-w-0 flex-1">
          {!source ? (
            <span className="px-3 text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "fileManager.title" })}
            </span>
          ) : null}
        </div>
      </div>
      <ResizablePanelGroup
        layoutId="file-manager-layout"
        panelIds={FILE_MANAGER_PANEL_IDS}
        disabled={!showNavigation || isNarrow || mobileOverlay}
        className="min-h-0 flex-1"
      >
        <ResizablePanel
          id="directory"
          panelRef={directoryPanelRef}
          collapsible
          collapsedSize="0px"
          defaultSize="192px"
          minSize="160px"
          maxSize={navigationOnly ? "100%" : "60%"}
          className="h-full min-w-0"
          onResize={(size) => logger.debug("[FileManager] 目录面板尺寸", size)}
        >
          {canNavigate ? (
            <WorkspaceFileTree
              {...target}
              canOpenLocalFileManager={canOpenLocalFileManager}
              activePreviewPath={source?.path}
              onOpenPreview={navigate}
              onOpenBrowserUrl={previewProps.onOpenBrowserUrl}
            />
          ) : null}
        </ResizablePanel>
        <ResizableHandle
          aria-label={intl.formatMessage({ id: "fileManager.resizeNavigation" })}
          className={cn(
            WORKSPACE_VERTICAL_RESIZE_HANDLE_CLASS_NAME,
            // 内部分隔线没有面板圆角，高亮需上下贴边，并与目录边框共用热区中线。
            "before:pointer-events-none before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-border before:content-[''] after:inset-y-0 after:rounded-none after:left-1/2 after:-translate-x-1/2",
            (!showNavigation || isNarrow || mobileOverlay) && "hidden",
          )}
        />
        <ResizablePanel
          id="preview"
          panelRef={previewPanelRef}
          collapsible
          collapsedSize="0px"
          minSize="160px"
          className="min-h-0 min-w-0"
        >
          {source ? (
            <PreviewPane
              {...previewProps}
              source={source}
              headerContainer={headerContainer}
              // 2026-11-07 (user ruling): the native file preview carries the
              // fork U-18 editing engine (Edit -> textarea + 500ms autosave +
              // Save + CAS). Native behavior is untouched; any non-binary text
              // document on a local workspace gets the edit entry (binary
              // denylist + service-side content guards as the backstop);
              // remote tabs stay natively read-only.
              // 2026-11-07 #3 (owner: fork): the same header cluster also carries
              // the fork document entry points, ordered
              // [Edit/View][Save][status][Discuss][Open in window].
              documentActions={
                forkDocumentEntryActions ? (
                  <>
                    {nativeEditing.documentActions ?? previewProps.documentActions}
                    {forkDocumentEntryActions}
                  </>
                ) : (
                  (nativeEditing.documentActions ?? previewProps.documentActions)
                )
              }
              sourceEditor={nativeEditing.sourceEditor ?? previewProps.sourceEditor}
              requestMarkdownViewMode={nativeEditing.requestMarkdownViewMode}
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-ui-base text-foreground-subtle">
              <FolderOpenIcon className="size-6" />
              <span>{intl.formatMessage({ id: "fileManager.empty" })}</span>
            </div>
          )}
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
