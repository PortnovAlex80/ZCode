# Spec Harness: fork ZCODE

Ветка `research/spec-harness`, база ZCODE 3.15.1. План и архитектурные решения: [REFRACTORING.md](REFRACTORING.md). Исходники дополнений теперь живут в форке; старый overlay автоматически применять сюда нельзя.

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

Рекомендуемая версия Node берётся из `mise.toml` (24.14.0), pnpm — из `packageManager` (10.33.2). В текущей проверке использован Node 24.13.1; это отклонение от закреплённой версии, а не обновление требования.

```powershell
Set-Location D:\Development\ZCode-Harness
pnpm install --frozen-lockfile
pnpm prepare:desktop-runtime
.\Build-Harness.cmd
```

Первичная подготовка устанавливает Electron/native зависимости и агентные runtime assets. Это сборочные операции, не открытие приложения. В этой работе зависимости установлены с `--ignore-scripts` и `ELECTRON_SKIP_BINARY_DOWNLOAD=1`, поэтому Electron и native postinstall ещё нужно подготовить перед самостоятельным запуском. Если зависимости уже установлены таким способом, выполните `pnpm rebuild electron`, `pnpm --filter @zcode/desktop exec node scripts/node-pty-rebuild.mjs`, затем `pnpm prepare:desktop-runtime` и сборку.

Build компилирует в `packages/desktop/out`, создаёт receipt с хешами и заканчивает работу. Start ничего не собирает и не поднимает Vite. После любых изменений исходников снова выполняйте Build.

## Самостоятельный запуск после завершения текущей работы

Сначала завершите текущий ZCODE через Quit. Затем:

```powershell
Set-Location D:\Development\ZCode-Harness
.\Start-Harness.cmd
```

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
```

Оконные unit tests исполняют реальный coordinator с fake Electron: ACK, ранний возврат, таймаут и отказ неверному отправителю. Документные проверки покрывают пути, запись, якоря, восстановление состояния, изоляцию контекста и владение native composer. Проверка receipt отказывает при изменении/удалении lazy chunks и устаревших исходниках. Эти проверки не вызывают модель и не запускают GUI.

Живая приёмка ещё обязательна: Open doc после перезапуска и переключения проектов, сохранение и внешний конфликт, первый composer до Send, `/plan`, Side conversation с контекстом, новая дискуссия без истории, удаление, detach/Return/крестик, черновики и вложения, два монитора с разным DPI, отмена/разрешения агента, восстановление после сбоя. Профиль производительности: cold/warm detach, p50/p95 до готовой истории, CPU/heap, paint/layout при resize и нескольких активных агентах. Успешная сборка не подтверждает устранение всех задержек.

## Обновление upstream

```powershell
git fetch upstream
git switch research/spec-harness
git rebase upstream/main
```

Сначала убедитесь в чистом рабочем дереве. Конфликты разрешайте по контрактам текущей версии, сохраняя upstream возможности. Затем повторите проверки и Build. Выпуск и обновление живого профиля выполняйте только после ручной приёмки; при необходимости используйте новую ветку для обновления, сохраняя ранее принятую ревизию.
