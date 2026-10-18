import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link2, Unlink } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  conversationWindowKey,
  useConversationWindows,
} from "./conversationWindows.js";
import {
  documentSurfacePlacementKey,
  initializeDocumentSurfaceIntent,
  registerRetainedDocumentFocus,
  type RetainedDocumentWindow,
} from "./retainedDocumentWindows.js";
import {
  SpecPopoutRegionPortal,
  useSpecPopoutRegion,
} from "./specPopoutRegion.js";
import { readPopoutOpenIntent } from "./popoutOpenIntent.js";

/** One editor owner: only its stable presentation host moves between documents. */
export function DocumentWindowSurface({
  entry,
  visible,
  onRetainedChange,
  onAttachmentChange,
  onActivate,
  children,
}: {
  entry: RetainedDocumentWindow;
  visible: boolean;
  onRetainedChange: (popped: boolean) => void;
  onAttachmentChange: (side: "left" | "right" | undefined) => void;
  onActivate: () => void;
  children: (
    visible: boolean,
    onDiscussionPoppedChange: (popped: boolean) => void,
    activateDocument: () => void,
  ) => ReactNode;
}) {
  const platform = useOptionalPlatform();
  const { intl } = useZCodeIntl();
  const windows = useConversationWindows();
  const documentId = documentSurfacePlacementKey(entry);
  const native = Boolean(platform?.openConversationPopout);
  const [initiallyOpen] = useState(() => {
    if (native) initializeDocumentSurfaceIntent(documentId);
    return native && readPopoutOpenIntent(documentId);
  });
  const openSurfaces = useRef({ document: initiallyOpen, discussion: false });
  const retainedCallback = useRef(onRetainedChange);
  retainedCallback.current = onRetainedChange;
  useEffect(() => {
    // Keep the addressed owner through project navigation while native creation awaits.
    if (initiallyOpen) retainedCallback.current(true);
  }, [initiallyOpen]);
  const updateSurface = (
    surface: "document" | "discussion",
    popped: boolean,
  ) => {
    openSurfaces.current[surface] = popped;
    retainedCallback.current(
      openSurfaces.current.document || openSurfaces.current.discussion,
    );
  };
  const region = useSpecPopoutRegion({
    regionId: `document-${entry.tab.id}`,
    workspaceKey: entry.workspaceIdentity?.trim() || entry.workspacePath,
    persistenceKey: documentId,
    title: entry.tab.source.title || "Open doc",
    autoRestore: native,
    onPoppedChange: (popped) => updateSurface("document", popped),
    onReturn: onActivate,
  });
  useEffect(
    () => registerRetainedDocumentFocus(entry, region.focus, region.popped),
    [entry, region.focus, region.popped],
  );
  const parentKey = conversationWindowKey(entry, entry.parentSessionId ?? "");
  const parent = windows.find(
    (candidate) =>
      conversationWindowKey(candidate.scope, candidate.sessionId) === parentKey,
  );
  const conversationId = parent
    ? `conversation:${parent.placementKey ?? conversationWindowKey(parent.scope, parent.sessionId)}`
    : null;
  const [attachmentError, setAttachmentError] = useState(false);
  useEffect(() => {
    if (!region.popped || !platform?.setConversationWindowAttachment) return;
    let disposed = false;
    setAttachmentError(false);
    void platform
      .setConversationWindowAttachment({
        documentId,
        conversationId: entry.attachmentSide ? conversationId : null,
        side: entry.attachmentSide,
      })
      .then((result) => {
        if (!disposed && entry.attachmentSide && conversationId)
          setAttachmentError(!result.attached);
      })
      .catch(() => {
        if (!disposed) setAttachmentError(true);
      });
    return () => {
      disposed = true;
    };
  }, [
    region.popped,
    platform,
    documentId,
    conversationId,
    entry.attachmentSide,
  ]);
  const label = (id: string, _defaultMessage: string) =>
    intl.formatMessage({ id });
  return (
    <>
      <div
        ref={region.anchorRef}
        className={region.popped ? "hidden" : "contents"}
      />
      {native && region.popped ? (
        <div className="flex items-center gap-2 p-3 text-ui-sm">
          <Button variant="outline" onClick={region.focus}>
            {label("document.window.open", "Show document in separate window")}
          </Button>
        </div>
      ) : null}
      <SpecPopoutRegionPortal
        region={region}
        title={entry.tab.source.title || "Open doc"}
      >
        <div
          className="flex h-full min-h-0 flex-col"
          data-document-window={entry.tab.id}
          data-document-session={entry.parentSessionId ?? ""}
          data-document-workspace={entry.workspacePath}
        >
          {native ? (
            <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1 text-ui-sm">
              {!region.popped ? (
                <Button variant="ghost" size="sm" onClick={region.open}>
                  {label(
                    "document.window.open",
                    "Show document in separate window",
                  )}
                </Button>
              ) : null}
              <Button
                variant="ghost"
                size="sm"
                data-document-link-control={
                  entry.attachmentSide ? "detach" : "attach"
                }
                aria-label={
                  entry.attachmentSide
                    ? label(
                        "document.window.detach",
                        "Detach from conversation",
                      )
                    : label("document.window.attach", "Attach to conversation")
                }
                disabled={
                  !region.popped ||
                  !platform?.setConversationWindowAttachment ||
                  (!entry.attachmentSide && !parent)
                }
                onClick={() =>
                  onAttachmentChange(entry.attachmentSide ? undefined : "right")
                }
              >
                {entry.attachmentSide ? <Unlink /> : <Link2 />}
                {entry.attachmentSide
                  ? label("document.window.detach", "Detach from conversation")
                  : label("document.window.attach", "Attach to conversation")}
              </Button>
              {attachmentError ? (
                <span role="status">
                  {label(
                    "document.window.attachmentUnavailable",
                    "The windows could not be attached. Try again.",
                  )}
                </span>
              ) : null}
              {region.lastError ? (
                <span role="alert">{region.lastError}</span>
              ) : null}
            </div>
          ) : null}
          {children(
            visible || region.popped,
            (popped) => updateSurface("discussion", popped),
            () => (region.popped ? region.focus() : onActivate()),
          )}
        </div>
      </SpecPopoutRegionPortal>
    </>
  );
}
