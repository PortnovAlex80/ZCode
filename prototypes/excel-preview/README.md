# Excel preview

Та же панель и локальная модель обсуждений, что в Word, с Excel API для чтения диапазона. Это UI-прототип: агент, транспорт ZCODE, запись в книгу и VBA отключены. Word и работающий ZCODE не перезапускаются.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File D:\Development\ZCode-Harness\prototypes\excel-preview\Start-Excel-Preview.ps1
```

Нужны desktop Excel с ExcelApi 1.1 / SharedRuntime 1.1, Node.js и доступ к Office.js CDN. Официальные инструменты и HTTPS-сертификат используются общие с Word-прототипом. Сервер Excel слушает localhost:43483. Отдельный ID регистрации и тестовая книга находятся в `%LOCALAPPDATA%\SpecHarness\excel-preview`.

Выберите **A1:D4** → **ПКМ → ZCODE → Обсудить отдельно** или **Взять из Excel** в панели. Контекст содержит адрес диапазона, значения и формулы. Общая беседа книги и отдельные дискуссии имеют разные истории; дискуссии можно удалять. Ограничение: один смежный диапазон не более 1000 ячеек. История временная, до закрытия книги.

«Панель ZCODE» на вкладке «Главная» повторно открывает ту же панель. Манифест ReadWriteDocument нужен Excel API, но в прототипе нет операций записи.

[Спецификация и сравнение VBA / Office.js](../../docs/spec-harness/EXCEL-PREVIEW.md). Общий UI находится в `prototypes/word-preview`; Excel имеет свои manifest, тестовую книгу и запуск.
