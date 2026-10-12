# Word: панель документа с ZCODE

Office.js task pane внутри настольного Word. Основная панель теперь использует настоящий transport/projection ZCODE и native операции Word: чтение, переход, предложение правки, revisions и comments. До явного подключения отправка отключена. Работающие ZCODE сессии не изменяются. Полные шаги подключения, сборки и установки на другой машине: [общая инструкция](../document-host/README.md).

## Запуск на Windows

Нужны установленный Word с поддержкой надстроек, Node.js и доступ к Microsoft CDN для Office.js.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File D:\Development\ZCode-Harness\prototypes\word-preview\Start-Word-Preview.ps1
```

Первый запуск устанавливает официальные инструменты Microsoft отдельно от зависимостей ZCODE, регистрирует только эту надстройку и устанавливает локальный сертификат HTTPS для разработки. Сервер слушает loopback на порту 43481. Тестовый документ с закреплённой панелью создаётся в `%LOCALAPPDATA%\SpecHarness\word-preview`.

Выделите абзац → **Взять из Word**. После подключения к освобождённому Host можно открыть независимое обсуждение или Side conversation. Модель вызывается только при явной отправке. Предложенная замена/комментарий применяется отдельной кнопкой и сверяет закреплённый native Range; текстовые совпадения в другой части документа не используются вместо него.

Также: выделите текст → **ПКМ → ZCODE → Добавить в беседу / Обсудить отдельно**. На вкладке **Главная** — **Панель ZCODE**. Все входы используют один SharedRuntime 1.1 и общую admission boundary. `ReadWriteDocument` нужен native операциям; записи требуют WordApi 1.4 и нажатия «Применить». Состояние identity сохраняется в метаданных, а история остаётся в CLI.

Если Word просит подтвердить загрузку тестовой надстройки, разрешите **Spec Harness — Word**. Политика организации может запрещать тестовые надстройки.

## Проверка и удаление регистрации

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File prototypes/document-host/Test-Office-Adapters.ps1 -HostName word
```

Закройте тестовый документ. Для удаления только регистрации этой надстройки:

```powershell
node -e "const p=require('node:path'); const r=require('node:module').createRequire(p.join(process.env.LOCALAPPDATA,'SpecHarness','word-preview-tools','package.json')); r('office-addin-dev-settings').unregisterAddIn(p.resolve('prototypes/word-preview/manifest.xml'))"
```

Команду выполняйте из корня форка. PID локального сервера записан в `server.pid`; перед остановкой проверьте, что соответствующий процесс Node запущен именно с `prototypes/word-preview/server.mjs`. Word и ZCODE останавливать для этого не требуется.

Старый демонстрационный UI доступен отдельно по `/demo`. Текущие контракты и ограничения: [SRS](../../docs/spec-harness/DOCUMENT-HOSTS.md). Основа: [task pane add-ins](https://learn.microsoft.com/en-us/office/dev/add-ins/design/task-pane-add-ins), [Word quickstart](https://learn.microsoft.com/en-us/office/dev/add-ins/quickstarts/word-quickstart?tabs=yeomangenerator).
