export function createPreviewState() {
  return { selected: "", activeId: "document", threads: [], documentMessages: [] };
}
export function addDiscussion(state, id) {
  if (!state.selected.trim()) return false;
  state.threads.push({ id, quote: state.selected, messages: [] });
  state.activeId = id;
  return true;
}
export function deleteDiscussion(state, id) {
  state.threads = state.threads.filter((thread) => thread.id !== id);
  if (state.activeId === id) state.activeId = "document";
}
export function activeMessages(state) {
  return (
    state.threads.find((thread) => thread.id === state.activeId)?.messages ?? state.documentMessages
  );
}
export function sendPreview(state, text) {
  if (!text.trim()) return false;
  const messages = activeMessages(state);
  messages.push({ role: "user", text: text.trim() });
  messages.push({
    role: "assistant",
    text:
      state.activeId === "document"
        ? "Это демонстрационный ответ: здесь будет беседа с агентом о документе. Сейчас запрос остаётся только в этой панели — ZCODE и модель не подключены."
        : "Это демонстрационный ответ в отдельной дискуссии. В будущей интеграции агент получит выбранный фрагмент, без истории общего чата. Сейчас документ не меняется.",
  });
  return true;
}
