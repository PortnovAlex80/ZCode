import {
  createPreviewState,
  addDiscussion,
  deleteDiscussion,
  activeMessages,
  sendPreview,
} from "./model.js";
import { selectionCommand } from "./commands.js";

const state = createPreviewState();
const $ = (id) => document.getElementById(id);
$("quote").textContent = $("quote").textContent.replace(/\s+/g, " ").trim();
let officeReady = false;
function render() {
  const thread = state.threads.find((item) => item.id === state.activeId);
  $("count").textContent = String(state.threads.length);
  $("document-tab").classList.toggle("active", !thread);
  $("discussion-tab").classList.toggle("active", Boolean(thread));
  $("quote").textContent =
    thread?.quote ||
    state.selected ||
    "Выделите текст в документе слева, затем нажмите «Взять из Word».";
  $("selection-label").textContent = thread ? "Контекст дискуссии" : "Выделенный фрагмент";
  $("context").textContent = thread
    ? "Фрагмент · независимая дискуссия"
    : "Документ · локальный макет";
  $("threads").replaceChildren();
  for (const item of state.threads) {
    const row = document.createElement("div");
    row.className = `thread${item.id === state.activeId ? " active" : ""}`;
    const button = document.createElement("button");
    button.className = "text-ui-caption";
    const excerpt = document.createElement("span");
    excerpt.className = "thread-quote";
    excerpt.textContent = item.quote.replace(/\s+/g, " ");
    const details = document.createElement("span");
    details.className = "thread-details text-ui-sm";
    details.textContent = `${item.messages.length} реплик · отдельная дискуссия`;
    button.append(excerpt, details);
    button.addEventListener("click", () => {
      state.activeId = item.id;
      render();
    });
    const remove = document.createElement("button");
    remove.className = "delete text-ui-base";
    remove.textContent = "×";
    remove.setAttribute("aria-label", "Удалить обсуждение");
    remove.addEventListener("click", () => {
      deleteDiscussion(state, item.id);
      render();
    });
    row.append(button, remove);
    $("threads").append(row);
  }
  const messages = activeMessages(state);
  if (messages.length) {
    $("messages").replaceChildren();
    for (const message of messages) {
      const node = document.createElement("div");
      node.className = `message ${message.role} text-ui-base`;
      if (message.role === "assistant") {
        const label = document.createElement("span");
        label.className = "message-label text-ui-sm";
        label.textContent = "Spec Harness · demo";
        node.append(label);
      }
      node.append(document.createTextNode(message.text));
      $("messages").append(node);
    }
    $("messages").scrollTop = $("messages").scrollHeight;
  } else {
    $("messages").replaceChildren();
    const welcome = document.createElement("p");
    welcome.className = "text-ui-base welcome";
    welcome.textContent = thread
      ? "Фрагмент выбран. Задайте вопрос для отдельного обсуждения."
      : "Задайте вопрос о документе или начните обсуждение выделенного фрагмента.";
    $("messages").append(welcome);
  }
}
async function readSelection(intent = "add") {
  if (!officeReady) {
    $("status").textContent = "Ожидаем готовность Word…";
    return;
  }
  $("read").disabled = true;
  return new Promise((resolve) =>
    Office.context.document.getSelectedDataAsync(Office.CoercionType.Text, (result) => {
      $("read").disabled = false;
      if (result.status !== Office.AsyncResultStatus.Succeeded) {
        $("status").textContent =
          "Word не разрешил чтение выделения. Попробуйте выделить текст ещё раз.";
        resolve(false);
        return;
      }
      state.selected = String(result.value ?? "").slice(0, 20000);
      state.activeId = "document";
      if (intent === "discuss" && state.selected.trim()) {
        addDiscussion(state, crypto.randomUUID());
        $("threads").hidden = false;
      }
      $("status").textContent = state.selected.trim()
        ? "Фрагмент находится только в памяти панели."
        : "Выделите текст в документе и повторите.";
      render();
      resolve(Boolean(state.selected.trim()));
    }),
  );
}
$("read").addEventListener("click", readSelection);
$("add-context").addEventListener("click", readSelection);
$("discuss").addEventListener("click", () => {
  if (!addDiscussion(state, crypto.randomUUID())) {
    $("status").textContent = "Сначала возьмите выделенный фрагмент из Word.";
    return;
  }
  $("threads").hidden = false;
  render();
  $("prompt").focus();
});
$("document-tab").addEventListener("click", () => {
  state.activeId = "document";
  $("threads").hidden = true;
  render();
});
$("discussion-tab").addEventListener("click", () => {
  $("threads").hidden = !$("threads").hidden;
  if (state.threads.length) state.activeId = state.threads.at(-1).id;
  render();
});
$("composer").addEventListener("submit", (event) => {
  event.preventDefault();
  if (sendPreview(state, $("prompt").value)) {
    $("prompt").value = "";
    render();
  }
});
$("prompt").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $("composer").requestSubmit();
  }
});
$("theme").addEventListener("click", () => document.documentElement.classList.toggle("dark"));
document.querySelectorAll("[data-prompt]").forEach((button) =>
  button.addEventListener("click", () => {
    $("prompt").value = button.dataset.prompt;
    $("prompt").focus();
  }),
);
if (typeof Office !== "undefined") {
  Office.onReady((info) => {
    officeReady = info.host === Office.HostType.Word;
    if (officeReady) {
      const showPane = () => Office.addin.showAsTaskpane();
      const reportError = (message) => {
        $("status").textContent = message;
      };
      Office.actions.associate(
        "addSelection",
        selectionCommand(readSelection, showPane, reportError, "add"),
      );
      Office.actions.associate(
        "discussSelection",
        selectionCommand(readSelection, showPane, reportError, "discuss"),
      );
    }
    const officeBackground = Office.context.officeTheme?.bodyBackgroundColor;
    if (/^#[0-9a-f]{6}$/i.test(officeBackground ?? "")) {
      const channels = [1, 3, 5].map((offset) =>
        parseInt(officeBackground.slice(offset, offset + 2), 16),
      );
      const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
      document.documentElement.classList.toggle("dark", luminance < 128);
    }
    $("host").textContent = officeReady ? "Внутри Microsoft Word" : "Preview панели";
    $("status").textContent = officeReady
      ? "Word подключён. Можно взять выделенный текст."
      : "Откройте этот макет как надстройку Word.";
    if (officeReady) void fetch("/ready", { method: "POST" }).catch(() => {});
    const intent = new URLSearchParams(location.search).get("action");
    if (officeReady && (intent === "add" || intent === "discuss")) void readSelection(intent);
  });
}
