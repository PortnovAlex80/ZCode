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

Здесь укажите существующие нужные папки. Config и отдельный pairing token сохраняются в `%LOCALAPPDATA%\SpecHarness\document-host\gateway.json`. Команда не запускает Host и не меняет глобальные переменные среды. Пути helper/Node/CA закрепляются в этом config; сам config не передаётся в Git.

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

Если ACK потерян, панель удерживает commandId и блокирует новую отправку до query или явной проверки пользователем. Ключи восстановления сохраняются при доступном localStorage; тексты туда не копируются. Предложения/receipts живут в памяти подключения и не восстановятся после его закрытия. Нативная история CLI сохраняется; diff store не создаётся. UI отображает текущее окно истории, reasoning, tools, permissions и AskUserQuestion; полные desktop dialogs и пагинация старой истории пока не перенесены.

## Проверки и фактическая приёмка

```powershell
pnpm typecheck
pnpm lint
pnpm architecture:check -- --changed
pnpm exec vitest run packages/desktop/test/documentGateway.test.ts packages/ui/test/documentHostClient.test.ts packages/ui/test/elicitationDialog.test.ts
node --test prototypes/document-host/*.test.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File prototypes/document-host/Test-Office-Adapters.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File prototypes/autocad-preview/Test-AutoCAD-Adapter.ps1
```

Office acceptance откажется при уже открытом Word/Excel, создаёт временные собственные документы, запускает native API проверки и закрывает только свои приложения. Можно указать `-HostName word` или `excel`. CAD acceptance использует private Core Console profile и временный чертёж. Они не запускают ZCODE или модель.

Проверены native операции Word и Excel; AutoCAD adapter компилируется против установленного SDK и проходит Core Console проверку. Gateway tests используют настоящий connection scope поверх fake base service: hello, ownership, early frames, restart, disconnect, ACK/query. Live gateway → реальный агент и GUI палитры AutoCAD требуют отдельной приёмки при следующем освобождённом запуске; текущий рабочий ZCODE не затронут.

## Другая машина

Клонируйте эту ветку, установите зависимости и соберите fork по [инструкции](../../docs/spec-harness/README.md). Установленные Word/Excel/AutoCAD остаются средствами редактирования; повторите Start Office, Build CAD и Prepare Gateway уже на той машине. Config/сертификат/пути и token создаются локально. Личный профиль/креды исходной машины не копируются: авторизация берётся у местного ZCODE. Это интеграция из checkout, не самостоятельный подписанный Office/CAD installer.
