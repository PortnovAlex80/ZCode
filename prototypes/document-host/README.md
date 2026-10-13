# Документы Word, Excel и AutoCAD через ZCODE

Общая панель работает с открытым документом через Office.js или native AutoCAD API. Сессии, модель, инструменты, история и разрешения проходят через существующий ZCODE CLI и Host. Общий чат документа, Side conversation с историей и новое обсуждение без истории — отдельные native сессии. Архитектура и ограничения: [SRS](../../docs/spec-harness/DOCUMENT-HOSTS.md).

## Подготовка без остановки работающего ZCODE

Из корня форка:

```powershell
Set-Location D:\Development\ZCode-Harness
.\Build-Harness.cmd
powershell -NoProfile -ExecutionPolicy Bypass -File prototypes\document-host\Build-Document-Pane.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File prototypes\autocad-preview\Build-AutoCAD-Preview.ps1
```

Build компилирует файлы; приложения и модель не запускаются. Для AutoCAD нужны установленный AutoCAD 2024, .NET SDK и WebView2 Runtime. DLL, зависимости и assets находятся в `%LOCALAPPDATA%\SpecHarness\autocad-preview\plugin`. Office использует Node.js, надстройки Office.js/SharedRuntime 1.1 и Microsoft CDN; Word operations требуют WordApi 1.4, Excel writes — ExcelApi 1.13.

Открыть панель в Office, пока агент ZCODE ещё работает:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File prototypes\word-preview\Start-Word-Preview.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File prototypes\excel-preview\Start-Excel-Preview.ps1
```

Эти команды регистрируют только соответствующую надстройку, поднимают локальный HTTPS сервер и открывают её пример. Они не подключаются к ZCODE сами. При первом запуске используется локальный сертификат Microsoft Office Add-in development tools. Доступны чтение выделения и native UX; отправка отключена до подключения. На вкладке «Главная» — «Панель ZCODE», в ПКМ — «ZCODE → Добавить в беседу / Обсудить отдельно». Связь примера с версией надстройки обновляется без замены содержимого документа.

## Первое подключение — после завершения текущей работы ZCODE

Заранее подготовить gateway для конкретных папок проектов:

```powershell
& .\prototypes\document-host\Prepare-Document-Gateway.ps1 -WorkspacePath @('D:\Development\ZCode-Harness', 'D:\Development\MyProject')
```

Здесь укажите существующие нужные папки. Config и отдельный pairing token сохраняются в `%LOCALAPPDATA%\SpecHarness\document-host\gateway.json`. Команда не запускает Host и не меняет глобальные переменные среды. Пути helper/Node/CA закрепляются в этом config; сам config не передаётся в Git. `caPath` указывает на `ca.crt` локального Office CA, `certPath` — на `localhost.crt` сервера. После обновления прежнего config повторите Prepare, сохранив список своих папок; token останется прежним.

Когда текущий ZCODE освобождён, завершите его штатно через Quit и выполните:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File prototypes\document-host\Start-Document-Harness.ps1
```

Wrapper откажется, если обнаружит работающий ZCODE; процессы не останавливает. Он запускает production fork с opt-in gateway. В Office/CAD панели раскройте подключение: канал `wss://localhost:43485/document`, точный путь разрешённого проекта и token из config. Token можно получить локально, не выводя его в общий лог:

```powershell
$documentConfig = Get-Content "$env:LOCALAPPDATA\SpecHarness\document-host\gateway.json" -Raw | ConvertFrom-Json
$documentConfig.token | Set-Clipboard
```

Модельные креды в панель не вводятся. Используется профиль и авторизация ZCODE этой машины, по обычной логике [запуска форка](../../docs/spec-harness/README.md). Пустая созданная сессия не вызывает модель. Document MCP добавляется новым сессиям, не меняет startup config текущих агентов и сохраняет другие настроенные MCP.

## AutoCAD

В уже открытом AutoCAD выполните `NETLOAD`, выберите `%LOCALAPPDATA%\SpecHarness\autocad-preview\plugin\SpecHarness.AutoCAD.dll`, затем `SHDOC`. Палитра штатно закрепляется, перемещается и становится плавающей. Если AutoCAD закрыт, можно открыть его с подготовленной палитрой:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File prototypes\autocad-preview\Start-AutoCAD-Preview.ps1
```

Загрузку собственного DLL подтверждает штатный AutoCAD; глобальный SECURELOAD не отключается. Отправка в ZCODE включается отдельно, как описано выше. Начальные геометрические типы: LINE/CIRCLE/ARC/LWPOLYLINE/TEXT/MTEXT; другие возвращают metadata. Геометрия содержит WCS, normal/OCS поля и INSUNITS без автоматической догадки о единицах. Первая запись — `setLayer` в существующий доступный слой. Произвольных LISP/VBA/команд в document tools нет.

## Работа и состояние

Выделите текст, диапазон или CAD объекты → «Взять из …». «Обсудить отдельно» создаёт независимую сессию; Side conversation ответвляется от текущей истории. Предложенная правка появляется для просмотра; «Применить» повторно проверяет native цель, затем выполняет операцию. Word использует revisions/comments; Excel — ограниченные values/formulas; AutoCAD — DocumentLock/transaction. Смена/закрытие документа отказывает старым запросам. Для Word якорь — tracked Range, не поиск одинаковой цитаты.

Лимиты: 20000 символов Word; 1000 смежных ячеек Excel; 100 CAD объектов и 1000 вершин; полный snapshot до 64 KiB. Для Excel объединённые, защищённые, array/spill диапазоны не записываются. Office read/compare/write не является атомарным CAS против coauthor edits.

Если ACK потерян, панель удерживает commandId и блокирует новую отправку до query или явной проверки пользователем. Ключи восстановления сохраняются при доступном localStorage; тексты туда не копируются. Предложения/receipts живут в памяти подключения и не восстановятся после его закрытия. Нативная история CLI сохраняется; diff store не создаётся. UI отображает текущее окно истории, reasoning, tools, permissions и AskUserQuestion; старая история подгружается явной кнопкой «Загрузить старее» (`pane.js:265-271`, `:396-399`), полные desktop dialogs пока не перенесены.

## Статус возможностей и фактическая приёмка (R-11)

Источник требования: [DOCUMENT-HOSTS.md:76](../../docs/spec-harness/DOCUMENT-HOSTS.md) и R-11 [чек-листа](../../docs/spec-harness/IMPLEMENTATION-CHECKLIST.md). Ниже — общие (кросс-хостовые) возможности; per-adapter страницы: [Word](word/README.md) · [Excel](excel/README.md) · [AutoCAD](../autocad-preview/README.md). Таблицы обновляются с каждой принятой волной. Статусы: `native-fixture-verified` — проверено на реальном API приложения через собственные одноразовые fixture-документы/чертежи; `UI-fixture-only` — проверено только юнит/UI-фикстурами с заглушками; `live-gated open` — приёмка требует живого ZCODE/модели/GUI и пока закрыта; `not implemented` — не реализовано. Ничто из `live-gated open` не считается проверенным.

| Возможность                                                                                                                                             | Где живёт                                                                | Статус                                     | Фактическая приёмка                                                                                                                                                                                                                                                                                          | Оставшийся гейт                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Общая панель: компактная native проекция истории/инструментов/reasoning/разрешений без монтирования Root/SessionPane и без eager diff/highlight workers | `pane.js:277-435` (граница проекции `:346-350`)                          | native-fixture-verified                    | Волна 3 (Impl OFix): pane-часть fixture на реальном Word и Excel — 15 проверок на хост + 1 compact-layout (320 px: без горизонтального переполнения, composer доступен) — [office-native-pane-checks.mjs](office-native-pane-checks.mjs), [office-native-acceptance.mjs:84-99](office-native-acceptance.mjs) | компактность в production renderer и живой GUI — T-07/T-03 live                  |
| Черновики и фокус при streaming; AskUserQuestion через общий чистый builder ответов ZCODE; Enter/Shift+Enter/IME                                        | `pane.js:196-241`, `:400-406`; `interactions.js`                         | native-fixture-verified                    | Pane-чеки в реальном Word/Excel — `office-native-pane-checks.mjs:29-47`, `:74-86`; юнит `pane.test.mjs:359-388` (8/8, node 24.13.1)                                                                                                                                                                          | T-10 live-половина                                                               |
| «Загрузить старее»: явная пагинация старой истории через native `conversationRowsRangeV4`, без eager-копии                                              | `pane.js:262-271`, `:396-399`                                            | UI-fixture-only                            | `pane.test.mjs:242-283`                                                                                                                                                                                                                                                                                      | живая пагинация через реальный gateway — T-03 live                               |
| Якоря контекста: очистка quotes/selected/contextPending на disconnect/reconnect и при смене `documentInstanceId`                                        | `pane.js:82-92`, `:134-135`, `:159-165`, `:208-214`                      | native-fixture-verified                    | Pane-чеки reconnect — `office-native-pane-checks.mjs:143-156`; юнит `pane.test.mjs:185-240`                                                                                                                                                                                                                  | T-04 live reconnect через реальный gateway                                       |
| Отсутствующие возможности с причиной: вложения и выбор модели явно отсутствуют (фиктивные контролы запрещены)                                           | `pane.js:14-17`, `:275`, `:308-312`                                      | not implemented (отсутствие показано явно) | Pane-чек `office-native-pane-checks.mjs:51-62`; юнит `pane.test.mjs:336-357`                                                                                                                                                                                                                                 | контрол выбора модели с переиспользованием публичного контрола — следующая волна |
| Opt-in HTTPS/WSS gateway: binding документа с сессиями, persisted session marker, ретракция по sessionNotFound, ACK/query восстановление                | `packages/desktop/src/host/*`; `packages/ui/src/document-host/client.ts` | UI-fixture-only                            | Волна 2 (принято): `documentGateway.test.ts` 15/15, `client.test.ts` (записано в чек-листе); волна 3 T-09 shutdown-фаза в работе и пока не принята; волна 4 (Impl Rfix) T-05 fixture-половина: allowed-origin/pairing отказы, canonical workspace key (один binding на документ через разные написания пути и рестарт), сужение возможностей после disconnect (инструменты отказывают без живой панели, старое generation не отвечает), backpressure/saturation → drained и terminate, durable deleteSession через рестарт — `documentGateway.test.ts` 23/23 | T-05/T-06 live: реальный CLI/provider; gate закрыт                               |
| O-06: адаптеры правят открытые DOCX/XLSX/DWG только через API приложения, файловыми средствами — никогда                                                     | `office-adapter.js` (+ AutoCAD plug-in)                                      | UI-fixture-only (guard-тест)               | Guard-тест `office-adapter.test.mjs` сканирует исходники Office-адаптера (`office-adapter.js`, `office-bootstrap.js`) на fs/path write API — 0 совпадений, падает при появлении; unit-fixture: внешняя файловая запись под открытым документом → отказ stale без записи. AutoCAD-аналог: plug-in правит открытый DWG только через managed API под DocumentLock, произвольные LISP/command strings запрещены (правило C-03, DOCUMENT-HOSTS.md:20) | live/native проверка AutoCAD-половины; формальная приёмка O-06 — root        |
| MCP document helper: `read_selection`, `read_target`, `locate`, `propose_edit`, `edit_status`; cancellation и изоляция session                          | `mcp-server.mjs:7-59`                                                    | UI-fixture-only                            | `mcp-server.test.mjs` 4/4 (node 24.13.1)                                                                                                                                                                                                                                                                     | живой helper в реальной сессии                                                   |
| TLS: доверенный корневой Office CA отличен от сертификата сервера, строгая проверка, настоящий HTTPS + MCP stdio + UTF-8                                | `mcp-tls-acceptance.mjs`                                                 | native-fixture-verified                    | T-01 принят на `bfede821`; повторный прогон 2026-10-13: `Native MCP stdio + strict CA TLS + UTF-8 response: passed`, exit 0, без ZCODE/модели                                                                                                                                                                | подключение к живому ZCODE не выполнялось (runtime gate)                         |

## Проверки и фактическая приёмка

```powershell
pnpm typecheck
pnpm lint
pnpm architecture:check -- --changed
pnpm exec vitest run packages/desktop/test/documentGateway.test.ts packages/ui/src/document-host/client.test.ts packages/ui/test/elicitationDialog.test.ts
node --test prototypes/document-host/*.test.mjs
node prototypes/document-host/mcp-tls-acceptance.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File prototypes/document-host/Test-Office-Adapters.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File prototypes/autocad-preview/Test-AutoCAD-Adapter.ps1
```

<!-- 中文说明：vitest 命令中的 client 测试路径原先指向 packages/ui/test/documentHostClient.test.ts，
该文件在已合入的重构中已移动到 packages/ui/src/document-host/client.test.ts；此处按当前树更正，
原因与依据见 git 历史与 IMPLEMENTATION-CHECKLIST.md 的 Wave 2 记录。 -->

Office acceptance откажется при уже открытом Word/Excel, создаёт временные собственные документы, запускает native API проверки и закрывает только свои приложения. Можно указать `-HostName word` или `excel`. CAD acceptance использует private Core Console profile и временный чертёж. Они не запускают ZCODE или модель.

Волна 3 (Impl OFix) расширила Office fixture на собственных одноразовых документах: word — 30 проверок (14 native Office API + 15 pane + 1 compact-layout), excel — 33 (17 native + 15 pane + 1), полный прогон `both` — 63; ожидания зафиксированы в [office-native-acceptance.mjs:5-8](office-native-acceptance.mjs). Базовая приёмка на `bfede821`: word 8 native + 3 UI (O-00), excel 7 native + 3 UI (O-01), AutoCAD 14 CoreConsole native проверок (C-00); AutoCAD-файлы с базовой ревизии не менялись. Юнит-проверки этого прототипа: 26/26 (`office-adapter.test.mjs` 14, `mcp-server.test.mjs` 4, `pane.test.mjs` 8) на node 24.13.1; волна 4 (Impl Rfix) добавила в `office-adapter.test.mjs` O-06 guard (fs/path write API в исходниках адаптера), O-06 отказ при внешней файловой записи под открытым документом и O-07 identity round-trip через persisted settings. Полный статус по каждой возможности: [Word](word/README.md) · [Excel](excel/README.md) · [AutoCAD](../autocad-preview/README.md).

Live gateway → реальный агент, GUI палитры AutoCAD и модельные сценарии требуют отдельной приёмки при следующем освобождённом запуске; текущий рабочий ZCODE не затронут.

## Другая машина

Клонируйте эту ветку, установите зависимости и соберите fork по [инструкции](../../docs/spec-harness/README.md). Установленные Word/Excel/AutoCAD остаются средствами редактирования; повторите Start Office, Build CAD и Prepare Gateway уже на той машине. Config/сертификат/пути и token создаются локально. Личный профиль/креды исходной машины не копируются: авторизация берётся у местного ZCODE. Это интеграция из checkout, не самостоятельный подписанный Office/CAD installer.
