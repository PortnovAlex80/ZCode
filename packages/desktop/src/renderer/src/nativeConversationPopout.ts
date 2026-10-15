import type { IPlatformService } from "@zcode/shared";

export const openNativeConversationPopout: NonNullable<
  IPlatformService["openConversationPopout"]
> = async ({ id, title, width, height }) => {
  const child = window.open(
    "about:blank",
    `zcode-conversation-${id}`,
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
  child.document.title = `ZCode — ${title}`;
  return child;
};
