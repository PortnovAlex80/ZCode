/* eslint-disable max-lines -- Document controller composes isolated presentation, writer lease, watcher and native discussion modules. */
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type SyntheticEvent,
} from "react";
import {
  Eye,
  GripHorizontal,
  Maximize2,
  MessageSquare,
  Minimize2,
  Pencil,
  RotateCcw,
  Save,
} from "lucide-react";
import type { SpecDocumentSnapshot } from "@zcode/services";
import { uuidv7 } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { PreviewPane } from "@/PreviewPane.js";
import { inferCodeLanguage, type CodeViewerSource } from "@/lib/codeViewer.js";
import { useServices } from "@/hooks/useServices.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { V4PaneConversationProvider } from "@/v4/V4ConversationContext.js";
import { SpecDiscussionPane } from "./SpecDiscussionPane.js";
import {
  changeSpecQuestionDraft,
  getSpecThreadStore,
  mergeSpecThreadUpdate,
  type SpecAnchor,
  type SpecThread,
  type SpecThreadStore,
} from "./specThread.js";
import { useSpecWriteGuard } from "./useSpecDiscussion.js";
import { useSpecDiscussionWriter } from "./useSpecDiscussionWriter.js";
import { watchSpecDocument } from "./specDocumentWatch.js";
import {
  resolveSpecExecutionSessionId,
  useNativeExecutionSource,
} from "./nativeExecutionSource.js";
import {
  MANAGED_NATIVE_DISCUSSION_OPEN_EVENT,
  registerManagedNativeDiscussion,
  specThreadStorageKey,
  type ManagedNativeDiscussionOpenRequest,
} from "./nativeDiscussionHandoff.js";
import {
  cancelDiscussionGesture,
  clampDiscussionRect,
  dockedDiscussionLayout,
  keyboardDiscussionGeometry,
  MIN_DISCUSSION_HEIGHT,
  MIN_DISCUSSION_WIDTH,
  MIN_DOCUMENT_HEIGHT,
  updateDiscussionGesture,
  type DiscussionBounds,
  type DiscussionGesture,
  type DiscussionGestureKind,
  type DiscussionMode,
} from "./specDiscussionGeometry.js";

import {
  documentPresentationKey,
  isMissingDocumentError,
  newDocumentPaneWriteToken,
  readDocumentPresentation,
  recoverMissingDocumentPresentation,
  writeDocumentPresentation,
  readDocumentDraft,
  writeDocumentDraft,
  restoreDocumentDraft,
  retireDocumentPaneWrites,
  type DocumentPresentationState,
} from "./specDocumentPresentationState.js";
import { SpecDocumentPicker } from "./specDocumentPicker.js";
import { ArtifactMetadataControls } from "./ArtifactMetadataControls.js";
import {
  SpecPopoutIconButton,
  SpecPopoutRegionPortal,
  useSpecPopoutRegion,
} from "./specPopoutRegion.js";

export interface SpecDocumentPaneProps {
  workspacePath: string;
  workspaceIdentity?: string;
  parentSessionId: string | null;
  initialPath?: string;
  onClose: () => void;
  onOpenBrowserUrl?: (url: string) => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  visible?: boolean;
  onActivate?: () => void;
  /**
   * U-12 多开：文档 tab 实例的稳定身份（宿主传 tab id）。缺省回退 initialPath
   * （旧单实例语义）；提供后 tab 内切换文档不再因 initialPath 变化重挂面板。
   */
  instanceKey?: string;
  /**
   * U-12 多开：false 时挂载不自动恢复持久化的上一次文档——新 «+» tab 保持
   * 选择器初始态（标题维持「Open doc」直到用户选择文档）。缺省 true（旧语义，
   * 单实例/测试直接渲染时仍恢复上一次文档）。
   */
  autoOpenLastDocument?: boolean;
  /**
   * U-12 多开：本 tab 内打开/切换文档（workspace 相对路径）后通知宿主；宿主据此
   * 把 tab 标题更新为文件名并回填稳定 sourceKey（同文件的链接按它复用本 tab）。
   */
  onDocumentOpen?: (relativePath: string) => void;
}

function Documents({
  workspacePath,
  workspaceIdentity,
  parentSessionId: shellParentSessionId,
  initialPath,
  onClose,
  onOpenBrowserUrl,
  onOpenCodeViewer,
  visible = true,
  onActivate,
  autoOpenLastDocument = true,
  onDocumentOpen,
}: SpecDocumentPaneProps) {
  const nativeDiscussionWindows = Boolean(useOptionalPlatform()?.openConversationPopout);
  const { specDocumentService: documentService, fileWatcherService, projectMetadataService } =
    useServices();
  // Capture this pane's project in every IO request; no shared mutable workspace.
  const documents = useMemo(
    () =>
      documentService && {
        getWorkspace: () => documentService.getWorkspace({ workspacePath }),
        list: () => documentService.list({ workspacePath }),
        read: (params: { path: string }) =>
          documentService.read({ ...params, workspacePath }),
        save: (params: {
          path: string;
          content: string;
          expectedSha256: string;
        }) => documentService.save({ ...params, workspacePath }),
        remove: (params: { path: string }) =>
          documentService.remove({ ...params, workspacePath }),
      },
    [documentService, workspacePath],
  );
  const executionSource = useNativeExecutionSource(
    workspaceIdentity?.trim() || workspacePath,
  );
  const parentSessionId = resolveSpecExecutionSessionId(
    shellParentSessionId,
    executionSource,
  );
  const storageKey = specThreadStorageKey(workspacePath, workspaceIdentity);
  const discussionWriter = useSpecDiscussionWriter(
    workspaceIdentity?.trim() || workspacePath,
  );
  const presentationKey = documentPresentationKey(
    workspacePath,
    workspaceIdentity,
  );
  const [restoredPresentation] = useState(() =>
    readDocumentPresentation(presentationKey),
  );
  const presentationRef =
    useRef<DocumentPresentationState>(restoredPresentation);
  // 本面板的草稿写入令牌：卸载清理时退役，之后任何迟到写入都不得覆盖
  // 接管面板（子窗口/重新挂载的源面板）已经持久化的草稿。
  const [paneWriteToken] = useState(() => newDocumentPaneWriteToken());
  useEffect(
    () => () => retireDocumentPaneWrites(presentationKey, paneWriteToken),
    [presentationKey, paneWriteToken],
  );
  const onActivateRef = useRef(onActivate);
  onActivateRef.current = onActivate;
  // U-12：文档变更通知走 ref（与 onActivateRef 同款）——异步读取完成后调用时
  // 永远拿到宿主最新回调，不把 onDocumentOpen 加进挂载 effect 依赖而重跑恢复流程。
  const onDocumentOpenRef = useRef(onDocumentOpen);
  onDocumentOpenRef.current = onDocumentOpen;
  function notifyDocumentOpen(relativePath: string) {
    onDocumentOpenRef.current?.(relativePath);
  }
  const restoringScrollRef = useRef(true);
  const [baseSha256, setBaseSha256] = useState("");
  const baseSha256Ref = useRef("");
  const [files, setFiles] = useState<string[]>([]);
  const [document, setDocument] = useState<SpecDocumentSnapshot | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("Opening local documents…");
  const [threads, setThreads] = useState<SpecThread[]>([]);
  const threadsRef = useRef<SpecThread[]>([]);
  const threadStoreRef = useRef<SpecThreadStore | null>(null);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(
    restoredPresentation.activeThreadId,
  );
  const [discussionsVisible, setDiscussionsVisible] = useState(
    restoredPresentation.discussionsVisible,
  );
  const [discussionMode, setDiscussionMode] = useState<DiscussionMode>(
    restoredPresentation.discussionMode,
  );
  const [discussionRect, setDiscussionRect] = useState(
    restoredPresentation.discussionRect,
  );
  const [discussionBounds, setDiscussionBounds] = useState<DiscussionBounds>({
    width: 720,
    height: 600,
  });
  const discussionContainerRef = useRef<HTMLDivElement>(null);
  const discussionRectRef = useRef(discussionRect);
  const discussionBoundsRef = useRef(discussionBounds);
  const discussionGestureRef = useRef<
    | (DiscussionGesture & { pointerId: number; target: HTMLButtonElement })
    | null
  >(null);
  discussionRectRef.current = discussionRect;
  discussionBoundsRef.current = discussionBounds;
  const dockedLayout = dockedDiscussionLayout(discussionRect, discussionBounds);
  useLayoutEffect(() => {
    const element = discussionContainerRef.current;
    if (!element) return;
    const measure = () => {
      if (!element.clientWidth || !element.clientHeight) return;
      const bounds = {
        width: element.clientWidth,
        height: element.clientHeight,
      };
      discussionBoundsRef.current = bounds;
      setDiscussionBounds(bounds);
      setDiscussionRect((current) => clampDiscussionRect(current, bounds));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  function finishDiscussionGesture(canceled = false) {
    const gesture = discussionGestureRef.current;
    if (!gesture) return;
    discussionGestureRef.current = null;
    if (canceled)
      setDiscussionRect(
        cancelDiscussionGesture(gesture, discussionBoundsRef.current),
      );
    if (gesture.target.hasPointerCapture(gesture.pointerId))
      gesture.target.releasePointerCapture(gesture.pointerId);
  }
  useEffect(() => {
    if (!visible || !discussionsVisible) finishDiscussionGesture(true);
    return () => finishDiscussionGesture(true);
  }, [visible, discussionsVisible]);
  function startDiscussionGesture(
    event: PointerEvent<HTMLButtonElement>,
    kind: DiscussionGestureKind,
  ) {
    if (event.button !== 0) return;
    event.preventDefault();
    discussionGestureRef.current = {
      kind,
      startX: event.clientX,
      startY: event.clientY,
      start: { ...discussionRectRef.current },
      pointerId: event.pointerId,
      target: event.currentTarget,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function moveDiscussionGesture(event: PointerEvent<HTMLButtonElement>) {
    const gesture = discussionGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    setDiscussionRect(
      updateDiscussionGesture(
        gesture,
        event.clientX,
        event.clientY,
        discussionBoundsRef.current,
      ),
    );
  }
  function keyboardDiscussion(
    event: KeyboardEvent<HTMLButtonElement>,
    kind: DiscussionGestureKind,
  ) {
    if (event.key === "Escape" && discussionGestureRef.current) {
      finishDiscussionGesture(true);
      event.stopPropagation();
      return;
    }
    if (
      !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
    )
      return;
    event.preventDefault();
    setDiscussionRect((current) =>
      keyboardDiscussionGeometry(
        current,
        kind,
        event.key,
        event.shiftKey,
        discussionBoundsRef.current,
      ),
    );
  }
  const [selection, setSelection] = useState<SpecAnchor | null>(null);
  const [bindingReady, setBindingReady] = useState(false);
  const [ioPending, setIoPending] = useState(false);
  const [editing, setEditing] = useState(restoredPresentation.editing);
  const [writable, setWritable] = useState(false);
  const documentRef = useRef(document);
  const draftRef = useRef(draft);
  const ioPendingRef = useRef(ioPending);
  const contentRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  documentRef.current = document;
  draftRef.current = draft;
  ioPendingRef.current = ioPending;
  function install(next: SpecDocumentSnapshot) {
    documentRef.current = next;
    draftRef.current = next.content;
    baseSha256Ref.current = next.sha256;
    setBaseSha256(next.sha256);
    setDocument(next);
    setDraft(next.content);
  }
  const dirty = Boolean(document && draft !== document.content);
  function persistPresentation() {
    const current = presentationRef.current;
    if (!writeDocumentPresentation(presentationKey, current))
      setError("Document view state could not be saved for reopening.");
  }
  // Preserve a dirty buffer separately from the disk snapshot and its save precondition.
  useEffect(() => {
    if (!document) return;
    if (
      !writeDocumentDraft(
        presentationKey,
        document.path,
        dirty ? { content: draft, baseSha256 } : null,
        undefined,
        paneWriteToken,
      )
    ) {
      setError(
        "The unsaved document draft could not be retained for reopening. Keep this pane open until saved.",
      );
    }
  }, [presentationKey, document, draft, baseSha256, dirty, paneWriteToken]);
  useEffect(() => {
    if (!document) return;
    presentationRef.current = {
      ...presentationRef.current,
      path: document.path,
      editing,
      activeThreadId,
      discussionsVisible,
      discussionMode,
      discussionRect,
    };
    persistPresentation();
  }, [
    document?.path,
    editing,
    activeThreadId,
    discussionsVisible,
    discussionMode,
    discussionRect,
    presentationKey,
  ]);
  function captureScroll(event: SyntheticEvent<HTMLDivElement>) {
    const target = event.target;
    if (
      restoringScrollRef.current ||
      !(target instanceof HTMLElement) ||
      // U-09：[data-document-prose] 是 txt 只读正文视图（本面板自带，见 sourceEditor 槽）。
      !target.matches(
        "textarea, [data-markdown-preview], [data-document-prose]",
      )
    )
      return;
    presentationRef.current = {
      ...presentationRef.current,
      scrollTop: target.scrollTop,
    };
    persistPresentation();
  }
  useLayoutEffect(() => {
    if (!document) return;
    restoringScrollRef.current = true;
    let frame = 0;
    const restore = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const target = editing
          ? editorRef.current
          : contentRef.current?.querySelector<HTMLElement>(
              "[data-markdown-preview], [data-document-prose]",
            );
        if (!target) return;
        target.scrollTop = presentationRef.current.scrollTop;
        restoringScrollRef.current = false;
        observer?.disconnect();
      });
    };
    // Heavy markdown content may appear after PreviewPane's first render.
    const observer = contentRef.current ? new MutationObserver(restore) : null;
    if (contentRef.current)
      observer?.observe(contentRef.current, { childList: true, subtree: true });
    restore();
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [document?.path, editing]);
  const writeGuard = useSpecWriteGuard([
    ...(parentSessionId ? [parentSessionId] : []),
    ...threads.flatMap((thread) =>
      thread.sessionId ? [thread.sessionId] : [],
    ),
    ...threads.map((thread) => thread.parentSessionId),
  ]);
  const writers =
    writeGuard.blocked || threads.some((thread) => Boolean(thread.pending));
  useEffect(() => {
    if (!documents || !document?.path) return;
    return watchSpecDocument({
      absolutePath: `${workspacePath.replaceAll("\\", "/").replace(/\/$/, "")}/${document.path}`,
      relativePath: document.path,
      watcher: fileWatcherService,
      documents,
      current: () => ({
        snapshot: documentRef.current,
        draft: draftRef.current,
        ioPending: ioPendingRef.current,
      }),
      apply: (next) => {
        const preview = contentRef.current?.querySelector<HTMLElement>(
          "[data-markdown-preview], [data-document-prose]",
        );
        const scrollTop =
          preview?.scrollTop ?? editorRef.current?.scrollTop ?? 0;
        const start = editorRef.current?.selectionStart;
        const end = editorRef.current?.selectionEnd;
        install(next);
        setStatus("Updated from disk");
        setSelection(null);
        requestAnimationFrame(() => {
          const refreshed = contentRef.current?.querySelector<HTMLElement>(
            "[data-markdown-preview], [data-document-prose]",
          );
          if (refreshed) refreshed.scrollTop = scrollTop;
          if (editorRef.current) {
            editorRef.current.scrollTop = scrollTop;
            if (start !== undefined && end !== undefined)
              editorRef.current.setSelectionRange(
                Math.min(start, next.content.length),
                Math.min(end, next.content.length),
              );
          }
        });
      },
      conflict: () => {
        setStatus("External change · draft retained");
        setError(
          "Document changed externally. Reload discards your draft; Save checks the original hash and may conflict.",
        );
      },
      error: (cause) =>
        setError(
          `Document watch/read failed: ${String(cause)}. Use Reload to recover.`,
        ),
    });
  }, [documents, fileWatcherService, document?.path, workspacePath]);
  useEffect(() => {
    let live = true;
    setBindingReady(false);
    let releaseThreads: (() => void) | undefined;
    try {
      const store = getSpecThreadStore(
        storageKey,
        workspaceIdentity?.trim() || workspacePath,
      );
      threadStoreRef.current = store;
      const refresh = () => {
        const current = store.get();
        for (const thread of current)
          if (thread.sessionId)
            registerManagedNativeDiscussion({
              workspacePath,
              workspaceIdentity,
              threadId: thread.id,
              sessionId: thread.sessionId,
            });
        threadsRef.current = current;
        setThreads(current);
      };
      refresh();
      releaseThreads = store.subscribe(refresh);
      setBindingReady(true);
    } catch (cause) {
      setError(String(cause));
    }
    if (!documents) setError("Documents are unavailable in this build.");
    else {
      // 恢复目标在链外计算，失败分类时需要原始请求路径（而不是序列化后的异常文本）。
      // U-12：autoOpenLastDocument=false（«+» 新开的选择器 tab）不回退到持久化的
      // 上一次文档——新 tab 必须停在「未选文档」初始态，标题维持 Open doc；
      // 有 initialPath（tab 绑定的文件 / 消息链接）时优先 initialPath，行为不变。
      const requestedPath =
        initialPath ||
        (autoOpenLastDocument ? restoredPresentation.path : null);
      void documents
        .getWorkspace()
        .then(async (grant) => {
          if (live) setWritable(grant.writable);
          const next = await documents.list();
          if (live) {
            setFiles(next);
            setStatus(`${next.length} documents · local UTF-8 files`);
          }
          if (requestedPath) {
            const normalizedRoot = grant.root
              .replaceAll("\\", "/")
              .replace(/\/$/, "");
            const normalizedPath = requestedPath.replaceAll("\\", "/");
            const relativePath = normalizedPath
              .toLowerCase()
              .startsWith(`${normalizedRoot.toLowerCase()}/`)
              ? normalizedPath.slice(normalizedRoot.length + 1)
              : normalizedPath;
            const opened = await documents.read({ path: relativePath });
            if (live) {
              install(opened);
              // U-12：挂载恢复也回填 tab 身份（标题/sourceKey 跟随实际打开的文件）。
              notifyDocumentOpen(opened.path);
              const restored = restoreDocumentDraft(
                opened,
                readDocumentDraft(presentationKey, opened.path),
              );
              draftRef.current = restored.content;
              setDraft(restored.content);
              baseSha256Ref.current = restored.baseSha256;
              setBaseSha256(restored.baseSha256);
              if (restoredPresentation.path !== opened.path) {
                presentationRef.current = {
                  ...presentationRef.current,
                  path: opened.path,
                  scrollTop: 0,
                  activeThreadId: null,
                  discussionsVisible: false,
                };
                setActiveThreadId(null);
                setDiscussionsVisible(false);
              }
              setStatus(
                restored.content !== opened.content
                  ? "Unsaved draft restored"
                  : "Saved on disk",
              );
              if (restored.conflict)
                setError(
                  "Document changed on disk while closed. Your unsaved draft is retained; Save checks its original hash. Reload discards the draft and uses current disk content.",
                );
            }
          }
        })
        .catch((cause) => {
          if (!live) return;
          // 原因：持久化恢复的文档已被删除/移动时，原先只显示原始报错，过期 path
          // 留在持久化视图里导致每次重开都再失败；草稿仍在存储中却不可见、不可恢复。
          // 修复：文件缺失时清掉过期的 path/线程选择/滚动（草稿条目保留），
          // 显示可恢复状态：文件回来或再次选择该文件时草稿会自动恢复。
          if (requestedPath && isMissingDocumentError(cause)) {
            const recovered =
              recoverMissingDocumentPresentation(presentationKey);
            presentationRef.current = recovered ?? {
              ...presentationRef.current,
              path: null,
              activeThreadId: null,
              discussionsVisible: false,
              scrollTop: 0,
            };
            setActiveThreadId(null);
            setDiscussionsVisible(false);
            setStatus("Document missing · choose another document");
            setError(
              `${requestedPath.replaceAll("\\", "/")} is no longer in this workspace. Choose another document to continue; the unsaved draft for that file is retained and restored if it returns.`,
            );
            return;
          }
          setError(String(cause));
        });
    }
    return () => {
      live = false;
      releaseThreads?.();
      threadStoreRef.current = null;
    };
  }, [documents, storageKey, workspacePath, initialPath, autoOpenLastDocument]);
  function persist(next: SpecThread[]) {
    // Storage failure prevents uplink; an untracked native session is not silently created.
    if (!threadStoreRef.current || !discussionWriter.canWrite())
      throw new Error("Exclusive document discussion control is unavailable.");
    threadStoreRef.current.update(() => next);
  }
  function updateThread(next: SpecThread) {
    // Command acknowledgements may finish after the user has changed the composer draft.
    if (discussionWriter.canWrite())
      threadStoreRef.current?.update((current) =>
        mergeSpecThreadUpdate(current, next),
      );
  }
  function updateQuestionDraft(
    threadId: string,
    questionDraft: string,
    expected?: string,
  ) {
    if (discussionWriter.canWrite())
      threadStoreRef.current?.update((current) =>
        changeSpecQuestionDraft(current, threadId, questionDraft, expected),
      );
  }
  async function open(path: string) {
    if (!documents || !path || ioPending) return;
    if (discussionPopout.popped && document?.path !== path) {
      setError("Сначала верните обсуждение в приложение, затем смените документ в этой вкладке. Другой документ можно открыть в новой вкладке.");
      return;
    }
    // Bug 修复（U-11 活体回归 2026-10-14）：原先缓冲区一旦有未保存修改（dirty）就静默
    // return，选择器又把 value 弹回旧路径——用户看到“换文件毫无反应，永远只开着第一个
    // 文件”。根因不是 21221728 的 value/option 路径不匹配（list/read 都返回同一套相对
    // POSIX 路径），而是 open() 的 dirty 守卫把按 path 无损切换的设计（per-path 草稿）
    // 整个短路了。修复：换文件前先把脏缓冲连同原始 hash 持久化到 per-path 草稿槽，
    // 只有持久化失败（存储不可用）才阻止切换并给出原因；之后照常读取新文件。
    if (document && dirty) {
      const retained = writeDocumentDraft(
        presentationKey,
        document.path,
        { content: draft, baseSha256: baseSha256Ref.current },
        undefined,
        paneWriteToken,
      );
      if (!retained) {
        setError(
          "The unsaved document draft could not be retained. Save it before switching documents.",
        );
        return;
      }
    }
    setIoPending(true);
    setError("");
    try {
      const next = await documents.read({ path });
      presentationRef.current = {
        ...presentationRef.current,
        path: next.path,
        scrollTop: 0,
      };
      install(next);
      setSelection(null);
      setActiveThreadId(null);
      // U-12：tab 内切换文档后回填 tab 身份（标题=文件名、sourceKey=该文件稳定 key）。
      notifyDocumentOpen(next.path);
      const restored = restoreDocumentDraft(
        next,
        readDocumentDraft(presentationKey, next.path),
      );
      draftRef.current = restored.content;
      setDraft(restored.content);
      baseSha256Ref.current = restored.baseSha256;
      setBaseSha256(restored.baseSha256);
      setStatus(
        restored.content !== next.content
          ? "Unsaved draft restored"
          : "Saved on disk",
      );
      if (restored.conflict)
        setError(
          "Document changed on disk while closed. Your unsaved draft is retained; Save checks its original hash. Reload discards the draft and uses current disk content.",
        );
    } catch (cause) {
      setError(String(cause));
    } finally {
      setIoPending(false);
    }
  }
  async function save() {
    if (!documents || !document || !writable || writers || !dirty || ioPending)
      return;
    setIoPending(true);
    setError("");
    setStatus("Saving…");
    try {
      const next = await documents.save({
        path: document.path,
        content: draft,
        expectedSha256: baseSha256Ref.current,
      });
      install(next);
      setSelection(null);
      setStatus("Saved on disk");
      setError("");
    } catch (cause) {
      setStatus("Save failed · draft retained");
      setError(String(cause));
    } finally {
      setIoPending(false);
    }
  }
  async function reload() {
    if (!documents || !document || ioPending) return;
    setIoPending(true);
    setError("");
    try {
      const next = await documents.read({ path: document.path });
      install(next);
      setSelection(null);
      setStatus("Reloaded from disk");
    } catch (cause) {
      setError(String(cause));
    } finally {
      setIoPending(false);
    }
  }
  // U-14（活体反馈 2026-10-14 «корзина в пикере не удаляет——тихий no-op»）：
  // 根因是删除链路整段缺失（服务无 remove、UI 无处理器），用户的删除意图只能
  // 落空。修复后的语义：服务真实 unlink（同一写许可/写队列），删除后刷新列表；
  // 删的是当前文档时清空打开态与持久化 path（watcher 随 document?.path 变化自动
  // 释放）；该文件的 per-path 草稿槽一并清除（用户主动删除，不适用 D-01 的
  // “文件回来恢复草稿”语义）；成功有可见确认（状态行），失败有可见错误（alert）。
  // 未获写许可（writable=false）时入口禁用并解释原因，不会走到这里。
  async function removeDocument(path: string) {
    if (!documents || !path || ioPending || !writable) return;
    setIoPending(true);
    setError("");
    try {
      await documents.remove({ path });
      writeDocumentDraft(presentationKey, path, null, undefined, paneWriteToken);
      const next = await documents.list();
      setFiles(next);
      if (documentRef.current?.path === path) {
        documentRef.current = null;
        draftRef.current = "";
        setDocument(null);
        setDraft("");
        baseSha256Ref.current = "";
        setBaseSha256("");
        presentationRef.current = {
          ...presentationRef.current,
          path: null,
          scrollTop: 0,
          activeThreadId: null,
          discussionsVisible: false,
        };
        persistPresentation();
        setActiveThreadId(null);
        setDiscussionsVisible(false);
        setSelection(null);
      }
      setStatus(`Deleted ${path} from disk`);
    } catch (cause) {
      setStatus("Delete failed · nothing was removed");
      setError(String(cause));
    } finally {
      setIoPending(false);
    }
  }
  function select(event: SyntheticEvent<HTMLTextAreaElement>) {
    const target = event.currentTarget;
    if (!document || dirty || target.selectionEnd <= target.selectionStart) {
      setSelection(null);
      return;
    }
    const start = target.selectionStart;
    const end = target.selectionEnd;
    setSelection({
      start,
      quote: draft.slice(start, end),
      prefix: draft.slice(Math.max(0, start - 120), start),
      suffix: draft.slice(end, end + 120),
      sha256: document.sha256,
    });
  }
  function discuss(anchor = selection, questionDraft?: string) {
    if (
      !document ||
      !anchor ||
      !parentSessionId ||
      dirty ||
      !bindingReady ||
      !discussionWriter.writable
    )
      return;
    try {
      const thread: SpecThread = {
        id: uuidv7(),
        documentPath: document.path,
        parentSessionId,
        anchor,
        ...(questionDraft ? { questionDraft } : {}),
      };
      persist([...threadsRef.current, thread]);
      setActiveThreadId(thread.id);
      setDiscussionsVisible(true);
    } catch (cause) {
      setError(String(cause));
    }
  }
  const documentThreads = threads.filter(
    (thread) => thread.documentPath === document?.path,
  );
  const activeThread = documentThreads.find(
    (thread) => thread.id === activeThreadId,
  );
  useEffect(() => {
    let live = true;
    const activate = (event: Event) => {
      const request = (event as CustomEvent<ManagedNativeDiscussionOpenRequest>)
        .detail;
      if (
        !request ||
        (request.workspaceIdentity?.trim() || request.workspacePath) !==
          (workspaceIdentity?.trim() || workspacePath) ||
        !threadsRef.current.some(
          (thread) =>
            thread.id === request.threadId &&
            thread.documentPath === request.documentPath,
        )
      )
        return;
      if (request.documentPath === documentRef.current?.path) {
        setActiveThreadId(request.threadId);
        setDiscussionsVisible(true);
        onActivateRef.current?.();
        return;
      }
      if (!documents || ioPendingRef.current) return;
      const previous = documentRef.current;
      if (
        previous &&
        draftRef.current !== previous.content &&
        !writeDocumentDraft(
          presentationKey,
          previous.path,
          {
            content: draftRef.current,
            baseSha256: baseSha256Ref.current,
          },
          undefined,
          paneWriteToken,
        )
      ) {
        setError(
          "The unsaved document draft could not be retained. Save it before opening another discussion.",
        );
        return;
      }
      setIoPending(true);
      setError("");
      onActivateRef.current?.();
      void documents
        .read({ path: request.documentPath })
        .then((next) => {
          if (!live) return;
          const restored = restoreDocumentDraft(
            next,
            readDocumentDraft(presentationKey, next.path),
          );
          presentationRef.current = {
            ...presentationRef.current,
            path: next.path,
            scrollTop: 0,
          };
          install(next);
          // U-12：原生讨论把面板切到目标文档，同样回填 tab 身份。
          notifyDocumentOpen(next.path);
          draftRef.current = restored.content;
          setDraft(restored.content);
          baseSha256Ref.current = restored.baseSha256;
          setBaseSha256(restored.baseSha256);
          setActiveThreadId(request.threadId);
          setDiscussionsVisible(true);
          setStatus(
            restored.content !== next.content
              ? "Unsaved draft restored"
              : "Saved on disk",
          );
          if (restored.conflict)
            setError(
              "Document changed on disk while closed. Your unsaved draft is retained; Save checks its original hash. Reload discards the draft and uses current disk content.",
            );
        })
        .catch((cause) => {
          if (live) setError(String(cause));
        })
        .finally(() => {
          if (live) setIoPending(false);
        });
    };
    window.addEventListener(MANAGED_NATIVE_DISCUSSION_OPEN_EVENT, activate);
    return () => {
      live = false;
      window.removeEventListener(
        MANAGED_NATIVE_DISCUSSION_OPEN_EVENT,
        activate,
      );
    };
  }, [documents, workspaceIdentity, workspacePath, presentationKey]);
  useEffect(() => {
    if (
      bindingReady &&
      activeThreadId &&
      !threads.some((thread) => thread.id === activeThreadId)
    ) {
      setActiveThreadId(null);
      setDiscussionsVisible(false);
    }
  }, [bindingReady, activeThreadId, threads]);
  const nativeSource = useMemo<CodeViewerSource | null>(
    () =>
      document
        ? {
            type: "text",
            title: document.path.split("/").at(-1) || document.path,
            path: `${workspacePath.replaceAll("\\", "/").replace(/\/$/, "")}/${document.path}`,
            content: draft,
            language: inferCodeLanguage(document.path, draft),
            workspacePath,
            ...(workspaceIdentity ? { workspaceIdentity } : {}),
          }
        : null,
    [document?.path, draft, workspacePath, workspaceIdentity],
  );
  // U-08：.txt 是一等文档（服务端已列出；文件链接路由已覆盖 txt），只读视图按正文渲染。
  const isPlainProseDocument = Boolean(
    document && document.path.toLowerCase().endsWith(".txt"),
  );
  // U-06：讨论可“вынести в окно”——Document PiP 真 OS 窗口（自动置顶、可拖到其它显示器），
  // 同一棵 React 子树经稳定 portal host 移入 PiP 文档，会话/线程/草稿不丢；共享槽位
  // （U-07：聊天弹出时这里自动回位）。API 不可用时按钮为 absent-with-reason 禁用态，
  // 面板内浮动（discussionMode === floating）保持原样。
  const discussionPopout = useSpecPopoutRegion({
    regionId: "spec-discussion",
    workspaceKey: workspaceIdentity?.trim() || workspacePath,
    title: "Дискуссия документа",
    enabled: Boolean(document) && discussionsVisible,
  });
  return (
    <div
      className="flex h-full min-h-0 flex-col bg-background text-foreground"
      data-spec-document-pane
    >
      {/* Bug 修复（D-03/D-05 活体反馈 2026-10-13）：选择器之前只在 !document 时渲染，
          文档打开后无法 перевыбрать/切换。现在始终显示并选中当前路径；草稿按
          workspace+path 持久化，切换无损；仅 I/O 进行中或列表为空时禁用。 */}
      {/* Bug 修复（D-03/D-05 活体反馈 2026-10-13）：选择器之前只在 !document 时渲染，
          文档打开后无法 перевыбрать/切换。现在始终显示并选中当前路径；草稿按
          workspace+path 持久化，切换无损；仅 I/O 进行中或列表为空时禁用。
          U-08（2026-10-14）：原生 select 升级为可搜索 combobox（内联过滤 + 键盘优先 +
          双击直接打开，见 specDocumentPicker.tsx）；.txt 与 .md 同列一等工作区文档。 */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        {/* U-13：root 只用于展示归一（剥离绝对前缀）；打开仍走服务相对路径。
            修复：这条注释原先误写在 JSX 属性位（属性列表中不接受块注释表达式），
            属语法错误；移到元素上方，U-13 的 workspaceRoot 接线保持不变。 */}
        <SpecDocumentPicker
          files={files}
          value={document?.path ?? null}
          workspaceRoot={workspacePath}
          disabled={ioPending || !files.length}
          onOpen={(path) => void open(path)}
          onDelete={(path) => void removeDocument(path)}
          deleteDisabled={!writable || ioPending}
          deleteDisabledReason={
            !writable
              ? "Deleting is not available in this experimental build yet."
              : "A document operation is in progress…"
          }
        />
        {document && projectMetadataService ? (
          <ArtifactMetadataControls
            key={`${workspacePath}:${document.path}`}
            workspacePath={workspacePath}
            path={document.path}
            disabled={ioPending}
          />
        ) : null}
      </div>
      {error ? (
        <div
          role="alert"
          className="border-b border-border px-3 py-2 text-ui-sm text-destructive"
        >
          {error}
        </div>
      ) : null}
      <div
        ref={discussionContainerRef}
        className={
          discussionMode === "docked" &&
          discussionsVisible &&
          dockedLayout.stacked
            ? "relative flex min-h-0 flex-1 flex-col overflow-y-auto"
            : "relative flex min-h-0 flex-1"
        }
      >
        <div
          ref={contentRef}
          onScrollCapture={captureScroll}
          className="relative flex min-w-0 flex-1 flex-col"
          style={
            discussionMode === "docked" &&
            discussionsVisible &&
            dockedLayout.stacked
              ? { minHeight: MIN_DOCUMENT_HEIGHT }
              : undefined
          }
        >
          {editing ? (
            <div className="flex items-center justify-end gap-2 border-b border-border px-3 py-1">
              <Button
                variant="ghost"
                size="sm"
                disabled={
                  !selection ||
                  dirty ||
                  !parentSessionId ||
                  !bindingReady ||
                  !discussionWriter.writable
                }
                onClick={() => discuss()}
              >
                Discuss selection
              </Button>
            </div>
          ) : null}
          {nativeSource ? (
            /* Bug 修复（U-10 活体回归 2026-10-14）：PreviewPane 内部把 markdownViewMode
               锁在 "code"（编辑时强制 code、恢复编辑器在场，PreviewPane.tsx 的
               `if (sourceEditor) setMarkdownViewMode("code")`），退出编辑后没有任何路径把它
               复位回 "preview"，且 preserveDocumentViewState 对同一 source 身份直接早退——
               结果 Edit↔View 反复切换后“眼睛”仍显示源码，看起来渲染坏掉/模式消失，只有
               关闭文档 tab 重开（PreviewPane 卸载重建）才恢复。PreviewPane.tsx 不在本次
               独占路径内，故在调用方修复：按编辑模式 key 化，每次模式切换都挂载新的
               PreviewPane，其内部 markdownViewMode 重新按 source 初始化（md → preview），
               查看模式恢复为渲染视图。模式切换本来就整体换内容树，重挂成本与原先一致。 */
            <PreviewPane
              key={editing ? "document-edit" : "document-view"}
              source={nativeSource}
              onClose={() => {
                if (discussionPopout.popped) {
                  setError("Сначала верните обсуждение в приложение, затем закройте документ.");
                  return;
                }
                onClose();
              }}
              workspacePath={workspacePath}
              documentContentBasePath={nativeSource.path
                ?.replaceAll("\\", "/")
                .split("/")
                .slice(0, -1)
                .join("/")}
              onOpenBrowserUrl={onOpenBrowserUrl}
              onOpenCodeViewer={onOpenCodeViewer}
              preserveDocumentViewState
              documentActions={
                <>
                  {/* U-04：旧的 ⤢ 文档展开/还原聊天按钮已并入 tabs 容器 caption 的
                      角色开关（workspacePanelRoles.ts）——聊天显隐不再是文档头的
                      位置相关控制，恢复入口在 swap 两种排列下都可用（U-05）。 */}
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    title="Discussions"
                    aria-label="Discussions"
                    aria-pressed={discussionsVisible}
                    onClick={() => setDiscussionsVisible(!discussionsVisible)}
                  >
                    <MessageSquare />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    title={editing ? "View" : "Edit"}
                    aria-label={editing ? "View" : "Edit"}
                    disabled={ioPending}
                    onClick={() => setEditing(!editing)}
                  >
                    {editing ? <Eye /> : <Pencil />}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Reload"
                    disabled={ioPending}
                    onClick={() => void reload()}
                    title="Discard draft and reload file"
                  >
                    <RotateCcw />
                  </Button>
                  <Button
                    variant="outline"
                    size="icon-sm"
                    title="Save"
                    aria-label="Save"
                    disabled={!writable || !dirty || writers || ioPending}
                    onClick={() => void save()}
                  >
                    <Save />
                  </Button>
                </>
              }
              onDocumentComment={
                !dirty &&
                parentSessionId &&
                bindingReady &&
                discussionWriter.writable
                  ? ({ selectedText, comment, range }) => {
                      const lines = draft.split("\n");
                      const start =
                        lines
                          .slice(0, Math.max(0, range.startLine - 1))
                          .join("\n").length + (range.startLine > 1 ? 1 : 0);
                      discuss(
                        {
                          start,
                          quote: selectedText,
                          prefix: draft.slice(Math.max(0, start - 120), start),
                          suffix: draft.slice(
                            start + selectedText.length,
                            start + selectedText.length + 120,
                          ),
                          sha256: document!.sha256,
                        },
                        comment,
                      );
                    }
                  : undefined
              }
              markdownSelectionTarget={{
                sessionId: parentSessionId,
                workspaceKey: workspaceIdentity?.trim() || workspacePath,
              }}
              onDiscussFragment={
                !dirty &&
                parentSessionId &&
                bindingReady &&
                discussionWriter.writable
                  ? (quote) => {
                      const first = draft.indexOf(quote);
                      const unique =
                        first >= 0 && draft.indexOf(quote, first + 1) < 0;
                      const start = unique ? first : -1;
                      discuss({
                        start,
                        quote,
                        prefix: unique
                          ? draft.slice(Math.max(0, start - 120), start)
                          : "",
                        suffix: unique
                          ? draft.slice(
                              start + quote.length,
                              start + quote.length + 120,
                            )
                          : "",
                        sha256: document!.sha256,
                      });
                    }
                  : undefined
              }
              sourceEditor={
                editing ? (
                  <textarea
                    ref={editorRef}
                    value={draft}
                    disabled={ioPending}
                    onChange={(event) => {
                      const content = event.target.value;
                      draftRef.current = content;
                      setDraft(content);
                      setSelection(null);
                      if (
                        !writeDocumentDraft(
                          presentationKey,
                          document!.path,
                          content !== document!.content
                            ? { content, baseSha256: baseSha256Ref.current }
                            : null,
                          undefined,
                          paneWriteToken,
                        )
                      ) {
                        setError(
                          "The unsaved document draft could not be retained for reopening. Keep this pane open until saved.",
                        );
                      }
                    }}
                    onSelect={select}
                    spellCheck={false}
                    // U-09：textarea 默认 soft wrap——长行按面板宽度换行，散文无横向滚动。
                    aria-label="Document source editor"
                    className="h-full min-h-0 w-full resize-none bg-background p-4 font-mono text-ui-base leading-relaxed outline-none"
                  />
                ) : isPlainProseDocument ? (
                  /* U-08/U-09：txt 是一等文档——只读视图不再走代码查看器（行号/默认不换行/
                     横向滚动），改由面板自带正文视图：whitespace-pre-wrap + break-words 让
                     长行按面板宽度换行，无横向滚动条；经 PreviewPane 的 sourceEditor 内容槽
                     传入（对非 markdown source 该槽就是整块内容覆盖位）。 */
                  <div
                    data-document-prose=""
                    className="h-full min-h-0 w-full overflow-y-auto p-4 font-mono text-ui-base leading-relaxed whitespace-pre-wrap break-words"
                  >
                    {draft}
                  </div>
                ) : undefined
              }
            />
          ) : (
            <p className="p-4 text-ui-sm text-foreground-subtle">
              {files.length
                ? "Choose a project document above to preview it."
                : "No documents found in this workspace."}
            </p>
          )}
          {document && draft.length === 0 && !editing ? (
            <p className="pointer-events-none absolute left-0 right-0 top-10 p-4 text-ui-sm text-foreground-subtle">
              {document.path.split("/").at(-1)} is empty.
            </p>
          ) : null}
        </div>
        {document ? (
          /* U-06：锚点未弹出时 display:contents——aside 直接参与父级 flex 布局（停靠/
             浮动几何不变）；弹出后锚点变成原位占位（说明 + «вернуть»），aside 子树整体
             移入 PiP 文档。 */
          <div
            ref={discussionPopout.anchorRef}
            className={
              discussionPopout.popped
                ? "relative flex min-h-0 shrink-0 flex-col items-center justify-center gap-2 border-l border-border bg-background p-3"
                : "contents"
            }
          >
            {discussionPopout.popped ? (
              <>
                <p className="text-center text-ui-xs text-foreground-subtle">
                  Дискуссия открыта в отдельном окне.
                </p>
                <SpecPopoutIconButton
                  region={discussionPopout}
                  popLabel="Вынести дискуссию в окно"
                  restoreLabel="Вернуть дискуссию"
                />
              </>
            ) : null}
            <SpecPopoutRegionPortal
              region={discussionPopout}
              title="Дискуссия документа"
            >
              <aside
                data-discussion-mode={discussionMode}
                className={
                  /* 弹出态：aside 铺满 PiP 内层容器（头部下方的剩余空间）——停靠/浮动的
                     px 尺寸与 absolute 定位只在面板内有意义，带进 PiP 会留下固定宽度
                     的窄条。仅切换 className/style（不换结构），不触发子树重挂。 */
                  discussionPopout.popped
                    ? "flex h-full min-h-0 w-full flex-col overflow-hidden"
                    : discussionsVisible
                      ? discussionMode === "floating"
                        ? "absolute z-20 flex min-h-0 flex-col overflow-auto rounded-2xl border border-border bg-popover shadow-xl"
                        : "relative flex min-h-0 shrink-0 flex-col border-l border-border bg-background"
                      : "hidden"
                }
                aria-label="Fragment discussions"
                style={
                  discussionPopout.popped
                    ? undefined
                    : discussionMode === "floating"
                      ? {
                          left: discussionRect.x,
                          top: discussionRect.y,
                          width: discussionRect.width,
                          height: discussionRect.height,
                        }
                      : { width: dockedLayout.width, height: dockedLayout.height }
                }
                onKeyDown={(event) => {
                  if (
                    event.key === "Escape" &&
                    !event.defaultPrevented &&
                    !(
                      event.target instanceof Element &&
                      event.target.closest('[role="dialog"]')
                    )
                  )
                    event.stopPropagation();
                }}
              >
            {!discussionPopout.popped && discussionMode === "docked" && !dockedLayout.stacked ? (
              <button
                type="button"
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize discussion panel"
                aria-valuenow={Math.round(dockedLayout.width)}
                title="Resize discussion · arrow keys"
                className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize touch-none outline-none focus:bg-primary/20 hover:bg-primary/10"
                onPointerDown={(event) =>
                  startDiscussionGesture(event, "resize-docked")
                }
                onPointerMove={moveDiscussionGesture}
                onPointerUp={() => finishDiscussionGesture()}
                onPointerCancel={() => finishDiscussionGesture(true)}
                onLostPointerCapture={() => finishDiscussionGesture(true)}
                onKeyDown={(event) =>
                  keyboardDiscussion(event, "resize-docked")
                }
              />
            ) : null}
            <div
              className="flex shrink-0 items-center gap-1 border-b border-border p-2"
              style={
                !discussionPopout.popped && discussionMode === "floating"
                  ? { minWidth: MIN_DISCUSSION_WIDTH }
                  : undefined
              }
            >
              {!discussionPopout.popped && discussionMode === "floating" ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Move discussion"
                  title="Move discussion · arrow keys"
                  className="cursor-move touch-none"
                  onPointerDown={(event) =>
                    startDiscussionGesture(event, "move")
                  }
                  onPointerMove={moveDiscussionGesture}
                  onPointerUp={() => finishDiscussionGesture()}
                  onPointerCancel={() => finishDiscussionGesture(true)}
                  onLostPointerCapture={() => finishDiscussionGesture(true)}
                  onKeyDown={(event) => keyboardDiscussion(event, "move")}
                >
                  <GripHorizontal />
                </Button>
              ) : null}
              <select
                aria-label="Fragment discussion"
                value={activeThreadId || ""}
                className="min-w-0 flex-1 rounded-md border border-input-border bg-background px-2 py-1 text-ui-sm"
                onChange={(event) => setActiveThreadId(event.target.value)}
              >
                <option value="">Discussions ({documentThreads.length})</option>
                {documentThreads.map((thread, index) => (
                  <option key={thread.id} value={thread.id}>
                    {index + 1}. {thread.anchor.quote.slice(0, 45)} ·{" "}
                    {thread.pending
                      ? "command pending"
                      : thread.sessionId
                        ? writeGuard.phases[thread.sessionId] || "connecting"
                        : "new"}
                  </option>
                ))}
              </select>
              <SpecPopoutIconButton
                region={discussionPopout}
                popLabel="Вынести дискуссию в окно"
                restoreLabel="Вернуть дискуссию"
                popIcon={nativeDiscussionWindows ? <Maximize2 /> : undefined}
              />
              {/* 修复原因：桌面原先相邻的“放大”只开文档内浮层，用户无法移到桌面。
                  桌面只保留一个放大入口，直达原生窗口；Web 仍保留内部浮动布局。 */}
              {!nativeDiscussionWindows && !discussionPopout.popped ? <Button
                variant="ghost"
                size="icon-sm"
                aria-label={
                  discussionMode === "floating"
                    ? "Dock discussion"
                    : "Float discussion"
                }
                title={
                  discussionMode === "floating"
                    ? "Dock discussion"
                    : "Float discussion within this window"
                }
                onClick={() => {
                  finishDiscussionGesture(true);
                  setDiscussionMode(
                    discussionMode === "floating" ? "docked" : "floating",
                  );
                }}
              >
                {discussionMode === "floating" ? <Minimize2 /> : <Maximize2 />}
              </Button> : null}
              <Button
                variant="ghost"
                size="sm"
                aria-label="Hide discussions"
                onClick={() => {
                  if (discussionPopout.popped) discussionPopout.close();
                  setDiscussionsVisible(false);
                }}
              >
                ×
              </Button>
            </div>
            {discussionWriter.writable ? (
              documentThreads.map((thread) => (
                <div
                  key={thread.id}
                  className={
                    thread.id === activeThreadId
                      ? "flex min-h-0 flex-1 flex-col"
                      : "hidden"
                  }
                  style={
                    !discussionPopout.popped && discussionMode === "floating"
                      ? {
                          minWidth: MIN_DISCUSSION_WIDTH,
                          minHeight: MIN_DISCUSSION_HEIGHT,
                          flexShrink: 0,
                        }
                      : undefined
                  }
                >
                  <SpecDiscussionPane
                    thread={thread}
                    update={updateThread}
                    updateQuestionDraft={updateQuestionDraft}
                    workspacePath={workspacePath}
                    workspaceIdentity={workspaceIdentity}
                    visible={
                      /* Wave A × U-06 集成（评审 #2 修复）：活跃线程判定保持在 popped OR
                         之外——弹出为 PiP 窗口时也只有当前展示的线程 visible，非活跃
                         线程的包装仍是 hidden（presentation/telemetry/问答门/
                         native prepare 都不得为不可见线程开启，含未发送草稿线程）。
                         停靠时表达式与集成前逐字节一致。 */
                      (discussionPopout.popped ||
                        (visible && discussionsVisible)) &&
                        thread.id === activeThreadId
                    }
                    onOpenBrowserUrl={onOpenBrowserUrl}
                    onOpenCodeViewer={onOpenCodeViewer}
                    onActivate={() => {
                      setActiveThreadId(thread.id);
                      setDiscussionsVisible(true);
                      onActivate?.();
                    }}
                    anchorCurrent={
                      document.sha256 === thread.anchor.sha256 &&
                      draft.slice(
                        thread.anchor.start,
                        thread.anchor.start + thread.anchor.quote.length,
                      ) === thread.anchor.quote
                    }
                  />
                </div>
              ))
            ) : (
              <p
                role="status"
                className="p-3 text-ui-sm text-foreground-subtle"
              >
                {discussionWriter.phase === "busy"
                  ? "Document discussions are controlled in another window. This document remains available to read."
                  : discussionWriter.phase === "checking"
                    ? "Checking exclusive document discussion control…"
                    : "Exclusive document discussion control is unavailable in this window. This document remains available to read."}
              </p>
            )}
            {discussionWriter.writable && !activeThread ? (
              <p className="p-3 text-ui-sm text-foreground-subtle">
                Select saved document text and choose Discuss selection.
              </p>
            ) : null}
            {!discussionPopout.popped && (discussionMode === "floating" || dockedLayout.stacked) ? (
              <button
                type="button"
                aria-label="Resize discussion"
                title="Resize discussion · arrow keys"
                className="absolute bottom-0 right-0 z-20 size-5 cursor-se-resize touch-none rounded-br-xl text-foreground-subtle outline-none focus:bg-primary/20"
                onPointerDown={(event) =>
                  startDiscussionGesture(event, "resize-floating")
                }
                onPointerMove={moveDiscussionGesture}
                onPointerUp={() => finishDiscussionGesture()}
                onPointerCancel={() => finishDiscussionGesture(true)}
                onLostPointerCapture={() => finishDiscussionGesture(true)}
                onKeyDown={(event) =>
                  keyboardDiscussion(event, "resize-floating")
                }
              >
                <Maximize2 className="size-3" />
              </button>
            ) : null}
              </aside>
            </SpecPopoutRegionPortal>
          </div>
        ) : null}
      </div>
      <div className="space-y-1 border-t border-border px-3 py-2 text-ui-xs text-foreground-subtle">
        <p>{dirty ? "Unsaved draft" : status}</p>
        {!writable && document ? (
          <p>Saving and deleting are not available in this experimental build yet.</p>
        ) : null}
        {!parentSessionId && document ? (
          <p role={executionSource?.phase === "error" ? "alert" : "status"}>
            {executionSource?.error ||
              "Preparing the native ZCODE model for fragment discussions…"}
          </p>
        ) : null}
        {writable && writers ? (
          <p>Save waits for active conversations to finish.</p>
        ) : null}
      </div>
    </div>
  );
}

export function SpecDocumentPane(props: SpecDocumentPaneProps) {
  const scope = useMemo(
    () => ({
      workspacePath: props.workspacePath,
      ...(props.workspaceIdentity
        ? { workspaceIdentity: props.workspaceIdentity }
        : {}),
    }),
    [props.workspacePath, props.workspaceIdentity],
  );
  return (
    <V4PaneConversationProvider scope={scope}>
      <Documents
        /* U-12 多开：key 优先用宿主提供的 tab 实例身份（tab id）——tab 内切换文档会
           更新 initialPath（宿主回填绑定路径），按 initialPath 键控会把刚选完文档的面板
           整个重挂（闪烁 + 重复 IO）。无宿主身份时回退旧的单实例键控。 */
        key={`${props.workspaceIdentity || props.workspacePath}:${props.instanceKey ?? props.initialPath ?? "launcher"}`}
        {...props}
      />
    </V4PaneConversationProvider>
  );
}
