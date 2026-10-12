# Excel preview

Общая панель ZCODE и native Excel API: чтение/переход, предложение и применение values/formulas. Агент, разрешения и история идут через существующий CLI/Host после отдельного подключения. До него отправка отключена. Word и работающий ZCODE не перезапускаются. [Сборка, подключение, другая машина](../document-host/README.md), [SRS](../../docs/spec-harness/DOCUMENT-HOSTS.md).

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File D:\Development\ZCode-Harness\prototypes\excel-preview\Start-Excel-Preview.ps1
```

Нужны desktop Excel с ExcelApi 1.1 / SharedRuntime 1.1, Node.js и доступ к Office.js CDN. Официальные инструменты и HTTPS-сертификат используются общие с Word-прототипом. Сервер Excel слушает localhost:43483. Отдельный ID регистрации и тестовая книга находятся в `%LOCALAPPDATA%\SpecHarness\excel-preview`.

Выберите **A1:D4** → **ПКМ → ZCODE → Обсудить отдельно** или **Взять из Excel**. Контекст содержит sheet identity, адрес, значения, формулы и отображаемый текст. Общая беседа, Side conversation и независимые дискуссии — native сессии; история хранится в CLI, обсуждения удаляются. Лимиты: один смежный диапазон до 1000 ячеек и snapshot до 64 KiB.

«Панель ZCODE» на вкладке «Главная» повторно открывает ту же панель. Запись требует ExcelApi 1.13 и нажатия «Применить»: проверяются размеры, содержимое и защита/merged/array/spill. Объединённые, защищённые и массивные диапазоны отказываются. VBA/COM scripts не исполняются; ordinary values и invariant formulas разделены, formula-like строки не выдаются за обычные значения. Office compare/write не гарантирует атомарную защиту от coauthor edits.

Общий UI находится в `prototypes/document-host`; Excel имеет свои manifest, пример книги и запуск. Native acceptance:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File prototypes/document-host/Test-Office-Adapters.ps1 -HostName excel
```

Старый UI prototype остаётся отдельно по `/demo`; раннее сравнение VBA / Office.js — [EXCEL-PREVIEW.md](../../docs/spec-harness/EXCEL-PREVIEW.md).
