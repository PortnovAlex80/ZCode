import type { IPlatformService } from "@zcode/shared";

export async function conversationFrameName(id: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id));
  const token = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  return `zcode-conversation-${token}`;
}

export const setNativeConversationWindowAttachment: NonNullable<
  IPlatformService["setConversationWindowAttachment"]
> = async ({ documentId, conversationId, side }) => {
  const [documentFrame, conversationFrame] = await Promise.all([
    conversationFrameName(documentId),
    conversationId === null ? null : conversationFrameName(conversationId),
  ]);
  return window.zcode.setConversationWindowAttachment?.({ documentFrame, conversationFrame, side })
    ?? { attached: false };
};

export const openNativeConversationPopout: NonNullable<
  IPlatformService["openConversationPopout"]
> = async ({ id, title, width, height }) => {
  // Stable opaque native identity, without exposing project paths in frame names.
  const child = window.open(
    "",
    await conversationFrameName(id),
    `width=${Math.round(width)},height=${Math.round(height)}`,
  );
  if (!child) throw new Error("Не удалось открыть отдельное окно.");
  // Electron creates the real native window before its first layout. Do not
  // mistake that initial 0×0 layout for Document PiP's permanently invisible window.
  const started = performance.now();
  while (!child.closed && (child.innerWidth <= 0 || child.innerHeight <= 0)) {
    if (performance.now() - started > 5000) {
      child.close();
      throw new Error("Окно не готово. Содержимое осталось на месте; попробуйте ещё раз.");
    }
    await new Promise((resolve) => setTimeout(resolve, 16));
  }
  if (child.closed) throw new Error("Окно закрыто до завершения открытия.");
  // An empty URL reuses the named, controlled blank window without navigating
  // it. Navigating a retained target to about:blank can wipe a newly adopted
  // portal and emit pagehide after a reload. Drop the previous renderer's DOM.
  child.document.body.replaceChildren();
  child.document.title = `ZCode — ${title}`;
  return child;
};
