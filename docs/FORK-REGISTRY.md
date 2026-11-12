# Реестр правок форка ZCode-Harness (Fork Registry)

Единый реестр всех отличий форка от оригинала [zai-org/ZCode](https://github.com/zai-org/ZCode),
их статуса и открытых требований пользователя. Ведётся вручную; подробная
посверсионная история сборок — в [CHANGELOG.md](../CHANGELOG.md), доказательства — в
[spec-harness/IMPLEMENTATION-CHECKLIST.md](spec-harness/IMPLEMENTATION-CHECKLIST.md).

- **База сравнения**: upstream `a9fe401e` (v3.17.2, source-sync).
- **Объём дельты** (a9fe401e..HEAD): ~2200 файлов; 78% — добавленные тесты к
  нетронутому нативному коду; **удалённых upstream-файлов: 0**.
- **Продуктовый принцип (ruling 2026-11-07)**: нативный UX upstream остаётся
  как есть; форк добавляет возможности поверх (редактирование с сохранением,
  независимые окна, GPT/SIWC-провайдеры); подмены нативных потоков устраняются.

---

## 1. ОТКРЫТЫЕ ТРЕБОВАНИЯ (корректировки пользователя, 2026-11-07)

Требования подтверждены пользователем по итогам сборки `588e99c3`: реализовано
частично — правка наложена на нативный просмотр, но **система открытия файла и
иконка тогла остались форкскими**. Статус: **IMPLEMENTED 2026-11-07** (CORR-1 +
CORR-2 в одной ветке `u20-document-search`; приёмка по критериям ниже —
нативные вкладки, «+» без Open doc, три пункта в контекстном меню дерева,
PanelRight-иконки caption).

### CORR-1. Система открытия файлов — от ОРИГИНАЛА, не от форка (уточнение 2026-11-07 #2)

Режимы «Open doc» и «Open files» объединяются в нативный: **выбор файла —
родной механикой** upstream (файловое дерево/Files-вкладка; upstream «раньше
этого не делал, потом улучшил» — берём их улучшение). Наша правка
(Edit/Save/автосейв) — оверлей поверх, уже реализован. **Правый клик по
документу обязан сохранить форк-возможности: дискуссию, вынос в отдельное
окно, боковой диалог.**

Что сейчас не так (форк перехватывает нативный поток):

| # | Точка перехвата | Файл:строка | Что делает форк | Статус |
|---|---|---|---|---|
| 1 | **Перехват вкладок**: code-viewer вкладки с `.md/.markdown/.txt` внутри spec-root рендерят `SpecDocumentPane` вместо нативного `FileManagerPane` | `app-shell/AnimatedSidePanePanel.tsx` | Подмена нативного файлового таба документной панелью форка | **dismantled 2026-11-07** — все `code-viewer`/`file-manager` вкладки рендерят `FileManagerPane` (+ overlay правки); `SpecDocumentPane` остался только в независимых окнах/возвращённых документных табах (`source.specDocument`) |
| 2 | **Пункт «Open doc»** в нативном лаунчере «+» (первым пунктом, форк-иконка FileText, требует форк-grant) | `AnimatedSidePanePanel.tsx`, `lib/workspaceSidePane.ts` | Вторая, форк-система листинга/выбора документов (пикер) параллельно нативному дереву | **removed 2026-11-07** из лаунчера (и из popout-окон бесед); пикер внутри `SpecDocumentPane` (выбор файла в документном окне) сохранён |
| 3 | Тегирование вкладок `specDocument: true` + привязка таба к файлу | `lib/codeViewer.ts:28`; `workspaceSidePane.ts`; `useAppPanels.ts` | Форк-механика биндинга/дедупликации вкладок | keep (только для документных окон/возвращённых табов; нативные вкладки не тегируются) |
| 4 | Обработчики форк-входов (managed discussion reflow, retained windows) открывают документные вкладки | `AnimatedSidePanePanel.tsx` | Маршрутизация через форк-табы | **reworked 2026-11-07** — reflow и новый контекст-меню открывают независимое окно документа (`ensureIndependentDocumentWindow`, `INDEPENDENT_DOCUMENT_OPEN_EVENT`); входы: правый клик дерева («Обсудить документ», «Открыть в отдельном окне», «Боковой диалог» — `spec-document/workspaceFileEntryPoints.ts`) |

Критерии приёмки:
1. Клик по файлу в дереве/ссылке из чата на desktop всегда даёт **нативную**
   файловую вкладку (Preview/Source, Open-меню) с нашим оверлеем редактирования.
2. В лаунчере «+» — только нативные пункты (Files, Browser, Terminal, Review,
   Sites, Side conversation, Developer tools); форк-пункт «Open doc» убран,
   его роль исполняет нативная Files-вкладка.
3. **Правый клик (контекстное меню) по документу** — сохранены и работают:
   «Дискуссия» (обсуждение документа/фрагмента на нативной сессии), «Вынести в
   отдельное окно» (независимое окно документа/беседы), «Боковой диалог»
   (side conversation). Механизмы переиспользуются существующие
   (`SpecDiscussionPane`/managed-discussion event, popout/retained windows,
   selection side conversation), без новых сущностей.
4. Обсуждения/паспорта (D-02..D-05, U-02) не теряются: их точка входа
   переносится из панели документа в контекстное меню/нутри нативного
   просмотра (см. реализацию), механика остаётся форкской.

**Дополнение 2026-11-07 #3** (live-отчёт: у документа CLAUDE.md, открытого из
файлового дерева, в шапке не было ни карандаша Edit, ни обсуждений — «как мне
редактировать/сохранять/выносить в окно?»). Root cause: гейт правки в
`FileManagerPane` (`WorkspaceFileTree.tsx`) требовал `source.type === "text"`,
а дерево создаёт для md/txt lazy-source `type: "file"`
(`createCodeViewerSourceForWorkspaceFile`) — native editing не включался ни для
одного файла, открытого из дерева. Решение: гейт принимает `file` и `text` при
`typeof path === "string"` и `isNativeEditableTextDocumentPath(path)`; в той же
шапке рядом с [Edit/View][Save][status] теперь видны кнопки **Discuss**
(MessageSquare → `discussWorkspaceFileDocument`) и **Open in window** (AppWindow
→ `openWorkspaceFileDocumentWindow`) — те же входы CORR-1, что и в правом клике
дерева (`workspaceFileEntryPoints.ts`), с теми же условиями (локальный
workspace, текстовое расширение, path-строка).

### UC-2. Редактирование любого текстово-совместимого документа (2026-11-07 #4)

Формулировка пользователя: **any non-binary file** — не только .md/.txt/.rst,
но и json/yaml/yml/toml/ini/cfg/conf/env/properties/xml/csv/tsv/log, dotfiles
без расширения (.gitignore, .env, LICENSE) и т.п. — редактируется через
нативный оверлей; **бинарные форматы отсекаются**.

| Слой | Механика | Файлы |
|---|---|---|
| UI-гейт (Edit/Discuss/Open-in-window в шапке, правый клик дерева) | бинарный denylist `isTextCompatibleDocumentPath`: images/audio/video/archives/executables/fonts/pdf/office/databases/bin/iso/lock; без расширения и dotfiles = текст | `spec-document/nativeFileEditing.tsx`, `WorkspaceFileTree.tsx`, `workspace-file-tree/WorkspaceFileTreeRowView.tsx` |
| Контент-защита (главная, сервис) | UTF-8 round-trip + NUL-байты → «Only valid UTF-8 text documents are supported»; >2 МиБ → «…up to 2 MiB»; расширение больше не гейтит read/save/remove | `services/src/spec-document/specDocumentService.ts` (`resolveDocument`) |
| Поверхность редактора | оверлей-редактор рендерится и для `type: "file"`-источников — до этого textarea была только в `type: "text"`-ветке, и у дерева Edit был без поля ввода | `previewPaneContent.tsx` (file-ветка, зеркало text-гейта) |

- **Listing/search scope не менялся**: `DOCUMENT_EXTENSIONS`
  (.md/.markdown/.txt/.rst) остался только для `list()`/`search()` — пикер и
  поиск по-прежнему перечисляют prose-документы.
- Приёмка: read+save `.json`/`.yaml`/`.env`/`.gitignore` проходят; read `.png`
  (бинарные байты) → видимый отказ по UTF-8/NUL/2 МиБ, не «Unsupported text
  document»; list/search без изменений.

### 2026-11-08 #6: «Discuss fragment» из любого selection-тулбара (MPS12)

Формулировка пользователя: действие **Discuss fragment** должно быть доступно из
каждого selection-тулбара — (1) новый тулбар редактирования
(`EditorSelectionToolbar`, textarea оверлея правки, ba24b99b) и (2) тулбар
markdown-превью внутри нативных файловых вкладок (путь `FileManagerPane`).
Ранее там были только «Add to chat / Add in side chat»; «Discuss fragment» жил
только в превью внутри `SpecDocumentPane`. Статус: **IMPLEMENTED 2026-11-08**.

| Слой | Механика | Файлы |
|---|---|---|
| Единая точка входа | `discussWorkspaceFileDocument` получил опциональный `quote` (текущий текст выделения): live-событие `WORKSPACE_DOCUMENT_DISCUSS_EVENT` несёт его смонтированной панели; для свежесмонтированной панели (новое окно документа) — одноразовый pending-quote слот в модуле входа (popout-React-дерево живёт в renderer opener'а, модульное состояние видно; localStorage сознательно не используется — персистентный quote возрождал бы устаревший фрагмент) | `ui/src/spec-document/workspaceFileEntryPoints.ts` |
| Панель документа | discuss-активация с quote открывает док обсуждений и предзаполняет `questionDraft` нового document-scope треда (тот же слот, что у комментария; не автосообщение; существующий тред выбирается как есть — его черновик не перезаписывается; anchor-логика `{start, quote, sha256}` остаётся в `discuss()`) | `ui/src/spec-document/SpecDocumentPane.tsx` |
| Тулбары выделения | третий пункт «Discuss fragment» в `EditorSelectionToolbar` (parity с превью, через общий `SelectionActionMenu`) и в `MarkdownSelectionTooltip` нативной вкладки; handler один — тот же вход с текущим текстом выделения; гейт = fork-кнопки шапки (локальный workspace + text-compatible документ + известный path) | `editorSelectionToolbar.tsx`, `nativeFileEditing.tsx`, `WorkspaceFileTree.tsx` |

Границы: CodeViewer/Shadow-DOM не входит (MPS11); remote-вкладки тулбаров
редактирования не получают; новых i18n-ключей нет (английская надпись кнопки
уже существовала в `SelectionActionMenu`). Решение — MPS12 в
[docs/chat/markdown-preview-selection.md](chat/markdown-preview-selection.md).

### 2026-11-08 #8: «Open in separate window» в меню плавающего виджета full view

Формулировка пользователя: плавающий блок беседы (full view floating widget)
должен уметь парить по всем экранам, а не только внутри окна приложения.
Ресерч (см. хронику detach-работ): in-window DOM-блок физически не может
пересечь границу BrowserWindow; `documentPictureInPicture` сломан в Electron
(0×0, electron#39633). Решение — третий пункт в меню ⠿-ручки, переиспользующий
готовый conversation-roster detach (тот же вход, что у кнопки «вынести чат
в окно» в колонке чата). Статус: **IMPLEMENTED 2026-11-08**.

| Слой | Механика | Файлы |
|---|---|---|
| Пункт меню | опциональный `onOpenInWindow` в `SidePaneFullViewConversationHost`; пункт с иконкой PiP (`sidePane.fullView.openWindow`, en+zh) рендерится только при переданном обработчике (web remote / черновик без taskId — пункта нет); test-id `TID_SIDE_PANE_FULL_VIEW_MENU_OPEN_WINDOW` | `ui/src/side-pane-full-view/ConversationHost.tsx`, `shared/src/test-ids.ts`, `i18n/locales/{en-US,zh-CN}.ts` |
| Общий detach-вход | `handleOpenConversationInWindow` в shell layout: guard `activateManagedNativeDiscussionOwner` (существующее окно — фокус, не дубль) → `openConversationWindow(scope, activeTaskId, title, readOnly)`; инлайн-замыкание кнопки «вынести чат в окно» заменено этим же обработчиком; доступность = desktop ∧ ¬web-remote ∧ activeTaskId ∧ `platform.openConversationPopout` | `ui/src/app-shell/WorkspaceShellLayout.tsx` |

Границы: roster/geometry/attachment не тронуты; портал-механика `chatPopout`
(U-07, черновики без сессии) не изменена — пункт появляется только для
реальных задач; спека `docs/ui/side-pane-full-view.md` (меню ⠿) обновлена.
Тесты: `ui/src/app-shell/sidePaneFullViewOpenWindowMenu.test.tsx` (форвард
действия; пункт отсутствует без обработчика, соседние действия целы).

### 2026-11-08 #7: субагент-транскрипт открывается рядом с беседой внутри detached-окна

Формулировка пользователя: клик по субагенту (строка агента в таймлайне /
running-pill в статус-панели) внутри **вынесенного окна беседы** должен
показывать read-only транскрипт субагента **рядом с беседой в том же окне**.
Раньше действие уходило через `routeAction` в главное окно: оно перехватывало
активную задачу (`handleSelectTask`) и показывало guard «This conversation is
open in a separate window» — тупик. Статус: **IMPLEMENTED 2026-11-08**.

| Слой | Механика | Файлы |
|---|---|---|
| Перехват в floating shell | `onOpenSubagentSession` / `onOpenSubagentDirectory` / `onSyncSubagentSessionTabs` из floating-шелла больше не маршрутизируются через `routeAction`: сессия/каталог открываются во вторичном листе окна, sync зеркально чистит лист, когда родительская проекция больше не содержит показанного child (edit/retry); остальные действия маршрутизируются как прежде | `ui/src/spec-document/ConversationWindowHost.tsx` (`handleWindowAction`, `FloatingSubpaneLeaf`) |
| Вторичный лист | фиксированный сплит 60/40 (проценты — переживает min size 320x240), slim-заголовок с крестом (`conversation.window.subagentPane.close`, en+zh); переиспользуются main-window композиции `SubagentSessionSidePane` (read-only SessionPane, paneId `floating-subagent-<entryId>` — floating-префикс держит guard'ы выключенными) и `SubagentDirectorySidePane` (оба scope-only, контекст главного окна не нужен); повторный клик заменяет содержимое листа (React key = childSessionId), без стакинга; перепривязка ростер-записи (draft → session) сбрасывает лист | там же; `i18n/locales/{en-US,zh-CN}.ts` |

Границы: detached-механика (roster/geometry/attachment) не тронута; main-window
side panes не изменены; `onOpenBackgroundBash` из транскрипта по-прежнему
маршрутизируется в главное окно (вне скоупа v1). Тесты:
`ui/src/spec-document/conversationWindowSubpane.test.tsx` (6 сценариев: открытие/
закрытие, замена без стакинга, прочие действия маршрутизируются, sync-prune,
каталог→транскрипт, очистка состояния при закрытии окна).

### 2026-11-07 #5: discussion & side-chat detach lifted (A+B+C)

Формулировка пользователя: снять ограничение «обсуждение заперто внутри окна»
для плавающих обсуждений и мини-бокового диалога. Реализовано три опции:

| Опция | Что сделано | Файлы |
|---|---|---|
| A | Вложенные conversation-popout'ы разрешены из дочерних окон: blanket-deny заменён тем же allowlist-полиси (`about:blank` + `zcode-conversation-*`), рекурсивное adopt-ядро даёт вложенным поверхностям те же guard'ы (меню, навигация, геометрия) | `desktop/src/main/nativeConversationPopouts.ts` (`adoptConversationPopoutSurface`), тесты `desktop/test/nativeConversationPopouts.test.ts` |
| B | «Detach to window» в шапке обсуждения: `openConversationWindow(scope, thread.sessionId)`; владелец в документе отпускает токен (`releaseNativeDiscussionOwner`), пока окно открыто документ показывает read-only зеркало; закрытие окна ростера возвращает владение через тот же claim-путь; floating-панель ростера хостит освобождённую managed-дискуссию | `ui/src/spec-document/SpecDiscussionPane.tsx`, `ui/src/v4/WorkbenchPane.tsx` (SpecManagedSessionGuard), тесты `ui/src/spec-document/specDiscussionDetach.test.tsx` |
| C | «Open in window» у бокового диалога выделения: плавающая иконка в tab-поверхности вызывает `openConversationWindow(scope, childSessionId)` с дедупликацией; пока окно открыто, tab показывает guard «already open» вместо второго composer'а, закрытие окна возвращает живую панель | `ui/src/app-shell/SelectionSideChatPane.tsx`, тесты `ui/src/app-shell/selectionSideChatWindow.test.tsx` |

i18n: `specDiscussion.detachToWindow`, `specDiscussion.windowTitle`,
`sideChat.openInWindow` (en-US + zh-CN). In-window float-режим обсуждений
сохранён как есть (полезен внутри окна документа).

### CORR-2. Иконка/поведение тогла боковой панели — от ОРИГИНАЛА

Сейчас: форк-компонент `WorkspaceSidePaneCaptionControls` + роль-тоггл с иконкой
`Columns2` и семантикой «скрыть/показать AUXILIARY область» (U-04/U-05), порядок
[тоггл → full-view → window controls].

Оригинал a9fe401e: инлайн-блок в `AnimatedSidePanePanel` —
`WorkspaceSidePaneToggleButton` с иконками **`PanelRightClose`/`PanelRightOpen`**,
действие «закрыть/показать side pane», порядок [full-view → тоггл → window
controls], без `workspacePanelRoles`.

| # | Точка | Файл:строка |
|---|---|---|
| 1 | Форк-обёртка кластера контролов | `app-shell/WorkspaceSidePaneCaptionControls.tsx` (fork-only файл) |
| 2 | Замена иконки и семантики тоггла (`Columns2` вместо `PanelRightClose/Open`, роль-модель, проп `disabled`) | `WorkspaceSidePaneToggleButton.tsx:23-66`; `workspacePanelRoles.ts` (fork-only); `WorkspaceShellLayout.tsx:1051-1071` |
| 3 | Порядок контролов и восстановительный тоггл в caption чата | `AnimatedSidePanePanel.tsx:1382-1390, 1675-1699`; `WorkspaceShellLayout.tsx:1063-1071` |

Критерий приёмки: в caption — иконки и поведение оригинала
(`PanelRightClose/PanelRightOpen`, нативный порядок), без форк-роль-модели.

### VER-1. Несколько сессий одновременно на разных экранах (проверка, 2026-11-07)

Результат: **подтверждено и архитектурно, и живым использованием.**
- Окна бесед: ростер до 50 одновременно, персист x/y/w/h/maximized/displayId на
  окно, отрицательные координаты левых мониторов, recovery при пропавшем
  дисплее (`conversationWindows.ts`, `nativeConversationGeometry.ts`).
- Окна документов: до 24 параллельно + attach «документ↔беседа» с синхронным
  движением (`retainedDocumentWindows.ts`, `nativeWindowAttachment.ts`).
- PiP: синглтон и только web; в Electron отключён (electron#39633) — вместо
  него нативные окна выше.
- **Live-подтверждение пользователя 2026-11-07**: работал из вынесенного окна
  чата параллельно с основным. Формально открытой остаётся только аппаратная
  приёмка двух мониторов с разным DPI (W-05).
- Следствие для реестра: «вынести чат в окно» (conversation popout) — **keep,
  live-подтверждено**; в реализации CORR-1 механика не тронута (удалена лишь
  её внутренняя кнопка «Open doc», открывавшая демонтируемый форк-пикер).

---

## 2. Реестр по зонам

Класс: **F** = форк-only (у upstream нет), **R** = замена/подмена нативного,
**O** = оверлей (нативное не тронуто), **T** = тесты/инфра к нативному.
Статус: keep / **open** (требование CORR) / retired / decide (нужно решение).

### 2.1 Документы: открытие, просмотр, правка

| Элемент | Класс | Статус | Файлы / факты |
|---|---|---|---|
| Document IO-сервис (read/save CAS `expectedSha256`, remove, list, **search** fuzzy top-K) | F | keep | `services/src/spec-document/specDocument{,Service}.ts`; whitelist `.md/.markdown/.txt/.rst` — **listing-only** (list/search, UC-2); read/save/remove — любой не-бинарный текст, guard'ы UTF-8/NUL, ≤2 МиБ; U-14/U-18/U-20 |
| Перехват нативных вкладок → `SpecDocumentPane` | R | **retired 2026-11-07 (CORR-1)** | нативные вкладки → `FileManagerPane`; панель осталась в независимых окнах |
| «Open doc» + пикер-комбобокс (U-08/U-12/U-13) + серверный поиск (U-20 path-half, «N shown · M total») | R→F | **launcher entry removed 2026-11-07 (CORR-1)** | пикер остался внутри `SpecDocumentPane` документных окон (`specDocumentPicker.tsx`); лаунчер-пункт и popout-кнопка удалены |
| Оверлей правки на нативном просмотре (Edit → textarea, 500 мс автосейв, Save, CAS) | O | keep | `nativeFileEditing.tsx`; `WorkspaceFileTree.tsx:42-53,192-206`; `PreviewPane.tsx` (+`sourceEditor`,`documentActions`,`requestMarkdownViewMode`) — ruling 2026-11-07; UC-2: любой text-compatible документ (бинарный denylist), поверхность редактора и для `type: "file"`-источников |
| Автосейв/Save в документной вкладке (U-18; фикс мёртвой сессии 2026-10-31: error/closed ≠ писатель) | F | keep (внутри CORR-1 судьба панели = decide) | `SpecDocumentPane.tsx:749-847`; `useSpecDiscussion.ts` (guard) |
| Find-in-document Ctrl/Cmd+F (U-19) | F | keep | `documentFind.ts`; view=CSS Highlight, edit=selection |
| Обсуждения документа на нативных сессиях (D-02..D-04), writer-lease (Web Locks), паспорта `.harness/project.json` (U-02) | F | keep (входы = правый клик дерева «Обсудить документ» и «Discuss fragment» из selection-тулбаров нативной вкладки, CORR-1 + MPS12; оба → независимое окно) | `SpecDiscussionPane.tsx`, `specThread.ts`, `projectMetadata*.ts`, `workspaceFileEntryPoints.ts` |
| Независимые окна документов/бесед + retained-восстановление | F | keep | `DocumentWindowSurface.tsx`, `retainedDocumentWindows.ts`, `nativeConversationPopouts.ts` (desktop main) |
| PiP-попапы документа/дискуссий (U-06/U-07/U-17) | F | keep | `specPopoutWindow.ts`, `specPopoutRegion.tsx` |
| Watcher внешних изменений + персистентность presentation/drafts (D-01/D-05) | F | keep | `specDocumentWatch.ts`, `specDocumentPresentationState.ts` |

### 2.2 Оболочка/раскладка

| Элемент | Класс | Статус | Файлы / факты |
|---|---|---|---|
| Swap «Чат в центре / Документ в центре» (U-01/U-03) | F | **retired 2026-11-07** | `specShellLayoutSwap.ts` → только render-order restatement; кнопка/режимы/размеры удалены (`588e99c3`) |
| Роль-тогглы (U-04/U-05) + `Columns2` | R | **retired 2026-11-07 (CORR-2)** | `workspacePanelRoles.ts` и `WorkspaceSidePaneCaptionControls.tsx` удалены; `WorkspaceSidePaneToggleButton` восстановлен байт-в-байт upstream (`PanelRightClose/Open`, без `disabled`), caption-кластер снова инлайн в `AnimatedSidePanePanel` в порядке [full-view → тоггл → window controls]; отдельная кнопка «restore chat» в caption осталась только для форк-состояния свернутого чата |
| Full-view тоггл, window controls, «+», нативный лаунчер | O | keep (оригинал) | `side-pane-full-view/`, `DesktopWindowControls.tsx` — байт-в-байт upstream |
| Сворачивание чата при активном документе | F | keep | `specGeneralChatCollapse.ts`; document-active теперь только для документных вкладок/окон (`source.specDocument`) |

### 2.3 Провайдеры/аутентификация (сохранено полностью)

| Элемент | Класс | Статус | Файлы / факты |
|---|---|---|---|
| Sign in with ChatGPT (SIWC OAuth: PKCE, browser flow, localhost callback, credential record, id-token, refresh-координатор) | F | keep | `apps/zcode-cli/packages/adapters/src/auth/chatgpt/*` (11 файлов); `:0cd2366e,a79e7ad4` |
| Responses-API compat-слой + аккаунт-сервис/проекция ChatGPT; UI-карточка ChatGPT в настройках | F | keep | `model/chatgpt-responses-compat.ts`; `services/model-provider/chatGptAccount*`; `ui/settings/.../ChatGpt*` |
| Highspeed/coding-plan поверхности, часы истечения | F+O | keep | `highspeed*` (нативное) + `highspeedFooterExpiryClock.ts` |
| Provider-схема расширена под аккаунт-провайдеров; каталог моделей | R | keep | `provider/src/config/*`, `provider-node/chatgpt-builtin-augmentation.ts` |
| Профиль/аккаунты пользователя при установке сборок | — | сохраняется | установщик профиль не трогает (живой лог 2026-11-03: `account:chatgpt` entitled) |

### 2.4 Desktop main / сборка / инфраструктура

| Элемент | Класс | Статус | Файлы / факты |
|---|---|---|---|
| Нативные popout-окна бесед/документов, attachment «документ+беседа», геометрия | F | keep | `desktop/src/main/nativeConversationPopouts.ts` и др. |
| Трей/таскбар-бейдж непрочитанных | O | keep (трей-точка убрана upstream 3.17.2, таскбар-оверлей работает) | `unreadBadge.ts`, `desktopWindowLifecycle.ts` |
| Fork-safe обновления: packaged auto-update OFF; статус `updates-disabled` | R | keep | `autoUpdater.ts`, `shared/src/update*` |
| Сборка: `Build-Installer.cmd`, production receipts, affected-тесты, freshness-чек | F | keep | корень/scripts; `affected-unit-tests/*` (восстановлены после sync-потери, `e4739523`) |
| GNU-tar фикс npm staging на Windows (3.17.1) | F | keep | `:e630b797` |
| ~1400 добавленных тестов к нативному коду + e2e-корпус | T | keep | `packages/*/test`, desktop e2e |

---

## 3. Хроника (сжато; детали — CHANGELOG.md и чек-лист)

| Дата | Событие |
|---|---|
| 2026-10-12..15 | Порт Spec Harness (3.15.1): документ-таб, паспорта, SIWC-исследование, первый инсталлятор |
| 2026-10-17 | Паспорт: пять прозовых блоков (v2) |
| 2026-10-18 | Независимые окна документов; persistent conversation windows |
| 2026-10-21..30 | 3.16.2: SIWC OAuth полностью, U-08..U-13, U-18 автосейв (ruling «правка сразу на диск») |
| 2026-10-31 | Мерж v3.17.1 + U-19 поиск + фикс мёртвой сессии (Save-блокировка) |
| 2026-11-03 | Мерж v3.17.2 (без тега, по «го» пользователя); трей-точка убрана upstream |
| 2026-11-07 | Ruling «натив-first + наша правка; swap выпилить»; U-20 path-half; оверлей правки; swap удалён; сборки `d3457c0b`, `588e99c3` |
| 2026-11-07 | **CORR-1/CORR-2 зарегистрированы** (этот документ): открытие файлов и тогл — вернуть к оригиналу |
| 2026-11-07 | **CORR-1/CORR-2 реализованы** (ветка `u20-document-search`): нативный first-open, правый клик = форк-входы (обсуждение/окно/боковой диалог), caption = upstream-кластер; SpecDocumentPane — только документные окна/беседы |
| 2026-11-07 | **UC-2 реализован** (ruling 2026-11-07 #4): правка любого не-бинарного текста (json/yaml/env/dotfiles/…), бинарный denylist + контент-guard'ы; whitelist — только для list/search; поверхность редактора заведена для `type: "file"`-источников |
| 2026-11-07 | **Detach lifted (2026-11-07 #5, A+B+C)**: вложенные popout'ы из дочерних окон (A), «Detach to window» для обсуждений документов с handoff владения (B), «Open in window» для бокового диалога выделения (C) |
| 2026-11-08 | **«Discuss fragment» из всех selection-тулбаров (2026-11-08 #6, MPS12)**: единый вход `discussWorkspaceFileDocument` с quote, предзаполнение questionDraft обсуждения документа; правка + нативное превью получили третий пункт меню | |
| 2026-11-08 | **Субагент-транскрипт внутри detached-окна (2026-11-08 #7)**: клик по субагенту открывает read-only лист рядом с беседой в том же окне (60/40, замена без стакинга, sync-prune); маршрутизация в главное окно с hijack активной задачи устранена | |
| 2026-11-12 | **Root-fix возврата .md в preview (UC-2)**: после выхода из правки markdownViewMode залипал в "code" до переоткрытия таба; корень — PreviewPane форсит "code" при sourceEditor, но не восстанавливал дефолт при размонтировании редактора. Раньше обходилось ключёвкой PreviewPane в SpecDocumentPane (U-10, 2026-10-14); файловое дерево обхода не имело. Фикс в корне: ref-память форса + восстановление source-native дефолта (md → preview); регрессионный тест `previewPaneMarkdownViewRestore.test.ts` | |

## 4. Открытая приёмка (сводно)

79 незакрытых пунктов в чек-листе, ключевые семейства: GPT-00..08 (живая
GPT-приёмка/контракты), D-01..D-05 (документы; судьба части — decide при CORR-1),
W-01..W-05 (окна), P-01..P-04 (перф), T-02..T-10 (нативные контролы/трассировка),
R-03..R-11 (релизная гигиена), U-17..U-20 (U-20 контентная половина).
Архитектурные коллизии C1-C4/B1-B5 — см. ARCHITECTURE-REVIEW.md (B1 пересмотрен
ruling U-18).
