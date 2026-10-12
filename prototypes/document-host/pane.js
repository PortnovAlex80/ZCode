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
// 原因：仓级 oxlint max-lines（error, 400，不计空行/注释）也覆盖本原型文件；
// 修复依据：把两段静态文案提为模块级常量并紧凑书写新增代码，行为不变。
const ABSENT_CAPABILITY_NOTICE =
  "Вложения недоступны в панели документа; используйте ZCODE. Настройки берутся из ZCODE: выбор модели в панели недоступен.";
const THREAD_GONE_NOTICE =
  "Поток больше не существует: беседа удалена в ZCODE. Отправка в неё заблокирована — создайте новую беседу или откройте сессию в ZCODE.";

export async function mountDocumentPane(adapter, hostName, registerCommands) {
  let selected,
    ids = [],
    mainId,
    scheduled = false,
    busy = false,
    contextPending = false;
  const quotes = new Map();
  const retracted = new Set();
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
  // 原因：面板上下文锚点（quotes/selected/contextPending）只在单个连接代（connection
  // generation）和单个 documentInstanceId 内有效；旧实现断开后仍保留它们，重连后的下一次
  // 发送会把断开前读取的（可能来自另一文档、另一代的）выделение 静默附加给新会话。
  // 修复依据：DOCUMENT-HOSTS 冻结契约——reconnect/断开必须清空锚点；清理后新发送需要
  // 显式的重新 readSelection，pendingIntent 重发同样重新读取而不是复用旧锚点。
  function clearContextAnchors() {
    quotes.clear();
    selected = contextPending = undefined;
    $("quote").textContent = "Выделите фрагмент в документе.";
    schedule();
  }
  // 会话不存在的两个结构化信号（Wave 1 gateway 撤销绑定的依据）：subscribe 失败的
  // fault.subscribe.sessionNotFound 与 session 命令 rejected ACK 的 proto.sessionNotFound。
  const sessionGoneSignal = (error) =>
    /fault\.subscribe\.sessionNotFound|proto\.sessionNotFound/.test(
      String(error?.message ?? error ?? ""),
    );
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
      // 新连接代从这里开始：上一代的锚点不可跨代使用（见 clearContextAnchors 注释）。
      clearContextAnchors();
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
    // 断开即结束当前连接代：上下文锚点立即失效，离线期间不再可被发送路径取用。
    clearContextAnchors();
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
      if (retracted.has(submittedSession)) throw new Error(THREAD_GONE_NOTICE);
      const submittedSelection = selectionRevision;
      const descriptor = await adapter.descriptor();
      let fragment = quotes.get(submittedSession) ?? (contextPending ? selected : undefined);
      // 原因：提示词上下文是读路径，不受 adapter 对旧 instance 的拒写保护；同一活连接内
      // 文档切换后，旧 documentInstanceId 的 fragment 仍会被附加给新发送。修复依据：冻结
      // 契约规定锚点仅在同一个 documentInstanceId 内有效——instance 不一致时全部锚点失效。
      if (fragment && fragment.documentInstanceId !== descriptor.documentInstanceId) {
        clearContextAnchors();
        fragment = undefined;
      }
      const context = `\n\nDocument context (not parent chat history):\n${JSON.stringify({ projectPath: client.projectPath, document: descriptor, ...(fragment ? { selection: fragment } : {}) })}\nUse spec_harness_document tools for the live document. propose_edit returns a pending proposal; do not claim it was applied.`;
      try {
        await client.command(
          "sendText",
          { text: text + context, mode: $("mode").value },
          submittedSession,
        );
      } catch (error) {
        // 原因：会话被外部删除时 session 命令在 CLI 裁决阶段即被拒（reasonCode=
        // proto.sessionNotFound，gateway 收到同一信号后撤销持久化绑定）；若只按普通
        // 错误显示，面板会把死线程继续当作可用。修复依据：按该结构化信号把线程标记为
        // 已不存在并保持可见状态（行不静默消失），错误本身仍原样上抛保持可见。
        if (sessionGoneSignal(error)) retracted.add(submittedSession);
        throw error;
      }
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

  // «Загрузить старее»（旧历史分页，DOCUMENT-HOSTS 冻结契约）：显式控件 + 可见的
  // loading/has-more 状态；请求走 client.loadOlder → conversationRowsRangeV4 原生游标，
  // 不在面板复制完整历史。元素复用同一实例，避免流式重渲时丢失焦点。
  const olderControl = node("button", "Загрузить старее", "link text-ui-sm");
  olderControl.type = "button";
  olderControl.title = "Загрузить предыдущую часть истории из ZCODE";
  olderControl.addEventListener(
    "click",
    guard(() => client.loadOlder()),
  );
  // Паритет: отсутствующие возможности объясняются причиной, а не имитируются
  // (фиктивные контролы и demo-ответы запрещены). Вложения остаются ресурсом композера
  // desktop; выбор модели — задача отдельной волны с публичным контролем.
  $("composer").after(node("p", ABSENT_CAPABILITY_NOTICE, "footnote text-ui-xs"));

  function render() {
    $("connection-state").textContent = client.connected ? "ZCODE подключён" : "ZCODE не подключён";
    const snapshot = client.snapshot;
    // Текущая сессия исчезла: durable-истина — gateway binding（Wave 1 按 sessionNotFound
    // 结构化信号撤销）；панель 只显示状态，不静默改列表。行保留并标记。
    const storeGone = client.state?.status === "error" && sessionGoneSignal(client.state.lastError);
    const sessionGone = Boolean(client.sessionId) && (retracted.has(client.sessionId) || storeGone);
    if (sessionGone) retracted.add(client.sessionId);
    const offline = busy || !client.connected;
    const unresolved = Boolean(client.unresolvedCommands.length);
    for (const id of ["send", "discuss", "side"])
      $(id).disabled = offline || unresolved || (id === "send" && sessionGone);
    $("document-tab").disabled = offline;
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
    $("model").textContent = snapshot?.config.model || "Модель ZCODE";
    // Паритет: модель read-only из снапшота с причиной отсутствия контрола — настройки
    // берутся из ZCODE; фиктивный селектор модели запрещён.
    $("model").title =
      `${snapshot ? `${snapshot.config.provider} · ${snapshot.config.thought} · ` : ""}Настройки берутся из ZCODE: выбор модели в панели недоступен.`;
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
        const gone = retracted.has(id);
        const row = node("div", undefined, `thread ${id === client.sessionId ? "active" : ""}`);
        const label = id === mainId ? "Документ" : `Беседа ${index + 1} · ${id.slice(0, 8)}`;
        const open = button(label, () => client.open(id));
        open.disabled = gone;
        row.append(open);
        // Отозванный поток остаётся видимым с причиной (строка не исчезает молча):
        // членство в binding меняет только gateway по созданию/удалению/отзыву.
        if (gone) row.append(node("span", "поток больше не существует", "text-ui-caption"));
        else if (id !== mainId)
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
    if (!elements.length && !sessionGone)
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
    // «Поток больше не существует»: видимое состояние на первый отказ восстановленной
    // сессии (Wave 1: gateway уже отозвал её из binding; панель объясняет, не имитирует).
    if (sessionGone) elements.unshift(node("p", THREAD_GONE_NOTICE, "text-ui-base"));
    // Управление старой историей видно только когда есть что грузить или грузится.
    olderControl.hidden = !(client.loadingOlder || Boolean(client.hasOlderRows));
    olderControl.disabled = Boolean(client.loadingOlder);
    olderControl.textContent = client.loadingOlder ? "Загружается…" : "Загрузить старее";
    if (!olderControl.hidden) elements.unshift(olderControl);
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
