# 001: Общий Host и адаптеры живых документов

Дата: 2026-10-12. Развилка: complicated. Решение принято при работающих ZCODE сессиях; внедрение в живой процесс запрещено текущим объёмом.

## Контекст и требования

Word/Excel prototypes уже имеют похожую панель, но используют demo model. Нужно подключить настоящий агент и добавить AutoCAD, сохранив единый runtime/историю, native UX и изоляцию активной работы. Оценки — инженерные гипотезы, не измерения производительности.

## Варианты

| Вариант                                       | Изоляция 35% | Корректность 25% | Reuse 20% | Стоимость 10% | Обратимость 10% | Итог |
| --------------------------------------------- | -----------: | ---------------: | --------: | ------------: | --------------: | ---: |
| A: Office.js/WebView2, общий Host gateway     |            5 |                4 |         3 |             3 |               4 | 4,05 |
| B: Native WinForms CAD UI, общий Host gateway |            5 |                4 |         2 |             4 |               4 | 3,95 |
| C: Отдельный backend/owner каждого приложения |            2 |                3 |         4 |             4 |               4 | 3,00 |

A сохраняет общие визуальные assets и browser transport; требует доказать WebView deployment и CAD threading. B проще для первой native выборки, но дублирует чат/разрешения/темы. C отделяет установку, однако создаёт конкурирующие владельцы профиля и сессий. Независимый Red Team снизил reuse A с 5 до 3: сходство CSS не означает переносимость SessionPane.

## Решение

Выбран A как обратимая интеграция с явными gates. AutoCAD имеет отдельный типизированный native adapter, Office — Office.js adapters. Один opt-in gateway в текущем desktop Host переиспользует публичный agent connection scope, native v4 ACK/query/frames. Session-isolated MCP helper предоставляет tools без второго агента. Не используем App-Provided Tools с вымышленными plugin/instance IDs: этот путь требует реального Agent-issued MCP App instance. Runtime MCP config добавляется только новым сессиям и сохраняет полный исходный список серверов.

## Pre-mortem и меры

- Запись попадает в другой документ: обязательные document/instance/generation и повторная проверка target.
- WebView selection зависает: callback только enqueue, native работа — в command context после его возврата.
- Панель меняет активный профиль: gateway opt-in, нет запуска ZCODE или второго Host при подготовке.
- Пользователь изменил цель после предложения: snapshot check внутри adapter, отказ при stale; Office partial/unknown не повторяется.
- MCP server заменяет текущие инструменты: сохранить полный source config, isolation=session, не применять helper-only mcp/list process settings lease.
- Чат может писать файл через другие tools: bounded adapter не объявляется глобальной write isolation; нужна отдельная политика остальных инструментов.

## Проверочный trigger

До живого использования: установленный CAD load/выбор/отмена, Word/Excel API requirements, TLS/origin, session creation без firstInput, native stream/stop/permissions, reconnect/query и stale write. Ожидание: один принятый runtime, отсутствие provider credentials в pane, отсутствие eager diff workers в простой панели. Если WebView deployment/фокус не проходят gate, B остаётся резервом для CAD UI без замены protocol/adapter.
