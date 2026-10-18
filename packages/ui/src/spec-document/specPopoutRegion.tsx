import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { Ban, CircleAlert, PictureInPicture2, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { PortalHostContext } from "@/components/ui/portal-host.js";
import { movePresentationHost } from "@/lib/presentationDocumentMove.js";
import { PresentationHostDocumentContext } from "@/v4/usePresentationVisibility.js";
import { readPopoutOpenIntent, writePopoutOpenIntent } from "./popoutOpenIntent.js";
import {
  adoptSpecPopoutStyles,
  forceReturnSpecPopoutOwner,
  readSpecPopoutApi,
  readSpecPopoutAvailability,
  readSpecPopoutSize,
  registerSpecPopoutForcedReturn,
  specPopoutSizeKey,
  writeSpecPopoutSize,
  type SpecPopoutAvailability,
  type SpecPopoutWindow,
} from "./specPopoutWindow.js";

/**
 * U-06/U-07：一个区域的“弹出为 OS 窗口”接线（React 侧）。
 *
 * 状态保活的关键：区域的 React 子树永远渲染进同一个稳定 host 节点
 * （createPortal 的目标自创建后不变——React 不会因 portal 换容器而重建子树），
 * 弹出/返回只把这个 host 节点在 主文档锚点 ⇄ PiP document.body 之间移动。
 * DOM 节点跨 document 追加时浏览器按规范自动 adopt；会话/线程/草稿都在同一棵
 * 子树里，天然无损。
 */
export interface SpecPopoutRegion {
  popped: boolean;
  opening: boolean;
  availability: SpecPopoutAvailability;
  lastError: string | null;
  /** 稳定 portal 目标：调用方经 SpecPopoutRegionPortal 渲染子树。
   *  无 DOM 环境（node 侧 renderToStaticMarkup 契约测试）下为 null——portal 组件
   *  退化为原位渲染，弹出请求也会因无 window 而走 absent-with-reason。 */
  hostNode: HTMLDivElement | null;
  /** 主文档锚点：调用方把它渲染在区域原位置（未弹出时 host 就住在这里）。 */
  anchorRef: RefObject<HTMLDivElement | null>;
  open: () => void;
  close: () => void;
  toggle: () => void;
  focus: () => void;
}

/**
 * 宿主节点的布局按“所在位置”切换（评审修复 2026-10-14）：
 * - 面板内（锚点 display:contents 时宿主会成为 flex item）：必须是 display:contents
 *   透传——不能带 w-full/h-full：width:100% 的 flex-basis 会把内容列（flex:1 1 0%）
 *   挤到 0px，文档正文整列消失。透传让区域子树（aside / V4WorkspaceChatArea）按
 *   原布局直接参与锚点的布局上下文，与引入弹窗之前完全一致。
 * - PiP 文档内：占满弹出窗口（body margin 已清零）。
 */
const POPOUT_HOST_PINNED_CLASS = "flex h-full min-h-0 w-full flex-col overflow-hidden bg-background text-foreground";
const POPOUT_HOST_DOCKED_CLASS = "contents";

export function useSpecPopoutRegion(options: {
  regionId: string;
  workspaceKey: string;
  /** PiP 宿主头部标题（弹出窗口内）。 */
  title: string;
  /** false 时（区域本身不可见/不可用）自动返回原位；不会自动打开。 */
  enabled?: boolean;
  /** Restore addressed navigation only on explicit Return / OS close, never teardown. */
  onReturn?: () => void;
  persistenceKey?: string;
  autoRestore?: boolean;
  onPoppedChange?: (popped: boolean) => void;
}): SpecPopoutRegion {
  const { regionId, workspaceKey, enabled = true } = options;
  const platform = useOptionalPlatform();
  const nativeOpen = platform?.openConversationPopout;
  const nativeId = useRef<string>(globalThis.crypto?.randomUUID?.() ?? `surface-${Date.now()}`);
  const disposed = useRef(false);
  const onReturnRef = useRef(options.onReturn);
  onReturnRef.current = options.onReturn;
  const onPoppedChangeRef = useRef(options.onPoppedChange);
  onPoppedChangeRef.current = options.onPoppedChange;
  const ownerClosing = useRef(false);
  useEffect(() => {
    const markClosing = () => { ownerClosing.current = true; };
    window.addEventListener("beforeunload", markClosing);
    window.addEventListener("zcode:conversation-owner-closing", markClosing);
    return () => {
      window.removeEventListener("beforeunload", markClosing);
      window.removeEventListener("zcode:conversation-owner-closing", markClosing);
    };
  }, []);
  const [popped, setPopped] = useState(false);
  const [opening, setOpening] = useState(false);
  const openingRef = useRef(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const availability = useMemo<SpecPopoutAvailability>(
    () => (nativeOpen ? { supported: true } : readSpecPopoutAvailability()),
    [nativeOpen],
  );
  const hostRef = useRef<HTMLDivElement | null>(null);
  if (hostRef.current === null && typeof document !== "undefined") {
    const host = document.createElement("div");
    // 默认在面板内：display:contents 透传（见上方注释），不是 w-full 的填充盒。
    host.className = POPOUT_HOST_DOCKED_CLASS;
    hostRef.current = host;
  }
  const hostNode = hostRef.current;
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const pipRef = useRef<SpecPopoutWindow | null>(null);
  const sizeKey = options.persistenceKey ?? specPopoutSizeKey(regionId, workspaceKey);

  const persistSize = useCallback(() => {
    const pip = pipRef.current;
    if (pip)
      writeSpecPopoutSize(sizeKey, {
        width: pip.innerWidth,
        height: pip.innerHeight,
      });
  }, [sizeKey]);

  const handleClosedRef = useRef<() => void>(() => {});
  // A native child may hide before its opener's beforeunload. Defer only that
  // notification to the opener's next task: explicit child X remains actionable,
  // while reload/quit establishes ownerClosing or destroys the old JS context.
  const handlePageHide = useCallback(() => {
    if (nativeOpen) {
      const source = pipRef.current;
      let checks = 0;
      const confirmClose = () => {
        if (disposed.current || ownerClosing.current || pipRef.current !== source) return;
        // A live named target can hide its previous blank document on reuse;
        // that is navigation, not an explicit OS close. Native closed arrives
        // after pagehide, so give that acknowledgement a bounded interval.
        if (source?.closed === false) {
          if (++checks < 40) window.setTimeout(confirmClose, 50);
          return;
        }
        handleClosedRef.current();
      };
      window.setTimeout(confirmClose, 0);
    }
    else handleClosedRef.current();
  }, [nativeOpen]);
  const handleClosed = useCallback(() => {
    const returningOpenWindow = pipRef.current !== null && !disposed.current && !ownerClosing.current;
    // pagehide（OS 关闭按钮）与主动 close() 都走这里：先记尺寸再回状态。
    persistSize();
    pipRef.current?.removeEventListener("pagehide", handlePageHide);
    pipRef.current = null;
    // 原节点同步归位，避免关闭子文档时 React 效果尚未运行而丢失输入/选区。
    if (hostNode && anchorRef.current) {
      hostNode.className = POPOUT_HOST_DOCKED_CLASS;
      movePresentationHost(hostNode, anchorRef.current, true);
    }
    if (returningOpenWindow) {
      writePopoutOpenIntent(sizeKey, false);
      onPoppedChangeRef.current?.(false);
      onReturnRef.current?.();
    }
    setPopped(false);
  }, [hostNode, persistSize, sizeKey, handlePageHide]);
  handleClosedRef.current = handleClosed;

  const close = useCallback(() => {
    const pip = pipRef.current;
    if (pip) {
      handleClosed();
      try {
        pip.close();
      } catch {
        /* 窗口可能已被 OS 关掉；状态已在 handleClosed 复位。 */
      }
      return;
    }
    setPopped(false);
  }, [handleClosed]);

  const open = useCallback(() => {
    if (pipRef.current || openingRef.current) return;
    const availabilityNow = nativeOpen
      ? { supported: true as const }
      : readSpecPopoutAvailability();
    const api = nativeOpen
      ? {
          requestWindow: (size: { width?: number; height?: number } = {}) =>
            nativeOpen({
              id: options.persistenceKey ?? nativeId.current,
              title: options.title,
              width: size.width ?? 480,
              height: size.height ?? 640,
            }).then((handle) => handle as SpecPopoutWindow),
        }
      : readSpecPopoutApi();
    if (!hostNode || !availabilityNow.supported || !api) {
      setLastError(
        availabilityNow.supported
          ? "The separate window could not be opened."
          : availabilityNow.reason,
      );
      return;
    }
    setLastError(null);
    if (nativeOpen) writePopoutOpenIntent(sizeKey, true);
    // 共享槽位：先让其它区域（若有）自动返回原面板，再申请本 App 唯一的 PiP 窗口。
    if (!nativeOpen) forceReturnSpecPopoutOwner(regionId);
    setOpening(true);
    openingRef.current = true;
    const size = readSpecPopoutSize(sizeKey);
    // 修复原因（活体缺陷 2026-10-14）：requestWindow 在部分运行时（Electron：API 存在
    // 但窗口从不创建，electron/electron#39633）会同步 throw 而不是 reject——原实现直接
    // 调用 `.then` 链，同步异常会让 setOpening(true) 永远收不回，按钮从此永久禁用。
    // 这里把同步调用包进 try/catch，异常与 rejection 走同一条可见错误路径。
    let pipPromise: Promise<SpecPopoutWindow>;
    try {
      pipPromise = api.requestWindow({
        width: size.width,
        height: size.height,
      });
    } catch (cause) {
      setOpening(false);
      openingRef.current = false;
      setLastError(
        cause instanceof Error ? cause.message : "The separate window could not be opened.",
      );
      return;
    }
    pipPromise
      .then((pip) => {
        if (disposed.current) {
          pip.close();
          return;
        }
        if (pipRef.current) {
          // 并发保护：打开期间已被占用（如另一区域刚申请）则立即让位关闭。
          try {
            pip.close();
          } catch {
            /* ignore */
          }
          return;
        }
        // 修复原因（活体缺陷 2026-10-14，Electron 实测）：Electron 对 requestWindow
        // 返回 resolve——给的是一个 0×0 的离屏文档，OS 窗口从不创建。若照常 adopt，
        // 子树会被移进这份不可见文档：面板里内容消失、用户哪里都看不到。真窗口在
        // resolve 时已带请求尺寸，不可能 0×0；命中 0×0 即判为「假窗口」：关掉、
        // 报可见错误、内容留在原面板。
        if (pip.innerWidth <= 0 && pip.innerHeight <= 0) {
          try {
            pip.close();
          } catch {
            /* ignore */
          }
          setLastError(
            "The runtime resolved the window request without creating a window (invisible 0×0 document). Separate windows are not supported here; the region stays in place.",
          );
          return;
        }
        if (!movePresentationHost(hostNode, pip.document.body)) {
          pip.close();
          setLastError("Завершите ввод символа (IME), затем вынесите окно.");
          return;
        }
        pipRef.current = pip;
        pip.addEventListener("pagehide", handlePageHide);
        adoptSpecPopoutStyles(document, pip.document);
        // 进入 PiP 文档才切换为填充布局；面板内保持 contents 透传（见常量注释）。
        hostNode.className = POPOUT_HOST_PINNED_CLASS;
        setPopped(true);
        onPoppedChangeRef.current?.(true);
      })
      .catch((cause: unknown) => {
        setLastError(
          cause instanceof Error ? cause.message : "The separate window could not be opened.",
        );
      })
      .finally(() => { openingRef.current = false; setOpening(false); });
  }, [handleClosed, handlePageHide, hostNode, nativeOpen, opening, options.title, options.persistenceKey, regionId, sizeKey]);

  const focus = useCallback(() => {
    if (pipRef.current) pipRef.current.focus?.();
    else open();
  }, [open]);
  const restoredKey = useRef<string | null>(null);
  useEffect(() => {
    if (!nativeOpen || !options.autoRestore || !enabled || restoredKey.current === sizeKey) return;
    restoredKey.current = sizeKey;
    if (readPopoutOpenIntent(sizeKey)) open();
  }, [enabled, nativeOpen, open, options.autoRestore, sizeKey]);

  const toggle = useCallback(() => {
    if (pipRef.current) close();
    else open();
  }, [close, open]);

  // 强制返回注册：共享槽位被新区域占用时，本区域无条件回位（状态保活，见上）。
  useEffect(
    () => (nativeOpen ? undefined : registerSpecPopoutForcedReturn(regionId, close)),
    [nativeOpen, regionId, close],
  );

  // 未弹出时 host 必须住回主文档锚点（首次挂载与每次返回都经此恢复），并恢复
  // display:contents 透传布局——绝不把 PiP 的填充 class 留在面板布局里。
  useEffect(() => {
    if (popped || !hostNode) return;
    hostNode.className = POPOUT_HOST_DOCKED_CLASS;
    const anchor = anchorRef.current;
    if (anchor && hostNode.parentElement !== anchor) anchor.appendChild(hostNode);
  });

  // 区域不可用（文档关闭/聊天视图切走）时自动返回原位。
  useEffect(() => {
    if (!enabled && pipRef.current && !nativeOpen) close();
  }, [enabled, nativeOpen, close]);

  // 卸载清理：关窗 + 记尺寸；host 节点随之脱离文档。
  useEffect(() => {
    disposed.current = false;
    return () => {
      disposed.current = true;
      if (pipRef.current) {
        const pip = pipRef.current;
        persistSize();
        pipRef.current = null;
        try {
          pip.close();
        } catch {
          /* ignore */
        }
      }
    };
  }, [persistSize]);

  return {
    popped,
    opening,
    availability,
    lastError,
    hostNode,
    anchorRef,
    open,
    close,
    toggle,
    focus,
  };
}

/**
 * «вынести в окно»/«вернуть» 直达图标按钮（U-07：不做分层菜单）。
 * API 不可用时显示明确的 absent-with-reason 禁用态；既有 in-app 浮动不受影响。
 *
 * 修复原因（活体缺陷 2026-10-14）：不可用态原先用原生 disabled——Button 基类带
 * `disabled:pointer-events-none`，原生 disabled 连 title 提示都不显示，用户视角就是
 * 「图标看着正常、点了没反应」的死按钮。现改为仓库既有模式（见 V4ComposerCuaEntry）：
 * `aria-disabled` + 点击短路 + 半透明 + Ban 角标，hover 即见完整原因（title/aria）；
 * 原生 disabled 只保留给瞬时 opening 态。requestWindow 失败（含 Electron 0×0 假窗口
 * 防护）时换 CircleAlert 红色图标，错误文本同样在 title/aria 中可发现。
 */
export function SpecPopoutIconButton({
  region,
  popLabel = "Вынести в окно",
  restoreLabel = "Вернуть",
  popIcon,
}: {
  region: SpecPopoutRegion;
  popLabel?: string;
  restoreLabel?: string;
  popIcon?: ReactNode;
}) {
  const unavailable = !region.availability.supported;
  const label = region.popped ? restoreLabel : popLabel;
  const reason = unavailable
    ? region.availability.supported
      ? undefined
      : region.availability.reason
    : (region.lastError ?? undefined);
  const state = unavailable
    ? "unavailable"
    : region.lastError
      ? "error"
      : region.popped
        ? "popped"
        : "idle";
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      aria-pressed={region.popped}
      // absent-with-reason / 运行时错误走 aria-disabled（可 hover、可聚焦、屏幕阅读器
      // 读出禁用），不用原生 disabled（pointer-events-none 会让 title 原因不可见）。
      aria-disabled={unavailable || Boolean(region.lastError) || undefined}
      title={reason ? `${label} — unavailable: ${reason}` : label}
      disabled={region.opening}
      onClick={region.toggle}
      data-spec-popout-control={region.popped ? "restore" : "pop"}
      data-spec-popout-state={state}
      data-spec-popout-reason={reason ?? undefined}
      className={unavailable || region.lastError ? "relative opacity-50" : "relative"}
    >
      {unavailable ? (
        // 角标式禁用标记：不依赖 hover 也能看出「此运行时不可用」，区别于死按钮。
        <>
          <PictureInPicture2 />
          <Ban
            aria-hidden
            className="absolute right-0.5 bottom-0.5 size-2 text-foreground-subtle"
          />
        </>
      ) : region.lastError ? (
        <CircleAlert className="text-destructive" />
      ) : region.popped ? (
        <Undo2 />
      ) : (
        popIcon ?? <PictureInPicture2 />
      )}
    </Button>
  );
}

/** PiP 宿主头部：弹出窗口内的标题 + «вернуть» 图标（OS 关闭按钮之外的显式返回入口）。 */
export function SpecPopoutHostHeader({
  region,
  title,
}: {
  region: SpecPopoutRegion;
  title: string;
}) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border bg-surface/30 px-2 py-1">
      <span className="min-w-0 flex-1 truncate text-ui-sm text-foreground-subtle">{title}</span>
      <SpecPopoutIconButton region={region} />
    </div>
  );
}

const noopSubscribe = () => () => {};

/**
 * 服务器渲染（renderToStaticMarkup 契约测试）不支持 portal：那里退化为原位渲染。
 * 客户端首帧即走 portal（getSnapshot=false），无二次挂载、无状态丢失。
 */
function useIsServerRender(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => false,
    () => true,
  );
}

/**
 * 弹出区域渲染器：子树永远走同一个 portal（目标 hostNode 不变 → React 不重建）。
 * 外层/内层包装 div 在两种状态下都恒定挂载（只有 className 随 popped 切换——
 * className 变化不重挂子树），因此：
 * - 未弹出：两层都是 display:contents，区域子树按原布局直接参与锚点上下文
 *   （与引入弹窗之前完全一致，零布局变化）；
 * - 已弹出：外层在 PiP 宿主头部下方铺满窗口，内层给子树一个“头部之外的剩余空间”
 *   高度上下文（子树自身的 h-full 百分比据此解析，不会溢出宿主头部）。
 *
 * Presentation visibility 路由（渲染性能 Wave A × U-06/U-07 集成）：弹出时子树实际
 * 挂载在 PiP 文档里，这里向子树声明该文档（PresentationHostDocumentContext）——
 * 会话表面（SessionPane/ConversationTimeline）的文档级可见性/visibilitychange 追平
 * 随之改读 PiP 文档：主文档最小化不冻结 PiP 里仍展示的会话，PiP 最小化则照常冻结。
 * 未弹出时不提供覆盖（值 null = 主文档），行为与集成前一致。
 */
export function SpecPopoutRegionPortal({
  region,
  title,
  children,
}: {
  region: SpecPopoutRegion;
  title: string;
  children: ReactNode;
}) {
  const serverRender = useIsServerRender();
  const hostDocument =
    region.popped && region.hostNode && region.hostNode.ownerDocument !== document
      ? region.hostNode.ownerDocument
      : null;
  // 无 DOM 环境或服务器渲染：退化为原位渲染，不做 portal。
  if (!region.hostNode || serverRender) return <>{children}</>;
  return createPortal(
    <PresentationHostDocumentContext.Provider value={hostDocument}>
      <PortalHostContext.Provider value={hostDocument?.body}>
        <div className={region.popped ? "flex h-full min-h-0 w-full flex-col" : "contents"}>
          {region.popped ? <SpecPopoutHostHeader region={region} title={title} /> : null}
          <div
            className={region.popped ? "flex min-h-0 flex-1 flex-col overflow-hidden" : "contents"}
          >
            {children}
          </div>
        </div>
      </PortalHostContext.Provider>
    </PresentationHostDocumentContext.Provider>,
    region.hostNode,
  );
}
