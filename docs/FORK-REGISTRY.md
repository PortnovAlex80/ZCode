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
иконка тогла остались форкскими**. Статус: **OPEN**.

### CORR-1. Система открытия файлов — от ОРИГИНАЛА, не от форка (уточнение 2026-11-07 #2)

Режимы «Open doc» и «Open files» объединяются в нативный: **выбор файла —
родной механикой** upstream (файловое дерево/Files-вкладка; upstream «раньше
этого не делал, потом улучшил» — берём их улучшение). Наша правка
(Edit/Save/автосейв) — оверлей поверх, уже реализован. **Правый клик по
документу обязан сохранить форк-возможности: дискуссию, вынос в отдельное
окно, боковой диалог.**

Что сейчас не так (форк перехватывает нативный поток):

| # | Точка перехвата | Файл:строка | Что делает форк |
|---|---|---|---|
| 1 | **Перехват вкладок**: code-viewer вкладки с `.md/.markdown/.txt` внутри spec-root рендерят `SpecDocumentPane` вместо нативного `FileManagerPane` | `app-shell/AnimatedSidePanePanel.tsx:1899-1965`; предикат `canOpenSpecDocument` `:911-934` | Подмена нативного файлового таба документной панелью форка |
| 2 | **Пункт «Open doc»** в нативном лаунчере «+» (первым пунктом, форк-иконка FileText, требует форк-grant) | `AnimatedSidePanePanel.tsx:1357-1379`, `:864-879`; `lib/workspaceSidePane.ts:1042-1057` | Вторая, форк-система листинга/выбора документов (пикер) параллельно нативному дереву |
| 3 | Тегирование вкладок `specDocument: true` + привязка таба к файлу | `lib/codeViewer.ts:28`; `workspaceSidePane.ts:1796-1833, 1842+`; `useAppPanels.ts:529-537` | Форк-механика биндинга/дедупликации вкладок |
| 4 | Обработчики форк-входов (managed discussion reflow, retained windows) открывают документные вкладки | `AnimatedSidePanePanel.tsx:591-791, 887-910` | Маршрутизация через форк-табы |

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

Пользователь ожидает возможность держать несколько открытых сессий/окон на
разных мониторах одновременно. Проверить и зафиксировать состояние механики
(независимые окна бесед/документов, retained-восстановление, ограничения).
Статус: **проверка выполнена — см. результат в хронике реализации ниже.**

---

## 2. Реестр по зонам

Класс: **F** = форк-only (у upstream нет), **R** = замена/подмена нативного,
**O** = оверлей (нативное не тронуто), **T** = тесты/инфра к нативному.
Статус: keep / **open** (требование CORR) / retired / decide (нужно решение).

### 2.1 Документы: открытие, просмотр, правка

| Элемент | Класс | Статус | Файлы / факты |
|---|---|---|---|
| Document IO-сервис (read/save CAS `expectedSha256`, remove, list, **search** fuzzy top-K) | F | keep | `services/src/spec-document/specDocument{,Service}.ts`; whitelist `.md/.markdown/.txt/.rst`, ≤2 МиБ; U-14/U-18/U-20 |
| Перехват нативных вкладок → `SpecDocumentPane` | R | **open (CORR-1)** | см. CORR-1 п.1 |
| «Open doc» + пикер-комбобокс (U-08/U-12/U-13) + серверный поиск (U-20 path-half, «N shown · M total») | R | **open (CORR-1)** | `specDocumentPicker.tsx`; лаунчер-пункт `AnimatedSidePanePanel.tsx:1357-1379` |
| Оверлей правки на нативном просмотре (Edit → textarea, 500 мс автосейв, Save, CAS) | O | keep | `nativeFileEditing.tsx`; `WorkspaceFileTree.tsx:42-53,192-206`; `PreviewPane.tsx` (+`sourceEditor`,`documentActions`,`requestMarkdownViewMode`) — ruling 2026-11-07 |
| Автосейв/Save в документной вкладке (U-18; фикс мёртвой сессии 2026-10-31: error/closed ≠ писатель) | F | keep (внутри CORR-1 судьба панели = decide) | `SpecDocumentPane.tsx:749-847`; `useSpecDiscussion.ts` (guard) |
| Find-in-document Ctrl/Cmd+F (U-19) | F | keep | `documentFind.ts`; view=CSS Highlight, edit=selection |
| Обсуждения документа на нативных сессиях (D-02..D-04), writer-lease (Web Locks), паспорта `.harness/project.json` (U-02) | F | decide (при CORR-1) | `SpecDiscussionPane.tsx`, `specThread.ts`, `projectMetadata*.ts` |
| Независимые окна документов/бесед + retained-восстановление | F | keep | `DocumentWindowSurface.tsx`, `retainedDocumentWindows.ts`, `nativeConversationPopouts.ts` (desktop main) |
| PiP-попапы документа/дискуссий (U-06/U-07/U-17) | F | keep | `specPopoutWindow.ts`, `specPopoutRegion.tsx` |
| Watcher внешних изменений + персистентность presentation/drafts (D-01/D-05) | F | keep | `specDocumentWatch.ts`, `specDocumentPresentationState.ts` |

### 2.2 Оболочка/раскладка

| Элемент | Класс | Статус | Файлы / факты |
|---|---|---|---|
| Swap «Чат в центре / Документ в центре» (U-01/U-03) | F | **retired 2026-11-07** | `specShellLayoutSwap.ts` → только render-order restatement; кнопка/режимы/размеры удалены (`588e99c3`) |
| Роль-тогглы (U-04/U-05) + `Columns2` | R | **open (CORR-2)** | см. CORR-2 |
| Full-view тоггл, window controls, «+», нативный лаунчер | O | keep (оригинал) | `side-pane-full-view/`, `DesktopWindowControls.tsx` — байт-в-байт upstream |
| Сворачивание чата при активном документе | F | keep | `specGeneralChatCollapse.ts` |

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

## 4. Открытая приёмка (сводно)

79 незакрытых пунктов в чек-листе, ключевые семейства: GPT-00..08 (живая
GPT-приёмка/контракты), D-01..D-05 (документы; судьба части — decide при CORR-1),
W-01..W-05 (окна), P-01..P-04 (перф), T-02..T-10 (нативные контролы/трассировка),
R-03..R-11 (релизная гигиена), U-17..U-20 (U-20 контентная половина).
Архитектурные коллизии C1-C4/B1-B5 — см. ARCHITECTURE-REVIEW.md (B1 пересмотрен
ruling U-18).
