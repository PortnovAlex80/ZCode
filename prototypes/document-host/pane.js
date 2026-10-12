import { createInteractionRenderer } from "./interactions.js";
import { DocumentSessionClient } from "./client.js";

const $ = (id) => document.getElementById(id);
const display = (value) => (typeof value === "string" ? value : JSON.stringify(value, null, 2));
const node = (tag, text, cls) => {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (cls) element.className = cls;
  return element;
};

export async function mountDocumentPane(adapter, hostName, registerCommands) {
  let selected,
    ids = [],
    mainId,
    scheduled = false,
    busy = false,
    contextPending = false;
  const quotes = new Map();
  let pendingIntent,
    selectionRevision = 0;
  const client = new DocumentSessionClient(adapter, schedule, (error) => report(error));
  $("title").textContent = `ZCODE · ${hostName}`;
  $("host").textContent = `Внутри ${hostName}`;
  $("read").textContent = `Взять из ${hostName}`;
  if (hostName === "Excel") {
    $("document-tab").textContent = "Книга";
    $("selection-label").textContent = "Диапазон";
  }
  if (hostName === "AutoCAD") {
    document.querySelector(".connection-fields > span").textContent =
      "Подключается текущий чертёж. Смена чертежа закрывает связь.";
    $("selection-label").textContent = "Объекты чертежа";
  }
  const read = async (intent) => {
    selected = await adapter.execute("readSelection", {});
    contextPending = true;
    selectionRevision++;
    $("quote").textContent = selected.host === "word" ? selected.data.text : display(selected);
    $("status").textContent = "Выделение прочитано из открытого документа.";
    if (intent === "discuss" && client.connected) await createIndependent();
    else if (intent === "discuss") pendingIntent = "discuss";
    schedule();
    return true;
  };
  const guard = (operation) => async (event) => {
    event?.preventDefault();
    if (busy) return;
    busy = true;
    schedule();
    try {
      await operation(event);
    } catch (error) {
      report(error);
    } finally {
      busy = false;
      schedule();
    }
  };
  const admitNativeCommand = async (intent) => {
    if (busy) throw new Error("Дождитесь завершения текущей операции панели");
    busy = true;
    schedule();
    try {
      return await read(intent);
    } finally {
      busy = false;
      schedule();
    }
  };
  function report(error) {
    $("status").textContent = error instanceof Error ? error.message : String(error);
  }
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      render();
    });
  }
  let uiKey;
  function saveUi() {
    try {
      if (uiKey) localStorage.setItem(uiKey, JSON.stringify({ mainId }));
    } catch {
      /* User preferences may be disabled. */
    }
  }
  async function createIndependent() {
    if (!selected) await read();
    const id = await client.create();
    ids.push(id);
    quotes.set(id, selected);
    $("threads").hidden = false;
    saveUi();
  }
  async function openMain() {
    if (!mainId || !ids.includes(mainId)) {
      mainId = await client.create();
      ids.push(mainId);
      saveUi();
    } else await client.open(mainId);
  }
  $("connect-form").addEventListener(
    "submit",
    guard(async () => {
      ids = await client.connect($("endpoint").value, $("token").value, $("workspace").value);
      const descriptor = await adapter.descriptor();
      $("workspace").value = client.projectPath;
      uiKey = JSON.stringify([
        "document-pane",
        client.projectPath,
        descriptor.host,
        descriptor.documentId,
      ]);
      try {
        mainId = JSON.parse(localStorage.getItem(uiKey) ?? "{}").mainId;
      } catch {
        mainId = undefined;
      }
      mainId = ids.includes(mainId) ? mainId : ids[0];
      await openMain();
      $("connection").open = false;
      if (pendingIntent === "discuss" && !client.unresolvedCommands.length) {
        await createIndependent();
        pendingIntent = undefined;
      }
      $("status").textContent = `Подключено: ${descriptor.name}. Пустая сессия не вызывает модель.`;
    }),
  );
  $("disconnect").addEventListener("click", () => {
    client.disconnect();
    ids = [];
    schedule();
  });
  $("read").addEventListener(
    "click",
    guard(() => read()),
  );
  $("add-context").addEventListener(
    "click",
    guard(() => read()),
  );
  $("locate").addEventListener(
    "click",
    guard(async () => {
      if (!selected) throw new Error("Сначала прочитайте выделение");
      await adapter.execute("locate", selected);
    }),
  );
  $("discuss").addEventListener("click", guard(createIndependent));
  $("side").addEventListener(
    "click",
    guard(async () => {
      const id = await client.side();
      ids.push(id);
      if (selected) quotes.set(id, selected);
      $("threads").hidden = false;
    }),
  );
  $("document-tab").addEventListener("click", guard(openMain));
  $("discussion-tab").addEventListener("click", () => {
    $("threads").hidden = !$("threads").hidden;
    schedule();
  });
  $("composer").addEventListener(
    "submit",
    guard(async () => {
      const submittedDraft = $("prompt").value;
      const text = submittedDraft.trim();
      if (!text) return;
      if (!client.sessionId) await openMain();
      const submittedSession = client.sessionId;
      const submittedSelection = selectionRevision;
      const fragment = quotes.get(submittedSession) ?? (contextPending ? selected : undefined);
      const descriptor = await adapter.descriptor();
      const context = `\n\nDocument context (not parent chat history):\n${JSON.stringify({ projectPath: client.projectPath, document: descriptor, ...(fragment ? { selection: fragment } : {}) })}\nUse spec_harness_document tools for the live document. propose_edit returns a pending proposal; do not claim it was applied.`;
      await client.command(
        "sendText",
        { text: text + context, mode: $("mode").value },
        submittedSession,
      );
      if (client.sessionId === submittedSession && $("prompt").value === submittedDraft)
        $("prompt").value = "";
      if (selectionRevision === submittedSelection) contextPending = false;
      if (quotes.get(submittedSession) === fragment) quotes.delete(submittedSession);
    }),
  );
  $("prompt").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      $("composer").requestSubmit();
    }
  });
  $("stop").addEventListener(
    "click",
    guard(async () => {
      const work = client.snapshot?.control.activeWorks.find((item) => item.foregroundExecutionId);
      if (!work) throw new Error("Foreground execution identity is not available yet");
      await client.command("stop", { expectedForegroundExecutionId: work.foregroundExecutionId });
    }),
  );
  $("mode").addEventListener(
    "change",
    guard(() => client.command("switchCollaborationMode", { mode: $("mode").value })),
  );
  $("theme").addEventListener("click", () => document.documentElement.classList.toggle("dark"));
  function button(text, operation) {
    const element = node("button", text, "outline text-ui-caption");
    element.addEventListener("click", guard(operation));
    return element;
  }
  const renderInteractions = createInteractionRenderer(client, { node, button, report, display });

  function render() {
    $("connection-state").textContent = client.connected ? "ZCODE подключён" : "ZCODE не подключён";
    for (const id of ["send", "discuss", "side"])
      $(id).disabled = busy || !client.connected || Boolean(client.unresolvedCommands.length);
    $("document-tab").disabled = busy || !client.connected;
    $("recovery").replaceChildren(
      ...client.unresolvedCommands.map((command) => {
        const box = node("div", undefined, "interaction text-ui-sm");
        box.append(
          node(
            "p",
            `Подтверждение неизвестно: ${command.type} · ${command.commandId}. Повторная отправка остановлена.`,
          ),
          button("Проверить подтверждение", () => client.reconcile()),
          button("Я проверил результат в беседе", () =>
            client.acknowledgeUnknown(command.commandId),
          ),
        );
        return box;
      }),
    );
    $("stop").hidden = !client.snapshot?.control.canStop;
    $("document-tab").classList.toggle("active", client.sessionId === mainId);
    const snapshot = client.snapshot;
    $("model").textContent = snapshot?.config.model || "Модель ZCODE";
    $("model").title = snapshot
      ? `${snapshot.config.provider} · ${snapshot.config.thought}`
      : "Настройки берутся из ZCODE";
    if (snapshot && !busy) $("mode").value = snapshot.config.mode;
    $("context").textContent = selected
      ? hostName === "Word"
        ? "Документ · выделение"
        : hostName === "Excel"
          ? `Диапазон · ${selected.target.address}`
          : `Чертёж · ${selected.data.entities.length} объектов`
      : "Документ";
    $("threads").replaceChildren(
      ...ids.map((id, index) => {
        const row = node("div", undefined, `thread ${id === client.sessionId ? "active" : ""}`);
        row.append(
          button(id === mainId ? "Документ" : `Беседа ${index + 1} · ${id.slice(0, 8)}`, () =>
            client.open(id),
          ),
        );
        if (id !== mainId)
          row.append(
            button("Удалить", async () => {
              await client.command("deleteSession", {}, id);
              ids = ids.filter((item) => item !== id);
              if (client.sessionId === id) await openMain();
            }),
          );
        return row;
      }),
    );
    const scroller = $("messages");
    const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60;
    const rows = snapshot?.rows.window ?? [];
    // Bounded native projection, no full Root, diff/highlight workers or layout measurements.
    const existing = new Map(
      [...scroller.children].map((element) => [element.dataset.row, element]),
    );
    const elements = rows
      .filter((row) => ["userInput", "assistantText", "reasoning", "toolCall"].includes(row.kind))
      .map((row) => {
        let element = existing.get(String(row.rowId));
        if (!element) {
          element = node(row.kind === "toolCall" || row.kind === "reasoning" ? "details" : "div");
          element.dataset.row = String(row.rowId);
        }
        const content =
          row.kind === "toolCall"
            ? `${row.toolName} · ${row.status}\n${row.inputText}\n${display(row.output ?? row.error ?? "")}`
            : row.text;
        if (element.dataset.content !== content) {
          element.dataset.content = content;
          element.className =
            row.kind === "toolCall"
              ? "tool-detail text-ui-sm"
              : `message ${row.kind === "userInput" ? "user" : row.kind === "reasoning" ? "reasoning" : "assistant"} text-ui-base`;
          if (element.tagName === "DETAILS")
            element.replaceChildren(
              node(
                "summary",
                row.kind === "toolCall" ? `${row.toolName} · ${row.status}` : "Thought",
                "text-ui-sm",
              ),
              node("pre", content, "text-ui-base"),
            );
          else element.textContent = content;
        }
        return element;
      });
    if (!elements.length)
      elements.push(
        node(
          "p",
          client.state?.lastError ??
            (client.connected
              ? "Спросите о документе. Модель вызывается только после отправки."
              : "Прочитайте выделение или подключите ZCODE."),
          "text-ui-base",
        ),
      );
    elements.push(...renderInteractions(snapshot));
    // Preserve interaction inputs and focus while native streaming frames update other rows.
    for (const child of [...scroller.children]) if (!elements.includes(child)) child.remove();
    elements.forEach((element, index) => {
      if (scroller.children[index] !== element)
        scroller.insertBefore(element, scroller.children[index] ?? null);
    });
    if (atBottom) scroller.scrollTop = scroller.scrollHeight;
    $("proposals").replaceChildren(
      ...[...client.proposals.values()].map((proposal) => {
        const box = node("div", undefined, "proposal text-ui-base");
        box.append(
          node("strong", `Правка · ${proposal.status}`),
          node("p", proposal.explanation),
          node(
            "pre",
            display({
              target: proposal.expected.target,
              patch: proposal.patch,
              receipt: proposal.receipt,
            }),
            "text-ui-base",
          ),
        );
        if (proposal.status === "pending")
          box.append(
            button("Применить", () => client.apply(proposal.operationId)),
            button("Отклонить", () => {
              proposal.status = "refused";
              schedule();
            }),
          );
        return box;
      }),
    );
  }
  registerCommands?.(admitNativeCommand, report);
  window.addEventListener("pagehide", () => client.disconnect());
  render();
  return { client, read, dispose: () => client.disconnect() };
}
