# Teleton Agent — полный аудит логики V8 (Issue #738)

**Исходная задача:** [#738](https://github.com/xlabtg/teleton-agent/issues/738) ·
**Ветка:** `issue-738-eab8d3882c28`

**Сравниваемая база (`main`):** `fd9ac870` (после релиза 0.8.56) · **Аудитор:** Claude
Opus 5.5 (Claude Code).

## 1. Краткое резюме

Задача #738 требовала очередной сквозной проверки логики приложения, чтобы каждую
найденную ошибку, уязвимость или недоработку можно было оформить отдельной
профессиональной задачей с метками и этапами реализации.

Аудит V8 проведён в шесть параллельных направлений: TON / кошелёк / сделки /
ton-proxy; WebUI-бэкенд и сервисы (setup-сервер, вебхуки, журнал аудита,
marketplace); память, бэкапы и сессии; рантайм агента, инструменты, pipeline и
managed-агенты; Telegram-мост и обработка команд; веб-инфраструктура (CI, установщик,
docker compose, гигиена репозитория). Каждая находка перепроверена по исходному коду
(номера строк сверены с текущей веткой) и не дублирует находки волн
`improvements/work`..`work7`.

Подтверждено **27 находок**: 8 высокой, 14 средней и 5 низкой
серьёзности. Для каждой подготовлен шаблон задачи в [`issues/`](issues/).

Ключевые находки:

- **WORK8-001** — один полученный подарок подтверждает любое число сделок, и агент
  выплачивает средства многократно.
- **WORK8-002 / WORK8-003** — setup-сервер исполняет cross-site запросы, перезаписывающие
  кошелёк; подпись входящих вебхуков допускает отражение и replay исходящих доставок.
- **WORK8-004 / WORK8-005** — SSRF через IPv6-литералы и редиректы в
  `web_download_binary`; утечка секретов родителя из env в конфиг дочернего агента.
- **WORK8-006** — «pwn request» в CI: код fork-PR выполняется рядом с секретами.
- **WORK8-007** — восстановление бэкапа повреждается устаревшими WAL-файлами SQLite.

### Распределение по серьёзности

| Серьёзность | Кол-во | ID |
| ----------- | ------ | -- |
| Высокая | 8 | WORK8-001, WORK8-002, WORK8-003, WORK8-004, WORK8-005, WORK8-006, WORK8-007, WORK8-008 |
| Средняя | 14 | WORK8-009, WORK8-010, WORK8-011, WORK8-012, WORK8-013, WORK8-014, WORK8-015, WORK8-016, WORK8-017, WORK8-018, WORK8-019, WORK8-020, WORK8-021, WORK8-022 |
| Низкая | 5 | WORK8-023, WORK8-024, WORK8-025, WORK8-026, WORK8-027 |

### Распределение по категориям

| Категория | Кол-во | ID |
| --------- | ------ | -- |
| financial-safety | 3 | 001, 009, 010 |
| security | 7 | 002, 003, 004, 005, 006, 011, 012 |
| data-integrity | 2 | 007, 015 |
| correctness | 7 | 008, 014, 018, 021, 024, 025, 026 |
| supply-chain | 1 | 013 |
| reliability | 6 | 016, 017, 019, 020, 022, 023 |
| repo-hygiene | 1 | 027 |

## 2. Методология

- База сравнения — `main` на коммите `fd9ac870`; дубликаты сверялись с отчётами
  `improvements/work`..`work7` и ранее заведёнными задачами аудита.
- Шесть параллельных направлений (TON, WebUI, память, агент, Telegram, web-infra);
  рабочие заметки каждого направления — `experiments/audit8/*.md`.
- Каждая находка повторно сверена с исходным кодом; неточные номера строк исправлены
  (например, `src/ton/confirm.ts`, `src/ton/payment-verifier.ts:78`,
  `src/telegram/message-splitter.ts:83-84`, `src/session/store.ts:251-281`).
  Ни одна находка не была отброшена.
- Ограничения воспроизведения: в окружении не установлены часть зависимостей
  (`node_modules` частично, нативная сборка better-sqlite3, grammy). Поэтому
  часть находок (например, WORK8-003, WORK8-006, WORK8-010, WORK8-016, WORK8-017,
  WORK8-020, WORK8-025) подтверждена только чтением кода; тест WORK8-015 написан, но не
  запущен. Скрипты воспроизведения лежат в `experiments/audit8/`; временные копии
  тестов в `src/__tests__/audit8/` удалены после прогона.

## 3. Индекс находок

| ID | Заголовок | Серьёзность | Категория | Issue |
| -- | --------- | ----------- | --------- | ----- |
| [WORK8-001](issues/WORK8-001-gift-msgid-reuse-multiple-payouts.md) | Один подарок подтверждает любое число сделок — повторные выплаты | high | financial-safety | [#740](https://github.com/xlabtg/teleton-agent/issues/740) |
| [WORK8-002](issues/WORK8-002-setup-server-csrf-dns-rebinding-wallet-overwrite.md) | Setup-сервер принимает cross-site / DNS-rebinding запросы, перезаписывающие кошелёк и конфиг владельца | high | security | [#741](https://github.com/xlabtg/teleton-agent/issues/741) |
| [WORK8-003](issues/WORK8-003-inbound-webhook-signature-reflection-replay.md) | Подпись входящих вебхуков совпадает с исходящим HMAC: отражение, replay и инъекция событий | high | security | [#742](https://github.com/xlabtg/teleton-agent/issues/742) |
| [WORK8-004](issues/WORK8-004-download-binary-ssrf-ipv6-redirect-bypass.md) | SSRF-защита web_download_binary обходится IPv6-литералами и редиректами | high | security | [#743](https://github.com/xlabtg/teleton-agent/issues/743) |
| [WORK8-005](issues/WORK8-005-managed-agent-edit-leaks-parent-env-secrets.md) | Редактирование managed-агента записывает секреты родителя из env в config.yaml дочернего агента | high | security | [#744](https://github.com/xlabtg/teleton-agent/issues/744) |
| [WORK8-006](issues/WORK8-006-ci-pull-request-target-pwn-request.md) | CI выполняет код fork-PR под pull_request_target с доступом к VERCEL_TOKEN / CODECOV_TOKEN | high | security | [#745](https://github.com/xlabtg/teleton-agent/issues/745) |
| [WORK8-007](issues/WORK8-007-backup-restore-stale-wal-shm-sidecars.md) | Восстановление бэкапа оставляет устаревшие -wal/-shm, и SQLite накатывает старые WAL-кадры | high | data-integrity | [#746](https://github.com/xlabtg/teleton-agent/issues/746) |
| [WORK8-008](issues/WORK8-008-punctuation-prefixed-messages-dropped-as-commands.md) | Обычные сообщения, начинающиеся с `.`, `!` или `/`, считаются админ-командами и молча отбрасываются | high | correctness | [#747](https://github.com/xlabtg/teleton-agent/issues/747) |
| [WORK8-009](issues/WORK8-009-to-units-tofixed-precision-loss.md) | toUnits() на Number.toFixed даёт неверные on-chain суммы и падает на больших значениях | medium | financial-safety | [#748](https://github.com/xlabtg/teleton-agent/issues/748) |
| [WORK8-010](issues/WORK8-010-ton-confirm-window-shorter-than-valid-until.md) | Окно подтверждения TON (20 с) короче срока валидности сообщения (~60 с) — риск двойной выплаты | medium | financial-safety | [#749](https://github.com/xlabtg/teleton-agent/issues/749) |
| [WORK8-011](issues/WORK8-011-non-admin-admin-task-boot-prompts.md) | Не-админы могут запускать промпты `[ADMIN TASK]` и `/boot` при открытом доступе к командам | medium | security | [#750](https://github.com/xlabtg/teleton-agent/issues/750) |
| [WORK8-012](issues/WORK8-012-compose-webui-published-all-interfaces.md) | compose.yaml публикует WebUI на всех интерфейсах хоста по умолчанию | medium | security | [#751](https://github.com/xlabtg/teleton-agent/issues/751) |
| [WORK8-013](issues/WORK8-013-install-sh-upstream-repo-not-fork.md) | install.sh устанавливает upstream-репозиторий TONresistor вместо форка и отвергает клоны форка | medium | supply-chain | [#752](https://github.com/xlabtg/teleton-agent/issues/752) |
| [WORK8-014](issues/WORK8-014-nvidia-catalog-missing-default-model.md) | Каталог моделей NVIDIA не содержит модель по умолчанию `z-ai/glm-5.1` (дрейф после fd9ac870) | medium | correctness | [#753](https://github.com/xlabtg/teleton-agent/issues/753) |
| [WORK8-015](issues/WORK8-015-audit-trail-prune-breaks-verify-integrity.md) | AuditTrailService.pruneBefore ломает verifyIntegrity — ложная тревога о подделке | medium | data-integrity | [#754](https://github.com/xlabtg/teleton-agent/issues/754) |
| [WORK8-016](issues/WORK8-016-webhook-retries-lost-on-restart.md) | Повторы доставки вебхуков теряются при перезапуске (строки навсегда в `retrying`) | medium | reliability | [#755](https://github.com/xlabtg/teleton-agent/issues/755) |
| [WORK8-017](issues/WORK8-017-marketplace-update-uninstalls-before-install.md) | Marketplace updatePlugin сначала удаляет плагин; неудачная загрузка оставляет систему без плагина | medium | reliability | [#756](https://github.com/xlabtg/teleton-agent/issues/756) |
| [WORK8-018](issues/WORK8-018-pipeline-primary-step-no-tool-context.md) | Primary-шаги pipeline запускают агента без toolContext — вызовы инструментов теряются, шаг «completed» | medium | correctness | [#757](https://github.com/xlabtg/teleton-agent/issues/757) |
| [WORK8-019](issues/WORK8-019-registry-tool-timeout-abandons-exec.md) | Жёсткий 90-секундный таймаут реестра бросает exec-команды, которые ещё выполняются | medium | reliability | [#758](https://github.com/xlabtg/teleton-agent/issues/758) |
| [WORK8-020](issues/WORK8-020-ton-proxy-kills-foreign-process-on-port.md) | Старт TON Proxy посылает SIGTERM любому процессу на порту (по умолчанию 8080) и устаревшему PID | medium | reliability | [#759](https://github.com/xlabtg/teleton-agent/issues/759) |
| [WORK8-021](issues/WORK8-021-group-command-at-botname-not-recognised.md) | Групповые команды вида `/cmd@botname` не распознаются | medium | correctness | [#760](https://github.com/xlabtg/teleton-agent/issues/760) |
| [WORK8-022](issues/WORK8-022-nested-flood-retry-multiplies-attempts.md) | Вложенный withFloodRetry в user-mode sendMessage умножает число попыток (9 вместо 3) | medium | reliability | [#761](https://github.com/xlabtg/teleton-agent/issues/761) |
| [WORK8-023](issues/WORK8-023-payment-verifier-scans-only-20-transactions.md) | Проверка оплаты просматривает только 20 последних транзакций — спам скрывает реальный платёж | low | reliability | [#762](https://github.com/xlabtg/teleton-agent/issues/762) |
| [WORK8-024](issues/WORK8-024-reset-session-keeps-token-counters.md) | resetSession сохраняет счётчики токенов старой сессии | low | correctness | [#763](https://github.com/xlabtg/teleton-agent/issues/763) |
| [WORK8-025](issues/WORK8-025-bot-mentions-me-other-bot-commands.md) | mentionsMe в bot-режиме срабатывает на команды другим ботам и на похожие username | low | correctness | [#764](https://github.com/xlabtg/teleton-agent/issues/764) |
| [WORK8-026](issues/WORK8-026-message-splitter-breaks-surrogate-pairs.md) | splitMessageForTelegram при жёстком разрезе разбивает суррогатные пары UTF-16 | low | correctness | [#765](https://github.com/xlabtg/teleton-agent/issues/765) |
| [WORK8-027](issues/WORK8-027-tracked-scratch-artifacts-repo-root.md) | В корне репозитория отслеживаются временные артефакты автоматизации, включая деструктивный скрипт auto-commit/push | low | repo-hygiene | [#766](https://github.com/xlabtg/teleton-agent/issues/766) |

## 4. Подробности находок

### WORK8-001 — Один подарок подтверждает любое число сделок — повторные выплаты {#work8-001}

**Серьёзность:** high · **Категория:** financial-safety

Платежи TON дедуплицируются через `used_transactions`, а оплата подарком — нет. `verifyGiftPayment` (`src/deals/gift-matcher.ts:23-35`) принимает любой подарок с нужным slug и отправителем, полученный после создания сделки; `GiftDetector` создаётся заново при каждом вызове, а у колонки `user_payment_gift_msgid` (`src/deals/db.ts:42`) нет UNIQUE-индекса. Один подарок переводит в `verified` N параллельных сделок, и агент платит N раз. Воспроизведение: `experiments/audit8/repro-ton-gift-reuse.mts`.

См. [шаблон задачи](issues/WORK8-001-gift-msgid-reuse-multiple-payouts.md).

### WORK8-002 — Setup-сервер принимает cross-site / DNS-rebinding запросы, перезаписывающие кошелёк и конфиг владельца {#work8-002}

**Серьёзность:** high · **Категория:** security

CORS-middleware в `src/webui/setup-server.ts:118-155` лишь не выставляет `Access-Control-Allow-Origin`, но не отклоняет запрос: simple-запрос (`text/plain`) с чужого Origin выполняет `/wallet/generate`, `/wallet/import` и `/config/save` (`src/webui/routes/setup.ts:221,236,476`). Проверки Host/Origin нет, поэтому возможен и DNS rebinding. Подтверждено тестом `experiments/audit8/repro-webui-1.test.ts`.

См. [шаблон задачи](issues/WORK8-002-setup-server-csrf-dns-rebinding-wallet-overwrite.md).

### WORK8-003 — Подпись входящих вебхуков совпадает с исходящим HMAC: отражение, replay и инъекция событий {#work8-003}

**Серьёзность:** high · **Категория:** security

`verifyIncomingSignature` (`src/services/webhook-dispatcher.ts:385-393`) использует ту же конструкцию `signedHeader(secret, body)`, что и исходящая доставка (`:436`), без timestamp/nonce. Любую ранее отправленную доставку можно переотправить на `/incoming/:id`, а маршрут (`src/webui/routes/webhooks.ts:72-79`) доверяет `type` из тела и публикует произвольное внутреннее событие с fan-out.

См. [шаблон задачи](issues/WORK8-003-inbound-webhook-signature-reflection-replay.md).

### WORK8-004 — SSRF-защита web_download_binary обходится IPv6-литералами и редиректами {#work8-004}

**Серьёзность:** high · **Категория:** security

`isBlockedHostname` (`src/agent/tools/web/download-binary.ts:201-229`) вызывает `isIP` для hostname в квадратных скобках, получает 0 и пропускает `[::1]`, `[::ffff:127.0.0.1]`, `[fd00::1]`. DNS не резолвится, а `redirect: "follow"` (`:127`) позволяет публичному URL перенаправить запрос на metadata-сервис. Подтверждено `experiments/audit8/repro-agent-2.test.ts`.

См. [шаблон задачи](issues/WORK8-004-download-binary-ssrf-ipv6-redirect-bypass.md).

### WORK8-005 — Редактирование managed-агента записывает секреты родителя из env в config.yaml дочернего агента {#work8-005}

**Серьёзность:** high · **Категория:** security

`updateAgent` (`src/agents/service.ts:810,852`) и персональная авторизация (`:1015,1022`) читают конфиг через `loadConfig`, который применяет env-overrides (`src/config/loader.ts:184-203`), и сохраняют результат через `saveConfig`. API-ключ, телефон и прочая идентичность родителя попадают в файл дочернего агента. Подтверждено `experiments/audit8/repro-agent-1.test.ts`.

См. [шаблон задачи](issues/WORK8-005-managed-agent-edit-leaks-parent-env-secrets.md).

### WORK8-006 — CI выполняет код fork-PR под pull_request_target с доступом к VERCEL_TOKEN / CODECOV_TOKEN {#work8-006}

**Серьёзность:** high · **Категория:** security

`.github/workflows/ci.yml:8` использует `pull_request_target`, а jobs `test` и `deploy-vercel` делают checkout `head.sha` форка, запускают `npm ci`/`npm run build` и затем действия с `secrets.VERCEL_TOKEN`/`CODECOV_TOKEN`. Классический «pwn request»: любой пользователь GitHub может украсть токены. Только чтение кода.

См. [шаблон задачи](issues/WORK8-006-ci-pull-request-target-pwn-request.md).

### WORK8-007 — Восстановление бэкапа оставляет устаревшие -wal/-shm, и SQLite накатывает старые WAL-кадры {#work8-007}

**Серьёзность:** high · **Категория:** data-integrity

Цикл восстановления (`src/backup/restore.ts:145-155`) перезаписывает `memory.db`, но не удаляет `memory.db-wal`/`-shm`. БД работает в WAL (`src/memory/database.ts:54`), поэтому при следующем открытии старые кадры WAL применяются поверх восстановленной базы — восстановление молча откатывается или повреждается. Воспроизведение: `experiments/audit8/repro-backup-1.py`.

См. [шаблон задачи](issues/WORK8-007-backup-restore-stale-wal-shm-sidecars.md).

### WORK8-008 — Обычные сообщения, начинающиеся с `.`, `!` или `/`, считаются админ-командами и молча отбрасываются {#work8-008}

**Серьёзность:** high · **Категория:** correctness

`parseCommand` (`src/telegram/admin.ts:92-107`) возвращает команду для любого текста с префиксом `/`, `!` или `.`, а `src/index.ts:1365` молча выходит при `adminCmd && !commandAllowed`. Сообщения вроде «...так что?», «!срочно» или «.NET или Java?» от не-админов не доходят до агента. Подтверждено `experiments/audit8/repro-telegram-1.sh`.

См. [шаблон задачи](issues/WORK8-008-punctuation-prefixed-messages-dropped-as-commands.md).

### WORK8-009 — toUnits() на Number.toFixed даёт неверные on-chain суммы и падает на больших значениях {#work8-009}

**Серьёзность:** medium · **Категория:** financial-safety

`toUnits` (`src/ton/units.ts:10-15`, копии в `src/agent/tools/dedust/asset-cache.ts:75-80` и `src/sdk/ton.ts:562,776`) печатает двоичное значение double: `toUnits(0.1,18)` = `100000000000000006n`, `toUnits(1e21,9)` бросает исключение. Затрагивает `jetton_send`, свапы и котировки. Воспроизведение: `experiments/audit8/repro-ton-units.mts`.

См. [шаблон задачи](issues/WORK8-009-to-units-tofixed-precision-loss.md).

### WORK8-010 — Окно подтверждения TON (20 с) короче срока валидности сообщения (~60 с) — риск двойной выплаты {#work8-010}

**Серьёзность:** medium · **Категория:** financial-safety

`sendWalletTx` (`src/ton/confirm.ts:100-123`) вызывает `sendTransfer` без `timeout`, поэтому `valid_until` = now+60 с, а `confirmWalletTx` сдаётся через `TON_CONFIRM_TIMEOUT_MS = 20_000` (`src/constants/timeouts.ts:22`). Перевод, помеченный как неудачный, может пройти позже, а повтор отправит средства второй раз. Только чтение кода (node_modules не установлены).

См. [шаблон задачи](issues/WORK8-010-ton-confirm-window-shorter-than-valid-until.md).

### WORK8-011 — Не-админы могут запускать промпты `[ADMIN TASK]` и `/boot` при открытом доступе к командам {#work8-011}

**Серьёзность:** medium · **Категория:** security

В `src/index.ts:1303-1347` ветки `/task` и `/boot` формируют привилегированные промпты агенту, до `handleCommand`, проверяя лишь `isCommandAllowed`, который пропускает любого пользователя при `admin_only_commands=false` или пользователей из `allowed_user_ids`; `taskDescription` не экранируется. Только чтение кода.

См. [шаблон задачи](issues/WORK8-011-non-admin-admin-task-boot-prompts.md).

### WORK8-012 — compose.yaml публикует WebUI на всех интерфейсах хоста по умолчанию {#work8-012}

**Серьёзность:** medium · **Категория:** security

`compose.yaml:29-32` задаёт `TELETON_WEBUI_HOST: 0.0.0.0` и порт `"${TELETON_WEBUI_PORT:-7777}:7777"` без привязки к `127.0.0.1`, открывая полное управление агентом и кошельком по сети (plain HTTP). Только чтение кода.

См. [шаблон задачи](issues/WORK8-012-compose-webui-published-all-interfaces.md).

### WORK8-013 — install.sh устанавливает upstream-репозиторий TONresistor вместо форка и отвергает клоны форка {#work8-013}

**Серьёзность:** medium · **Категория:** supply-chain

`install.sh:9-10` задаёт `REPO="tonresistor/teleton-agent"` и образ upstream, а проверка origin (`:101-106`) аварийно завершается для клона `xlabtg/teleton-agent`, как предписывает README. Метаданные `package.json` тоже указывают на upstream. Только чтение кода.

См. [шаблон задачи](issues/WORK8-013-install-sh-upstream-repo-not-fork.md).

### WORK8-014 — Каталог моделей NVIDIA не содержит модель по умолчанию `z-ai/glm-5.1` (дрейф после fd9ac870) {#work8-014}

**Серьёзность:** medium · **Категория:** correctness

После коммита fd9ac870 список `nvidia` в `src/config/model-catalog.ts:491-512` содержит только `z-ai/glm-5-3*`, тогда как `src/config/providers.ts:196-197`, `src/providers/model-resolver.ts:82` и тесты (`nvidia-provider.test.ts:21,56,78`) по-прежнему используют `z-ai/glm-5.1`. UI не может выбрать модель по умолчанию, тест каталога падает.

См. [шаблон задачи](issues/WORK8-014-nvidia-catalog-missing-default-model.md).

### WORK8-015 — AuditTrailService.pruneBefore ломает verifyIntegrity — ложная тревога о подделке {#work8-015}

**Серьёзность:** medium · **Категория:** data-integrity

`pruneBefore` (`src/services/audit-trail.ts:446-449`) удаляет старые записи цепочки, а `verifyIntegrity` (`:288-322`) берёт seed = null, хотя у первой оставшейся записи `previous_checksum` не null. Нетронутый журнал помечается как подделанный. Тест `experiments/audit8/repro-webui-2.test.ts` написан, но не запущен (нет нативной сборки better-sqlite3).

См. [шаблон задачи](issues/WORK8-015-audit-trail-prune-breaks-verify-integrity.md).

### WORK8-016 — Повторы доставки вебхуков теряются при перезапуске (строки навсегда в `retrying`) {#work8-016}

**Серьёзность:** medium · **Категория:** reliability

Повторы планируются только in-memory таймерами (`src/services/webhook-dispatcher.ts:207,488-495`); при старте строки со статусом `retrying` не подхватываются, и доставки зависают навсегда. Только чтение кода.

См. [шаблон задачи](issues/WORK8-016-webhook-retries-lost-on-restart.md).

### WORK8-017 — Marketplace updatePlugin сначала удаляет плагин; неудачная загрузка оставляет систему без плагина {#work8-017}

**Серьёзность:** medium · **Категория:** reliability

`updatePlugin` (`src/webui/services/marketplace.ts:577-582`) вызывает `uninstallPlugin`, затем `installPlugin`. Если загрузка или установка падают, плагин и его данные уже удалены. Только чтение кода.

См. [шаблон задачи](issues/WORK8-017-marketplace-update-uninstalls-before-install.md).

### WORK8-018 — Primary-шаги pipeline запускают агента без toolContext — вызовы инструментов теряются, шаг «completed» {#work8-018}

**Серьёзность:** medium · **Категория:** correctness

`PipelineExecutor` (`src/services/pipeline/executor.ts:318-327`) вызывает `processMessage` без `toolContext`; рантайм (`src/agent/runtime.ts:1181-1183`) прерывает цикл, и возвращается строка «Internal error…» (`:1551-1556`), которую шаг сохраняет как успешный результат. Подтверждено `experiments/audit8/repro-agent-3.test.ts`.

См. [шаблон задачи](issues/WORK8-018-pipeline-primary-step-no-tool-context.md).

### WORK8-019 — Жёсткий 90-секундный таймаут реестра бросает exec-команды, которые ещё выполняются {#work8-019}

**Серьёзность:** medium · **Категория:** reliability

`ToolRegistry` (`src/agent/tools/registry.ts:283-299`) обрывает любой инструмент через `TOOL_EXECUTION_TIMEOUT_MS = 90_000`, тогда как `exec.limits.timeout` по умолчанию 120 с (`src/config/schema.ts:793`). Агент получает ошибку, а команда продолжает работу и её побочные эффекты наступают позже. Подтверждено `experiments/audit8/repro-agent-4.test.ts`.

См. [шаблон задачи](issues/WORK8-019-registry-tool-timeout-abandons-exec.md).

### WORK8-020 — Старт TON Proxy посылает SIGTERM любому процессу на порту (по умолчанию 8080) и устаревшему PID {#work8-020}

**Серьёзность:** medium · **Категория:** reliability

`killOrphan` (`src/ton-proxy/manager.ts:189-231`, вызов на `:264`) убивает процесс, занимающий порт, или PID из файла, не проверяя, что это бинарь прокси. Порт 8080 по умолчанию (`src/config/schema.ts:507`) часто занят другими сервисами. Только чтение кода.

См. [шаблон задачи](issues/WORK8-020-ton-proxy-kills-foreign-process-on-port.md).

### WORK8-021 — Групповые команды вида `/cmd@botname` не распознаются {#work8-021}

**Серьёзность:** medium · **Категория:** correctness

`parseCommand` (`src/telegram/admin.ts:98-99`) берёт `status@my_bot` как имя команды, и `switch` на `:123` уходит в «Unknown command». Подтверждено `experiments/audit8/repro-telegram-1.sh`.

См. [шаблон задачи](issues/WORK8-021-group-command-at-botname-not-recognised.md).

### WORK8-022 — Вложенный withFloodRetry в user-mode sendMessage умножает число попыток (9 вместо 3) {#work8-022}

**Серьёзность:** medium · **Категория:** reliability

`src/telegram/bridges/user.ts:125-134` оборачивает в `withFloodRetry` вызов `client.sendMessage`, который уже сам обёрнут (`src/telegram/client.ts:511`). Получается до 9 попыток и до ~16 минут блокировки на одно сообщение. Подтверждено `experiments/audit8/repro-telegram-1.sh`.

См. [шаблон задачи](issues/WORK8-022-nested-flood-retry-multiplies-attempts.md).

### WORK8-023 — Проверка оплаты просматривает только 20 последних транзакций — спам скрывает реальный платёж {#work8-023}

**Серьёзность:** low · **Категория:** reliability

`src/ton/payment-verifier.ts:78` и `src/sdk/ton.ts:383` запрашивают одну страницу из 20 транзакций без пагинации. Пыль или обычный трафик вытесняют платёж, сделка истекает (120 с, `src/deals/config.ts:12`). Только чтение кода.

См. [шаблон задачи](issues/WORK8-023-payment-verifier-scans-only-20-transactions.md).

### WORK8-024 — resetSession сохраняет счётчики токенов старой сессии {#work8-024}

**Серьёзность:** low · **Категория:** correctness

UPDATE в `resetSession` (`src/session/store.ts:271-276`) меняет id и `message_count`, но не обнуляет `input_tokens`/`output_tokens`; рантайм (`src/agent/runtime.ts:1574-1579`) продолжает их накапливать, и новая сессия наследует устаревшую статистику.

См. [шаблон задачи](issues/WORK8-024-reset-session-keeps-token-counters.md).

### WORK8-025 — mentionsMe в bot-режиме срабатывает на команды другим ботам и на похожие username {#work8-025}

**Серьёзность:** low · **Категория:** correctness

`src/telegram/bridges/bot.ts:418-427`: любая сущность `bot_command` (включая `/start@other_bot`) и подстрока `@botname` (включая `@botname_fan`) выставляют `mentionsMe`, обходя `require_mention`. Только чтение кода (grammy не установлен).

См. [шаблон задачи](issues/WORK8-025-bot-mentions-me-other-bot-commands.md).

### WORK8-026 — splitMessageForTelegram при жёстком разрезе разбивает суррогатные пары UTF-16 {#work8-026}

**Серьёзность:** low · **Категория:** correctness

Финальный `return maxLength` (`src/telegram/message-splitter.ts:83-84`) режет по сырому индексу UTF-16 и оставляет одиночные суррогаты (эмодзи, редкие CJK). Подтверждено `experiments/audit8/repro-telegram-1.sh`.

См. [шаблон задачи](issues/WORK8-026-message-splitter-breaks-surrogate-pairs.md).

### WORK8-027 — В корне репозитория отслеживаются временные артефакты автоматизации, включая деструктивный скрипт auto-commit/push {#work8-027}

**Серьёзность:** low · **Категория:** repo-hygiene

`APPLY_LOG.txt`, `DUMP.txt`, `CR_SNAPSHOT.txt`, `commit_and_push.sh`, `run_pipeline.sh` и др. раскрывают пути бота и содержат скрипт, выполняющий коммит и push. Гигиена репозитория.

См. [шаблон задачи](issues/WORK8-027-tracked-scratch-artifacts-repo-root.md).

## 5. Этапы реализации (рекомендация)

**Этап 1 — высокая серьёзность: безопасность и финансы (блокеры v3.0).**
WORK8-001, WORK8-002, WORK8-003, WORK8-004, WORK8-005, WORK8-006, WORK8-007, WORK8-008. Сначала финансовые риски (WORK8-001) и удалённо
эксплуатируемые уязвимости (WORK8-002..006), затем целостность данных (WORK8-007) и
потеря сообщений (WORK8-008).

**Этап 2 — средняя серьёзность.**
WORK8-009, WORK8-010, WORK8-011, WORK8-012, WORK8-013, WORK8-014, WORK8-015, WORK8-016, WORK8-017, WORK8-018, WORK8-019, WORK8-020, WORK8-021, WORK8-022. Приоритет — финансовая точность (WORK8-009, WORK8-010) и
безопасность развёртывания (WORK8-011..013), затем надёжность сервисов и рантайма.

**Этап 3 — низкая серьёзность и гигиена.**
WORK8-023, WORK8-024, WORK8-025, WORK8-026, WORK8-027.

## 6. Заметка о заведении задач

Все 27 находок заведены отдельными issue **[AUDIT/V8]** — **#740–#766** — скриптом
`validation/file-issues.mjs`; ссылки проставлены в поле `github-issue` каждого шаблона
и в индексе выше. Аккаунт автоматизации не имеет прав triage, поэтому
рекомендуемые метки и milestone указаны в подвале каждого issue. Структуру артефактов проверяет
`node improvements/work8/validation/check-artifacts.mjs`.
