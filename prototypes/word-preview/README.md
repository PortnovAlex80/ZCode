# Word: встроенная панель, локальный прототип

Это Office.js task pane внутри настольного Word. ZCODE, его Host, CLI, профиль и работающие сессии не используются. Ответы демонстрационные; содержимое выделения остаётся в памяти панели. При закрытии панели обсуждения исчезают. Прототип не изменяет документ.

## Запуск на Windows

Нужны установленный Word с поддержкой надстроек, Node.js и доступ к Microsoft CDN для Office.js.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File D:\Development\ZCode-Harness\prototypes\word-preview\Start-Word-Preview.ps1
```

Первый запуск устанавливает официальные инструменты Microsoft отдельно от зависимостей ZCODE, регистрирует только эту надстройку и устанавливает локальный сертификат HTTPS для разработки. Сервер слушает loopback на порту 43481. Тестовый документ с закреплённой панелью создаётся в `%LOCALAPPDATA%\SpecHarness\word-preview`.

Выделите абзац в документе → **Взять из Word** → **Обсудить отдельно**. Можно отправить вопрос, переключить обсуждение, удалить его, вернуться к разговору о документе или изменить тему панели. Отправка не вызывает модель.

Если Word просит подтвердить загрузку тестовой надстройки, разрешите **Spec Harness — Word**. Политика организации может запрещать тестовые надстройки.

## Проверка и удаление регистрации

```powershell
node --test prototypes/word-preview/model.test.mjs
```

Закройте тестовый документ. Для удаления только регистрации этой надстройки:

```powershell
node -e "const p=require('node:path'); const r=require('node:module').createRequire(p.join(process.env.LOCALAPPDATA,'SpecHarness','word-preview-tools','package.json')); r('office-addin-dev-settings').unregisterAddIn(p.resolve('prototypes/word-preview/manifest.xml'))"
```

Команду выполняйте из корня форка. PID локального сервера записан в `server.pid`; перед остановкой проверьте, что соответствующий процесс Node запущен именно с `prototypes/word-preview/server.mjs`. Word и ZCODE останавливать для этого не требуется.

Основа: [task pane add-ins](https://learn.microsoft.com/en-us/office/dev/add-ins/design/task-pane-add-ins), [Word quickstart](https://learn.microsoft.com/en-us/office/dev/add-ins/quickstarts/word-quickstart?tabs=yeomangenerator). Путь к настоящему общему ядру описан в [OFFICE-INTEGRATION.md](../../docs/spec-harness/OFFICE-INTEGRATION.md).
