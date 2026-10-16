# Spec Harness: fork ZCODE

Метаданные файлов, папок и проекта: [поля, назначение и примеры заполнения](ARTIFACT-METADATA-GUIDE.md).
Руководство объясняет, как агент использует паспорт, как включить контекст
и как описать поручение на реальный Word-документ для расчётного бюро.

Следующий этап Claude: [английский промпт интеграции](ANTHROPIC-INTEGRATION-PROMPT.md).
Повторно используем интерфейс моделей; доступ через официальный Claude Code runtime
требует отдельного адаптера. Исследование выполнено, реализация ещё не начата.

Актуальная цель — одна поддерживаемая сборка из этого форка с обычным локальным профилем ZCODE. Официальный установщик — запасной вариант; отдельную overlay-сборку больше не развиваем. Управление работой: [план реализации](IMPLEMENTATION-PLAN.md), [чеклист с приёмкой](IMPLEMENTATION-CHECKLIST.md), [английский промпт команды](AGENT-TEAM-PROMPT.md). Чеклист отделяет проверенный код от ещё не выполненной живой приёмки.

Интеграция Word/Excel/AutoCAD: [SRS](DOCUMENT-HOSTS.md), [сборка и подключение](../../prototypes/document-host/README.md). Ранний план: [OFFICE-INTEGRATION.md](OFFICE-INTEGRATION.md).

Две ветки форка: `master` — основная ветка для принятых версий (сейчас исходная база ZCODE 3.15.1), `dev` — текущие доработки и документация. Работаем в `dev`; после приёмки переносим результат в `master`. Перенос и исследования desktop: [REFRACTORING.md](REFRACTORING.md). Исходники дополнений теперь живут в форке; старый overlay автоматически применять сюда нельзя. Старый spec-harness служит только источником требований для сверки. Проверка актуальности использует основную ветку `origin/HEAD` (`origin/master` в этом форке).

## Три режима общения

| Режим             | Начальный контекст                                            | Исполнитель        |
| ----------------- | ------------------------------------------------------------- | ------------------ |
| Основной чат      | История выбранной сессии проекта                              | Штатный ZCODE Host |
| Side conversation | Ответвление существующего контекста                           | Штатный ZCODE Host |
| Discuss fragment  | Новая независимая сессия: проект, документ, фрагмент и вопрос | Штатный ZCODE Host |

Независимая дискуссия использует native composer, разрешения, модель, поток и инструменты ZCODE. История основного чата не копируется. Исполнитель OpenCode не добавлен и не служит запасным маршрутом. Файловый сервис отвечает за чтение/запись документа; историю изменений хранит Git.

## Элементы интерфейса

| Элемент                                   | Поведение и состояние                                                                                    | Владелец реализации                                 |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Open doc в меню вкладок и пустой панели   | Открывает документы рабочей папки; выбор документа восстанавливается по workspace identity               | `SpecDocumentPane`, `specDocumentPresentationState` |
| Выбор документа                           | Меняет файл, сохраняет состояние предыдущего документа; ошибки чтения видимы                             | `SpecDocumentPane`, `SpecDocumentService`           |
| Edit / Reload / Save                      | Редактирование, перечитывание, запись с проверкой свежести и пути; внешний конфликт не затирает черновик | `SpecDocumentPane`, `specDocumentService`           |
| Развернуть документ / скрыть основной чат | Меняет компоновку; сессия и Host продолжают существовать                                                 | `WorkspaceShellLayout`, `specGeneralChatCollapse`   |
| Add to chat / Add in side chat            | Передаёт выделение соответствующему штатному composer                                                    | `MarkdownSelectionTooltip`, `SessionPane`           |
| Discuss fragment / Discussions            | Открывает независимые обсуждения; native UI появляется до первого Send                                   | `SpecDiscussionPane`, `useSpecDiscussion`           |
| Список обсуждений / корзина               | Переключает связанное обсуждение; удаление освобождает привязку и проверяет состояние выполнения         | `SpecDiscussionPane`, `specThread`                  |
| Плавающая дискуссия                       | Перемещается и меняет размер внутри renderer; не отдельный процесс                                       | `SpecDiscussionPane`                                |
| Move chat / active panel to window        | Передаёт право отображения отдельному BrowserWindow, подключённому к тому же Host                        | `specDetachedPanels`, `SpecDetachedPanelRoot`       |
| Return / закрытие дочерней панели         | Освобождение composer, ACK возврата, восстановление исходной панели; таймаут вызывает rollback           | `specDetachedPanels`, `useSpecDetachedPanels`       |
| Main / Session window                     | Обозначает роль окна; окно не является второй независимой копией хранилища                               | `specProjectWindows`, `WorkspaceShellLayout`        |
| Сворачивание проектов                     | Сохраняет выбор пользователя; обновление сессий не должно раскрывать все проекты                         | `WorkspaceSidebarItem`, `settingService`            |

Главный процесс владеет жизненным циклом окон, Host — принятыми командами и состоянием агента, UI — черновиками и компоновкой. Оконные функции доступны через платформенный bridge только при включённом `ZCODE_SPEC_HARNESS_WINDOWS=1`. Закрытие визуальной панели не означает отмену работы агента; выход из приложения завершает его Host. Независимые нативная сборка и форк с одним профилем запускаются по очереди.

## Сборка без запуска

### Подготовка на чистой машине (R-03)

Закреплённые инструменты: Node из `mise.toml` (24.14.0; проверка сборки требует Node 24+, `scripts/assert-node-version.mjs`), pnpm из `packageManager` (10.33.2), Electron 41.0.3 и electron-builder `^26.8.1` из `packages/desktop/package.json`. В текущей проверке использован Node 24.13.1; это отклонение от закреплённой версии, а не обновление требования.

```powershell
git clone https://github.com/PortnovAlex80/ZCode.git ZCode-Harness
cd ZCode-Harness
git switch dev
# Node 24.14.0 + pnpm 10.33.2 (mise), затем:
pnpm install --frozen-lockfile
```

Установка только `--frozen-lockfile`: `pnpm-lock.yaml` не перегенерируется. Postinstall (`node-pty-rebuild.mjs`) подготавливает нативный prebuild для Windows; отдельный `pnpm prepare:desktop-runtime` нужен только для запуска из исходников (см. ниже) — установщик готовит runtime-активы сам.

### Сборка production-кода из исходников

```powershell
.\Build-Harness.cmd
```

Build компилирует в `packages/desktop/out`, создаёт receipt с хешами (`out/spec-harness-production.json`: отпечаток исходников + SHA-256 всех выходов) и заканчивает работу. Start ничего не собирает и не поднимает Vite. После любых изменений исходников снова выполняйте Build. Сборка записывает только `packages/desktop/out` и не касается установленного ZCODE, профиля или ярлыков.

### Сборка установщика Windows x64 (R-08)

```powershell
.\Build-Installer.cmd          # полный путь: prepare -> production build -> упаковка
.\Build-Installer.cmd fast     # быстрый пересбор по проверенному кешу
```

Единый корневой скрипт над штатной upstream-цепочкой `pnpm bundle:desktop -- --os win --arch x64` (electron-builder/NSIS, `packages/desktop/scripts/bundle.mjs` + `packages/desktop/electron-builder.config.js`). Полный путь: (1) `pnpm --filter @zcode/desktop prepare:runtime-assets` — сборка CLI-агента из `apps/zcode-cli` в `bundled-agents/win32-x64/glm/zcode.cjs` и нативные инструменты поиска (ugrep из встроенного в репозиторий архива и ripgrep из официального релиза, оба с закреплённым SHA-256); (2) `node scripts/spec-harness-production.mjs build` — production-компиляция с receipt; (3) electron-builder NSIS с механическими проверками: замыкание runtime-зависимостей в `app.asar`, границы нативных пакетов только win32-x64, prebuild `node-pty` и аудит размера. Быстрый путь перед упаковкой валидирует кеш: receipt (исходники и выходы не менялись), побайтовое равенство `bundled-agents/win32-x64/glm/zcode.cjs` собранному `apps/zcode-cli/packages/cli/dist/zcode.cjs` и наличие `bundled-tools/win32-x64/{ugrep,ripgrep}`; при любой ошибке — явный отказ с кодом 1.

Скрипт фиксирует издательскую среду: `ZCODE_ENV=production` (одна установленная идентичность `ZCode`, appId `dev.zcode.app`), `ZCODE_AUTO_UPDATE=0` (см. политику обновлений ниже), цель win/x64, пропуск mock-cdn remote-активов (установщик их не потребляет), `CI=` очищен (electron-builder не публикует сам). Перед сборкой отдельная проверка отказывает в работе, если идентичность не production или автоматическое обновление включилось бы. Результат печатается явно: абсолютный путь артефакта, размер, SHA-256, базовая версия upstream (3.15.1, тег `v3.15.1` = `aac47556…`), ревизия форка (`git rev-parse HEAD`) и версия/коммит внутри пакета (`out/metadata/build-meta.json`).

Скрипт ничего не запускает, не устанавливает и не публикует: установщик не выполняется, профиль и установленный ZCODE не затрагиваются. Первая сборка может скачивать Electron runtime и NSIS-инструменты (зеркала — как в upstream-скриптах); подпись не предполагается — локальная подпись остаётся опциональной конфигурацией (проверено: артефакт `NotSigned`). Особенность машины без права создания symbolic links (включённый Developer Mode или администратор): распаковка кеша electron-builder `winCodeSign-2.6.0.7z` падает на darwin-симлинках. Обход без изменения системы: один раз распаковать архив в `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0` (ошибки симлинков игнорируются) и удалить оттуда папку `darwin` — проверено, `app-builder download-artifact --name winCodeSign` после этого берёт кеш без скачивания. В пакет идут оригинальные upstream-иконки из `packages/desktop/build` (установщика, окна и трея), CLI-агент и нативные зависимости с закреплёнными контрольными суммами; исходники, dev-кеш, карты кода, логи и приватные данные исключены (`files: out/**` + шаблоны обрезки в `electron-builder.config.js`, очистка sourcemap-ссылок в afterPack). Установщик содержит только desktop-приложение: настройки узлов Office (Word/Excel task pane через opt-in document gateway после установки desktop) и плагин AutoCAD (ручной NETLOAD из `prototypes/autocad-preview`) — отдельные шаги, которые этот пакет не выполняет. Исходная база форка совпадает с официальным тегом `v3.15.1`; EXE из Downloads служит запасным установщиком и не участвует в сборке исходников.

### Отсутствие инъекций (проверено по исходникам, R-03)

- Без Vite: production-сборка — разовый `tsup` + `vite build` (`packages/desktop/scripts/run-production-build.mjs`, `NODE_ENV=production`), без dev-сервера и вотчеров. Упакованное приложение грузит renderer из `app.asar`; dev-URL (`ELECTRON_RENDERER_URL`) читается только при `!app.isPackaged` (`packages/desktop/src/main/desktopHostProcess.ts:146`, `index.ts:2260`), а `scripts/spec-harness-production.mjs` дополнительно удаляет эту переменную из окружения запуска.
- Без временного HOME: `Build-Harness.cmd`, `Start-Harness.cmd` и `Build-Installer.cmd` не задают `HOME`/`ZCODE_DATA_BASE_DIR`; изолированный `ZCODE_DATA_BASE_DIR` в `mise.toml` относится только к dev-задаче `mise run dev`, не к production-запуску. Запуск из исходников использует обычный выбор dataBaseDir ZCODE.
- Без инъекций в активный runtime: сборки пишут только в `packages/desktop/out`, `packages/desktop/dist`, `packages/desktop/bundled-agents`, `packages/desktop/bundled-tools` и кеши сборки; не патчат установленный ASAR, не правят профиль/ярлыки и не перезапускают живой ZCODE. Установщик не запускается сборкой.

## Самостоятельный запуск после завершения текущей работы

Установите собранный `Build-Installer.cmd` EXE вручную (установка — отдельное разрешённое действие, не часть сборки; живая приёмка установки — R-09) или запустите из исходников. Сначала завершите текущий ZCODE через Quit. Затем:

```powershell
Set-Location D:\Development\ZCode-Harness
.\Start-Harness.cmd
```

## Политика fork-safe обновлений (R-10)

Автообновление в сборке форка отключено на этапе компиляции, и это проверяется механически:

- `Build-Installer.cmd` ставит `ZCODE_AUTO_UPDATE=0`; `scripts/build-time-config.mjs` превращает это в define `__ZCODE_AUTO_UPDATE_ENABLED__=false` (tsup/vite), явная переменная окружения сильнее любых локальных приватных значений.
- `packages/desktop/src/main/index.ts` вызывает `initAutoUpdater({ enabled: ZCODE_PRODUCT_FLAVOR === "production" && ZCODE_AUTO_UPDATE_ENABLED })`; при `false` модуль (`packages/desktop/src/main/autoUpdater.ts`) очищает опрос обновлений и закрывается fail-closed — ручная проверка обновлений тоже отказывает внутри модуля.
- В пакете остаётся upstream-файл `resources/app-update.yml` с конфигурацией-заполнителем (`http://localhost:8081`, проверено в собранном win-unpacked); он инертен — код обновления отключён на уровне компиляции, это второй независимый барьер.
- Предполётная проверка скрипта отказывает собирать, если автообновление включилось бы или идентичность не production. Официальный stable feed раздаёт официальные установщики; молчаливая замена ими форка исключена конструкцией.

Разрешённые пути обновления:

1. **Upstream-исходники** — рецензируемый merge (см. раздел ниже) и пересборка `Build-Installer.cmd` с повторными проверками. Только так изменения upstream попадают в форк.
2. **Официальный установщик** — явный запасной выбор пользователя, не автоматизм. Его запуск — отдельное осознанное действие.
3. **Профиль и данные** — переустановка приложения сама по себе не откатывает миграцию профиля; восстановление данных/схемы — отдельная процедура от переустановки приложения (резервная копия профиля при полностью закрытом приложении, R-04).

Известная оговорка (за пределами этого скрипта): packaged-приложение с production-идентичностью при старте опрашивает официальный `/api/v1/client/configs` на минимальную версию (`packages/desktop/src/main/forceUpdateGuard.ts`). Он не заменяет бинарник, но при повышении официальной минимальной версии выше 3.15.1 может блокировать старт форка с предложением обновиться. Это живое поведение, требующее решения в исходниках Main (не входило в R-08/R-10 и не проверялось под закрытым runtime-гейтом).

Запуск использует обычный выбор dataBaseDir ZCODE и домашний профиль, не создаёт временные HOME и не копирует креды. Не переопределяйте HOME/dataBaseDir, если нужен тот же список проектов и авторизация. Перед открытием новой версии сохраните резервную копию профиля при полностью закрытом приложении: upstream может изменять схему данных. На другой машине подготовьте зависимости там и используйте её локальный профиль установленного ZCODE; личные данные и токены в Git не передаются.

Штатные assets ZCODE сохранены в `packages/desktop/build`; ярлык работающей старой сборки не изменён. Start использует исходную иконку при создании новых окон. Авторская иконка будет добавлена отдельно.

## Проверки

```powershell
pnpm typecheck
pnpm lint
pnpm architecture:check -- --changed
pnpm exec vitest run packages/ui/src/spec-document packages/services/src/spec-document packages/ui/src/root/diffsWorkerBudget.test.ts packages/desktop/test/specDetachedPanels.test.mjs packages/ui/test/documentFirstInput.test.ts --maxWorkers=1
node --test scripts/test/spec-harness-production.test.mjs
.\Build-Harness.cmd
.\Build-Installer.cmd full
.\Build-Installer.cmd fast
```

Сборка установщика не запускает модель и не открывает GUI; она только компилирует и упаковывает.

Оконные unit tests исполняют реальный coordinator с fake Electron: ACK, ранний возврат, таймаут и отказ неверному отправителю. Документные проверки покрывают пути, запись, якоря, восстановление состояния, изоляцию контекста и владение native composer. Проверка receipt отказывает при изменении/удалении lazy chunks и устаревших исходниках. Эти проверки не вызывают модель и не запускают GUI.

Живая приёмка ещё обязательна: Open doc после перезапуска и переключения проектов, сохранение и внешний конфликт, первый composer до Send, `/plan`, Side conversation с контекстом, новая дискуссия без истории, удаление, detach/Return/крестик, черновики и вложения, два монитора с разным DPI, отмена/разрешения агента, восстановление после сбоя. Профиль производительности: cold/warm detach, p50/p95 до готовой истории, CPU/heap, paint/layout при resize и нескольких активных агентах. Успешная сборка не подтверждает устранение всех задержек.

## Обновление upstream

```powershell
git fetch upstream
git switch dev
git merge upstream/main
```

Сначала убедитесь в чистом рабочем дереве. Конфликты разрешайте по контрактам текущей версии, сохраняя upstream возможности. Затем повторите проверки, `Build-Harness.cmd` и полный `Build-Installer.cmd` (быстрый путь здесь не подходит — исходники изменились, receipt откажет). Автоматическое обновление установленного официального приложения эти изменения не принесёт — оно отключено в сборке форка (см. политику выше); единственный путь — merge, пересборка и ручная переустановка. Сохраняйте опубликованную историю `dev`; upstream обновляйте merge, без force-push и дополнительных постоянных веток. После приёмки на чистом дереве выполните `git switch master`, `git merge --ff-only dev`, `git push origin master`, затем `git switch dev`. Выпуск и обновление живого профиля выполняйте только после ручной приёмки.
