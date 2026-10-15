# GPT по подписке ChatGPT в ZCode Harness: план реализации

## Исправления подключения (2026-10-15)

Повторный живой дефект после успешного callback: credentials уже сохранены,
но login RPC ожидает best-effort `/models` без deadline и карточка продолжает
показывать Not connected. Успешный callback означает получение кода, а не
завершение обмена и загрузки каталога. Запрос каталога, включая чтение тела,
ограничен 15 секундами и отменяется по deadline; его сбой сохраняет авторизованную
сессию и завершает login с фактическим сохранённым статусом. Вечное ожидание
заголовков или JSON не должно удерживать login. Регрессии проверяют оба зависания
и завершение login с сохранённой записью. Никаких seed-моделей или другого billing.
Закрытие loopback listener также освобождает принятые speculative TCP connections
браузера без HTTP-запроса. Иначе Node server.close ждёт их несколько минут даже
после завершения callback; login RPC и UI остаются busy. Успешный HTTP-ответ должен
быть доставлен до очистки соединений. Регрессия использует настоящий net.Socket.

Живая диагностика после входа: запись аккаунта есть, cache каталога отсутствует,
а авторизованный `GET /v1/models` возвращает HTTP 520. Аккаунт и каталог имеют
раздельные результаты: сетевой сбой каталога не отзывает вход. Добавляется
`refreshModels()` account service с безопасным результатом completed/modelCount,
failed/code/httpStatus или unavailable. Host adapter читает текущую запись,
обновляет access token штатным coordinator при необходимости и пишет каталог
только если поколение аккаунта не сменилось. Login/logout/refresh сериализованы
одним account service. При ошибке старый каталог сохраняется; вымышленных моделей нет.
Обмен/обновление OAuth token также ограничены 15 секундами вместе с чтением тела.
Deadline действует внутри refresh coordinator до выхода из его lock: поздний
сетевой результат после timeout не может записать ротацию. Timeout сохраняет
имеющиеся credentials и освобождает очередь для следующего действия.

Карточка после подключения предлагает «Обновить модели» для явной повторной
попытки без OAuth; открытие настроек не делает дополнительный запрос автоматически.
Показываются отдельные загрузка/пустой каталог/
ошибка с HTTP-кодом; payload сервера и секреты в UI не передаются.

```text
UI refresh → Host account service (serialized) → adapter current OAuth record
    → bounded GET /models → generation-guarded cache write
    → provider source refresh → existing model selector
    └─ network error → preserve account/cache → sanitized result → retry UI
```

Аудит маршрутов после пользовательской приёмки выявил разрыв inference assembly:
адаптер требует request-auth source для `openai-oauth`, но bootstrap не передавал
созданный ChatGPT source в runtime. Исправление ограничено composition root и
provider runtime: create-app создаёт existing `createChatGptRequestAuthSource`
с общей encrypted credential store и env; `ApiProviderModelRuntime` получает его
через DI и передаёт только provider с `openai-oauth` access. Текущий Zhipu account
requestDependencies и API-key providers сохраняют свои прежние ветки. OAuth source
отсутствует/не выдаёт token → typed failure, без перехода на иной способ оплаты.
Тесты factory и composition с локальным HTTP подтверждают доставку OAuth token,
Zhipu/GLM branch и API-key branch отдельно, без реальных inference-запросов.

### Проверка маршрута и оплаты после переноса окон

| Выбор | Источник доступа | Маршрут и ограничение проверки |
| --- | --- | --- |
| GLM / официальный account provider | Существующие Zhipu account / Project Token / plan sources | Штатный ZCode/Z.ai gateway; правила `official-coding-plan-gateway.ts` не менялись этими исправлениями |
| OpenAI / ChatGPT | Отдельная OAuth запись SIWC, обязательный `chatgpt.tokens.use.direct` | Публичный `api.openai.com/v1/responses`; отсутствие разрешения или token завершает запрос ошибкой, не включает API key автоматически |
| Явно настроенный API-key provider | Пользовательский ключ выбранного провайдера | Прежняя отдельная ветка; вход ChatGPT её не подменяет |

Разделение маршрутов проверяется source/factory/HTTP fixtures и существующими
регрессиями gateway. Перенос UI дерева между окнами не создаёт новый model request
и не меняет provider/session. Фактическая тарификация и номер серверного счётчика
не определяются локальной конфигурацией. Документация SIWC описывает использование
плана ChatGPT; тождество конкретному счётчику «квота Codex» не подтверждено.
Проверка не выполняет платных model-запросов и не обещает сумму списания.
[Официальный контракт ChatGPT plan usage](https://developers.openai.com/siwc/token-sharing-open-source).

Повторная проверка реального Electron utilityProcess: PowerShell launcher возвращает
успех, но браузер не делает запрос даже к локальному диагностическому серверу.
В том же процессе Main `shell.openExternal` открывает страницу и сохраняет query.
Desktop теперь передаёт запуск через типизированный Host → Main запрос, разрешён
только официальный HTTPS authorization endpoint; Main подтверждает завершение
нативного запуска. Host ждёт подтверждение не дольше 20 секунд, timeout — ошибка.
OAuth URL с state/nonce не пишется в логи. CLI launcher не используется Desktop.
Порядок: UI → account service → OAuth loopback → Host browser request → Main
shell.openExternal → acknowledgment → ожидание пользовательского callback.

Windows открывает OAuth URL целиком, без разбора `&` командным интерпретатором.
Неудачный запуск браузера немедленно завершает попытку; карточка показывает причину
ошибки и ожидание браузерного входа. После входа Host явно обновляет каталог, не
полагаясь исключительно на файловый watcher. Отсутствие plan scope запрещает
доступ к моделям; каталог предыдущей сессии не переходит новому аккаунту.
Function/custom tools передаются через официальный `additional_tools` input item
с ролью developer; имена, call_id и локальная обработка результатов сохраняются.
Проверка: локальный OAuth server, тест ошибок запуска, UI failure/retry и wire
request/response fixtures. Реальный доступ аккаунта требует отдельного входа.

Владелец состояния: зашифрованная запись credentials → Host account service →
явный refresh provider projection → существующий selector. UI хранит только
состояние текущего действия и безопасное сообщение ошибки.

Дата проверки источников: 2026-10-15.
Статус: план; интеграция и доступ конкретного аккаунта ещё не проверены живыми запросами.
Целевой продукт: существующий `D:\Development\ZCode-Harness`, ветка `dev`.
Исследованный локальный HEAD: `f6907c59`; в рабочем дереве есть другие изменения.
Основной документ: [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md).
Задачи и фактическая приёмка: раздел GPT в [IMPLEMENTATION-CHECKLIST.md](IMPLEMENTATION-CHECKLIST.md).

## 1. Результат для пользователя

Пользователь работает в одном ZCode Harness на Windows. В «Manage models» выбирает
«Continue with ChatGPT», проходит авторизацию на сайте OpenAI и получает в привычном
селекторе группу «OpenAI — подписка ChatGPT». Модели, доступные его аккаунту, используются
для штатных задач ZCode: диалогов, работы с файлами, инструментов и субагентов.
VS Code и отдельный агентский интерфейс для этого не нужны.

Целевая интеграция использует официально документированный Sign in with ChatGPT
(SIWC), собственную регистрацию приложения и публичный Responses API с OAuth.
Вызов API с таким разрешением расходует доступный план/кредиты ChatGPT в соответствии
с настройками аккаунта; это не обычный Platform API key и не обещание безлимита.
Официальная документация описывает этот путь для open-source и локально запускаемых
приложений. Доступность проверяется для конкретного пользователя и workspace.
[Официальное описание](https://developers.openai.com/siwc/token-sharing-open-source),
[варианты подключения](https://developers.openai.com/siwc/quickstart).

## 2. Что означает «легально и без риска бана»

Инженерная цель — работа через разрешённый публичный механизм с соблюдением правил.
Нулевой риск блокировки, юридическую гарантию или одобрение именно нашего форка
обещать нельзя: условия, региональные ограничения, доступность аккаунта и решения
OpenAI находятся вне контроля приложения. Успешный вход сам по себе не доказывает
разрешение на расход подписки. Этот документ — технический план, не юридическое заключение.

Обязательные условия реализации:

- Регистрировать приложение под собственным правдивым именем `ZCode Harness`.
  Использовать выданный ему `client_id` и стабильный идентификатор установки.
  Не выдавать приложение за официальный Codex и не заимствовать его идентификаторы.
- Получать отдельное согласие на использование плана через официальный OAuth.
  Проверять выданные права, в том числе `chatgpt.tokens.use.direct`.
  При отказе или отсутствии разрешения GPT-запросы по подписке не запускать.
- Использовать `https://api.openai.com/v1/responses` по опубликованному контракту.
  Не использовать приватные `chatgpt.com/backend-api`, cookies веб-сессии,
  извлечение токенов из установленного Codex или эмуляцию стороннего клиента.
- Соблюдать лимиты, отзыв согласия и ограничения допуска. Не менять аккаунты,
  client/host ID, маршрут или сетевую идентичность для обхода запрета или квоты.
  Ошибка региона/политики требует прекращения соответствующего запроса и объяснения.
- Не передавать доступ другим людям и не превращать личную подписку в публичный
  прокси. Коммерческий/удалённо размещённый сервис требует отдельной проверки
  предусмотренного OpenAI пути; он не входит в этот локальный сценарий.
- При исчерпании подписки показывать состояние и ссылку управления расходом.
  Автоматического перехода на платный API или другую подписку не делать.
- Передавать только данные, которые пользователь вправе обрабатывать, и соблюдать
  применимые условия и Usage Policies. Код OAuth не отменяет эти обязательства.

Основания: [регистрация SIWC](https://developers.openai.com/siwc/token-sharing-open-source/sign-in),
[обработка отказов](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery),
[Terms of Use](https://openai.com/policies/terms-of-use/),
[Usage Policies](https://openai.com/policies/usage-policies/).
Перед живой приёмкой заново проверить актуальные условия и доступность для реального
аккаунта/workspace/региона. Часовой пояс компьютера не является доказательством региона.
Если официальный поток отказывает, зафиксировать причину; обход не является вариантом
выполнения этого плана. При неясности применимости — запросить разъяснение OpenAI.

## 3. Что найдено и что можно переиспользовать

Настоящий форк [nasone32/ZCode](https://github.com/nasone32/ZCode/tree/feat/chatgpt-oauth)
основан на той же upstream-версии 3.15.1. Проверенный HEAD:
`38a7ecce2c22f6614aad65306bf107d88bfcbbd0`; основная реализация:
`bd5171cb77b6f7cfac838b45a3557ac66a54d13f`.
В нём есть OAuth, локальное хранение credentials, обновление моделей и проекция
аккаунта в штатный селектор. Вход пока запускается из CLI, готовые релизные файлы —
Linux `.deb` и AppImage. Проверка исходников не равна проверке работающей Windows-сборки.
[Описание реализации](https://github.com/nasone32/ZCode/blob/38a7ecce2c22f6614aad65306bf107d88bfcbbd0/docs/chatgpt-oauth.md).

Использовать его как исследованный исходный материал для выборочного переноса в наш
fork, сохраняя лицензии/атрибуцию. Не заменять наш продукт чужой сборкой и не выполнять
слепой cherry-pick: feature-коммит также меняет маршрутизацию Z.ai и retry-поведение.
Такие изменения требуют отдельного доказанного обоснования, проверки правил Z.ai и
регрессии; сам факт наличия патча в форке не делает маршрут разрешённым.

Замечания предварительного code review, подлежащие воспроизведению тестами:

1. Refresh-запрос отправляется до межпроцессного захвата старого refresh token.
   Возможна конкуренция CLI/Host/agent; удаление и последующая запись не образуют
   одной транзакции. Очистка устаревших credentials также требует защиты от гонки.
2. Требуется проверить корректное соблюдение `earliest_refresh_at`.
3. Повышение revision встроенного каталога до 932 удерживает локальный provider от
   замены CDN, но не является устойчивой политикой обновления.
4. Совместимость function tools с SIWC не подтверждается mocked SSE-тестом.
   Нужно проверять реальный исходящий payload, namespace и возврат результатов.
5. Имена моделей не доказывают наличие vision, контекстного окна, reasoning effort
   или разрешения на inference. Пустой каталог не должен заменяться списком seed-моделей.

### Маршрут GLM в нашем форке и подпись запросов (исследование 2026-10-15)

Read-only исследование исходников без live-запросов уточнило рамку интеграции и
предупреждение выше о «маршрутизации Z.ai». Локальный HEAD `f6907c59`, база форка
`aac47556` (upstream 3.15.1).

1. Открытая редакция ZCode не содержит механизма подписи запросов вообще.
   `packages/shared/src/request-security-edition/verification-policy.ts` —
   `requestVerificationClaimHeaders()` возвращает `{}`, `readRequestVerificationConfig()`
   возвращает `null`; `apps/zcode-cli/packages/adapters/src/model/request-security-edition/index.ts`
   — `protectTransport` пропускает transport без изменений. Заголовки `X-Client-Sig`/
   `X-Client-Pow`, Ed25519-handshake и флаг `codingPlanSignature` существуют только в
   закрытой редакции официального клиента; в этом репозитории эндпоинты handshake
   упомянуты лишь в `docs/model-provider-project-access-token.md:130`. Форк эти файлы
   не менял: для каждого из них `git log aac47556..HEAD` пуст, по `apps/zcode-cli`
   с базы нет ни одного коммита.
2. Фактический маршрут GLM coding plan в форке: запросы к
   `https://api.z.ai/api/anthropic/v1/messages` и
   `https://open.bigmodel.cn/api/anthropic/v1/messages` переписываются в
   `https://zcode.z.ai/api/v1/ultra[-zai]/anthropic/v1/messages`
   (`apps/zcode-cli/packages/adapters/src/model/official-coding-plan-gateway.ts:8-11`,
   подключение порта — `apps/zcode-cli/packages/bootstrap/src/app/create-app.ts:566`,
   решение чисто URL-based), авторизация аккаунтовых режимов — короткоживущий
   Project Token (Bearer).
3. Следствие для этого плана: цель «сохранить льготный подписанный GLM-маршрут» в
   форке недостижима в принципе — подписи в открытой сборке нет, а по данным внешнего
   референса льготный учёт завязан на распознавание подписи. Корректная цель
   интеграции: не ухудшить текущий неподписанный маршрут (ultra-шлюз + Project Token),
   не затронуть его авторизацию и refresh. Проверка расхода — только сравнением
   списаний в кабинете Z.ai; маркер `signed_sent` в открытой редакции не наблюдается.
4. nasone32 фиксирует, что ultra-шлюз отклоняет неподписанные самосборки (401), и
   поэтому вырезает роутинг в `endpoint-routing-edition/index.ts`, направляя трафик
   напрямую в `api.z.ai`/`open.bigmodel.cn`. Наш форк этого изменения не переносил.
   Если 401 проявится в нашей сборке, это отдельное решение с проверкой биллинга и
   регрессией, а не автоматический перенос чужого фикса.

Классификация diff pinned-коммита `bd5171cb` (64 файла, +5144/−89):

- Переносить (ChatGPT-часть): `apps/zcode-cli/packages/adapters/src/auth/chatgpt/*`
  (`chatgpt-login-flow.ts`, `chatgpt-oauth-client.ts`, `pkce.ts`,
  `chatgpt-credential-record.ts`, `chatgpt-request-auth.ts`, `chatgpt-account-overlay.ts`),
  `model/chatgpt-responses-compat.ts`, SIWC-коды ошибок в
  `failure-provider-business-codes.ts`, `packages/shared/src/chatgpt.ts`, схемы
  провайдера (`provider-data-schema.ts`, `provider-config.ts`, `schema.ts`,
  `resolver.ts`, `sources.ts` — новый access-тип `openai-oauth` и группа
  `openai-family`), bootstrap-wiring (`create-app.ts`,
  `process-provider-registry-runtime.ts`, `provider-registry-model-runtime.ts`,
  `standalone-account-provider-runtime.ts`, `chatgpt-login.ts`),
  `packages/services/src/model-provider/chatGptAccountProjection.ts`, CLI
  `login/logout chatgpt` + i18n, точечные ветки `openai-oauth` в `runner.ts` и
  `model-execution.ts`.
- Не переносить вслепую (Z.ai-поверхность): вырезание ultra-роутинга в
  `endpoint-routing-edition/index.ts`; fallback в обход `z/login` в
  `auth/coding-plan-api-key.ts`; сужение apiKey-passthrough в
  `toAiSdkProviderConfig` (для трёх существующих access-типов эквивалентно, но
  требует перепроверки на наших путях). Классификация retry для signer-ошибок
  (`failure-classifier.ts`, `runner-retry.ts`) аддитивна и маршрут не меняет —
  кандидат на перенос после проверки.
- Каталог: сид-модели `gpt-6.1-sol`, `gpt-6.1-sol-fast`, `gpt-6-sol`, `gpt-6-luna`,
  `gpt-6-astra`, `gpt-5.6-sol/terra/luna`, `gpt-5.5(-fast)`; после входа живой каталог
  `GET /v1/models` (visibility `list`) замещает сид; рост revision 31→932 заменить
  устойчивым расширением registry (см. GPT-03).

Альтернативы рассмотрены: `rafek1241/zcode-router` — отдельный локальный мост с
дополнительной адаптацией; Codex app-server — другой agent backend. Для принятого
в проекте одного продукта со штатным ZCode runtime выбран native provider.
`zerx-lab/zcode` — другой проект, происходящий из oh-my-pi; `alexeygrigorev/codex-zcode`
решает обратное направление, подключая ZCode к Codex CLI.

## GPT-00 (root decision 2026-10-15): путь каталога — (A) локальная builtin-аугментация

Не поднимаем revision zcode-builtin.json (вариант форка ломает CDN). Провайдер account:chatgpt мержится в runtime-снапшот после чтения release; fingerprint аугментации входит в zcodeBuiltinRevision снапшота (guard registry-service:205 остаётся согласованным); CDN-обновления сравниваются с нетронутым release. builtinModelIds пусты до логина; после consent entitlement-оверлей кладёт slugs из /v1/models; model-rule wildcard для полноты конфигов. Seed-списки моделей запрещены (замечание #5).

## 4. Архитектура и владельцы состояния

Сохраняем основной план: один поддерживаемый ZCode Harness, штатные инструменты,
permissions, сессии, workflows и селектор. Временный изолированный профиль нужен
только для приёмки; отдельный постоянный продукт Preview не создаётся.

| Область | Владелец и правило |
| --- | --- |
| Авторизация и renewable session | Единый модуль ChatGPT account/auth в host-side services/adapters; операции CLI и UI используют общий контракт |
| Durable credentials | Защищённое локальное хранилище вне provider config и репозитория; один координатор refresh для записи аккаунта, в том числе между процессами |
| Состояние аккаунта в интерфейсе | Санитизированная проекция Host: connected, plan-enabled, reconnect-required, restricted, quota-exhausted; токены Renderer не получает |
| Каталог и capability mapping | Provider registry; ключи содержат provider/account/workspace/model, поддерживается валидный пустой каталог |
| Исполнение модели и инструментов | Существующий ZCode runtime и ModelFactory; новый тип access и Responses-адаптер |
| Browser open / callback lifecycle | Через существующий platform contract; loopback listener владеет одной OAuth-попыткой, timeout/cancel освобождают ресурсы |
| Очередь, run/session и права | Существующие владельцы; OAuth не создаёт второй Host или очередь команд |

Последовательность и границы секретов:

```text
UI: Manage models
  -> hook/service contract -> Host: beginChatGptLogin
  -> loopback listener + state/nonce/PKCE -> системный браузер -> OpenAI consent
OpenAI callback
  -> Host: проверка state, client, ID token, выданных scopes
  -> credential owner: защищённая атомарная запись
  -> catalog fetch -> registry projection -> UI: аккаунт и модели
UI: Send с provider/model
  -> штатный runtime -> request-auth owner: действующий access token
  -> Responses API -> tool call -> штатное исполнение ZCode -> tool result
  -> Responses API -> response.completed -> штатная проекция ответа в UI
```

Предлагаемые точки изменений (проверить controlled context перед кодом):

- `packages/provider/src/config/*`, `resolver.ts`, `sources.ts`: access type,
  entitlement и локальное расширение registry.
- `apps/zcode-cli/packages/adapters/src/auth/chatgpt/`: перенос/доработка OAuth,
  request auth, refresh и защиты хранилища.
- `apps/zcode-cli/packages/adapters/src/model/`: Responses compatibility, typed errors,
  преобразование tools, reasoning state, cancellation.
- `packages/services/src/model-provider/`: account projection, сервисные операции
  connect/disconnect/status, обновление каталога.
- `packages/shared`, публичные service/RPC-контракты и CLI bootstrap: строго типизированные
  состояния и wiring; не передавать секреты через UI-протокол.
- `packages/ui/src/ModelConfigSelect.tsx`, `chat-input-toolbar`, settings/hooks/i18n:
  существующий селектор и управление аккаунтом.
- `packages/desktop`: только необходимые platform/build boundaries; main не владеет
  бизнес-состоянием session. Windows packaging использует существующий Build-Installer.

Удалённые workspace и phone/web attachment не получают токены через UI.
Первая приёмка ограничена локальным Windows Host. Для иных execution hosts отдельно
определить владение credentials и допуска; до этого показывать явную недоступность.

## 5. Этапы реализации

| ID | Работа | Условие завершения |
| --- | --- | --- |
| GPT-00 | Зафиксировать spec/ADR, официальный контракт и матрицу допуска; прочитать актуальные условия, architecture context и правила целевых пакетов | Нет неоднозначности о локальном OSS-сценарии, identity, scopes и реакции на отказ; неизвестный допуск остаётся открытым gate |
| GPT-01 | Провести diff-аудит pinned fork; определить минимальный перенос и совместимость нашего dev; сохранить атрибуцию | Список нужных файлов и тестов; посторонние Z.ai изменения не попадают автоматически |
| GPT-02 | Реализовать OAuth и единый lifecycle credentials | Проверены PKCE/state/nonce/JWKS/issuer/audience/expiry/scopes, отмена, refresh rotation, конкуренция процессов, crash recovery и logout/revocation |
| GPT-03 | Добавить provider и каталог аккаунта | Список из официального API обновляет текущий picker; недоступные модели и неразрешённые effort/capabilities не предлагаются; нет CDN revision hack |
| GPT-04 | Адаптировать Responses и инструменты | Контрактные тесты исходящего wire payload и многошагового tool round trip, reasoning replay, изображения при поддержке, отмена и terminal errors |
| GPT-05 | Добавить UI подключения | Manage models -> Continue with ChatGPT; после consent модели появляются без перезапуска; account/workspace, using-plan, usage, disconnect/reconnect, доступность клавиатурой и i18n |
| GPT-06 | Провести регрессионные проверки и собрать Windows artifact | Релевантные тесты, typecheck/lint/architecture/affected gates, production build/installer receipt; штатные GLM-сценарии сохраняют свои контракты |
| GPT-07 | Выполнить живую приёмку в разрешённом изолированном окружении | Действительный consent, доступный каталог, завершённый tool loop и подтверждённый расход через план; нет скрытого API billing |
| GPT-08 | Проверить обновление, миграцию и восстановление | Fork-safe update, резервная копия/совместимость профиля, revoke, restart и rollback подтверждены; пользователь получает один рабочий продукт |

Зависимости: GPT-00 -> GPT-01 -> GPT-02 -> GPT-03/GPT-04 -> GPT-05 -> GPT-06
-> GPT-07 -> GPT-08. Проверки отказов проектировать одновременно с реализацией.
Перед новыми зависимостями соблюдать применимые правила tracker/lockfile; новых
зависимостей для написания этого плана не добавлено. Не публиковать fork/PR и не
выполнять live login/model calls в рамках одного лишь планирования.

### Контракт запросов и ошибок

Каталог получать через `GET https://api.openai.com/v1/models` с OAuth текущего аккаунта;
использовать `models`, видимость `list`, `display_name` и `slug`, сохранять серверный
порядок. Inference — `POST /v1/responses`, `store:false`, `stream:true`. Успех фиксировать
только после `response.completed`; `failed`, `incomplete` и обрыв потока — отдельные
исходы. [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference).

Проверять ограничения тела запроса по актуальному документу: поддержанные instructions,
размещение function/custom tools в namespace либо разрешённых input items, сохранение
tool-call IDs и reasoning state. Не переносить настройку «Max» или fast-mode вслепую.
Запрещённые параметры и hosted capabilities не отправлять. Локальный MCP tool,
исполняемый ZCode, отличать от hosted MCP OpenAI; первый требует проверки function
bridge, второй не становится разрешённым автоматически.
[Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).

Политика ошибок: отсутствие plan scope — inference отключён; 401 — контролируемое
восстановление/повторный вход по причине; 403 policy/region — остановка с объяснением;
quota exhausted — пауза новых запросов этой подписки и ссылка Usage; временная 503 —
ограниченный backoff. Не считать любую 429 временным rate limit. Не повторять
исполненный инструмент при восстановлении модели. UI сохраняет понятную причину;
диагностика — код и request ID без секретов.

### UX и критерии приёмки

- В «Manage models» пользователь видит отдельный способ «Continue with ChatGPT».
  После первого разрешения объясняется расход ChatGPT plan/credits; рядом с picker
  есть статус использования плана и переход к управлению расходом.
- Выбор GPT в основном диалоге, новом диалоге и разрешённых субагентах сохраняет
  идентичность provider/model; ошибка GPT не переключает запрос на GLM/API скрытно.
- Смена аккаунта/workspace инвалидирует соответствующий каталог. Начатый run имеет
  фиксированный account binding; logout/смена не подставляют другую identity в поток.
- Проверить реальный файл edit + команду в disposable workspace, выдачу результата
  инструмента модели и final answer; отдельно restart/resume и отмену.
- Проверить протухший и отозванный токен, одновременный refresh из двух процессов,
  отказ scopes, пустой каталог, quota failure после начала SSE, EOF до completed.
  Ошибочные ситуации проверять fixtures; не исчерпывать подписку ради теста.
- Проверить отсутствие токенов в logs, traces, renderer, provider config, crash reports,
  build artifacts; ключи шифрования защищены ОС/ACL, а не лежат открыто рядом с ciphertext.
- Проверить GLM и permissions regression; тестовый OAuth server не даёт доказательства
  реального допуска OpenAI. Закрывать live-acceptance только по наблюдаемым результатам.

[Официальные UX-рекомендации](https://developers.openai.com/siwc/ui-ux-guidelines),
[аккаунты и сессии](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions).

## 6. Текущий объём и gate

Этим изменением добавлены только план и ссылки в основной план/checklist.
GPT-00..GPT-08 остаются незавершёнными; код OAuth не перенесён, интеграция не собрана,
доступ аккаунта и реальное списание квоты не проверялись.

Доставка 2026-10-15 (root, исследование): в план добавлен раздел «Маршрут GLM в нашем
форке и подпись запросов» с фактами об отсутствии подписи в открытой редакции,
фактическом GLM-маршруте и классификацией diff донора на переносимое/непереносимое.
Изменены только этот документ и checklist; исходники, профиль и runtime не затронуты.
Эта поставка не закрывает GPT-01: построчный аудит diff, лицензии/атрибуция и
совместимость с нашим dev не воспроизведены.

Существующий runtime gate из checklist остаётся действующим: планирование не разрешает
запуск/остановку активного ZCode, смену профиля, установку сборки, OAuth-вход или запросы
к модели. Живую приёмку проводить по отдельному явному разрешению пользователя.
Это ограничение не препятствует текущей доставке плана в репозиторий.

Перед реализацией повторно проверить источники: SIWC развивается, названия моделей,
права и ограничения могут измениться. Любое подтверждение готовности должно включать
версию исходников, команды проверок и оставшиеся ограничения, без обещаний «бан невозможен».

Проверка этой документационной поставки (2026-10-15): workspace freshness — успешно;
`pnpm typecheck` — exit 0; `pnpm lint` — exit 0, 63 warnings / 0 errors в текущем
рабочем дереве; `git diff --check` для двух обновлённых документов — exit 0.
Проверены UTF-8, парность code fences, локальные ссылки и девять уникальных открытых
GPT-ID. Эти результаты не являются тестированием ещё не реализованной интеграции.

Проверка исследовательской поставки (2026-10-15, root): `pnpm typecheck` — exit 0;
`pnpm lint` — exit 0, 63 warnings / 0 errors (совпадает с базовой поставкой плана);
`git diff --check` двух обновлённых документов — exit 0. Живые запросы к OpenAI/Z.ai
не выполнялись; runtime gate не менялся.
