# Анализ задачи #768

## План

- [x] Прочитать все 27 задач и обсуждения (обсуждения отсутствуют).
- [x] Проверить ветку, PR, contributing и связанные последние PR.
- [x] Добавить регрессии и подтвердить их падение на исходной версии.
- [x] Исправить все пути кода и проверить регрессии.
- [x] Выполнить typecheck, lint, format, tests, build; сохранять логи.
- [x] Проверить diff и синхронизацию main, подготовить изменения для PR.

Состояние проверок окончательного HEAD публикуется в [PR #769](https://github.com/xlabtg/teleton-agent/pull/769); перед переводом PR в ready проверяются все текущие CI runs.

## Требования и решения

### #740: [AUDIT/V8] One received gift can verify any number of deals (no gift msgId reuse protection), so the agent pays out more than once

- [x] A gift msgId can move at most one deal to `verified`, in both the tool path and the poller path.
- [x] The DB rejects a second deal row with the same `user_payment_gift_msgid`.

План решения: Единый атомарный захват gift msgId и уникальный индекс; фильтрация в tool и poller.

### #741: [AUDIT/V8] Setup server accepts cross-site / DNS-rebinding requests that overwrite the wallet and set owner/admin config

- [x] Mutating setup routes reject foreign Origin, foreign Host, and non-JSON Content-Type with 403/415.
- [x] The legitimate setup UI flow still works.
- [x] `/v1/setup/wallet/*` cannot overwrite an existing wallet without an explicit override.

План решения: Проверка Host/Origin/JSON; запрет неявной перезаписи существующего кошелька.

### #742: [AUDIT/V8] Inbound webhook signature reuses the outbound HMAC: reflection, replay, and arbitrary internal event injection with fan-out

- [x] An outbound delivery cannot be accepted as an inbound request.
- [x] Stale or replayed requests are rejected.
- [x] Inbound requests cannot publish reserved internal event types.
- [x] No webhook delivery loop is possible.

План решения: Отдельный inbound HMAC с timestamp, постоянная защита от replay и изолированный тип события.

### #743: [AUDIT/V8] web_download_binary SSRF guard is bypassed by every IPv6 literal and by redirects to private hosts

- [x] No request reaches a private, loopback or link-local address, whether the address comes from an IPv6 literal, a DNS name or a redirect.

План решения: Повторное использование DNS-aware SSRF guard с ручными redirect и закреплением DNS.

### #744: [AUDIT/V8] Managed-agent edits write the parent's environment-variable secrets and identity into the child's config.yaml

- [x] Parent env vars never leak into managed-agent config files or child process environments, unless explicitly mapped.

План решения: Чтение конфигурации без env; очищенное окружение дочернего процесса.

### #745: [AUDIT/V8] CI runs untrusted fork-PR code under `pull_request_target` in jobs that hold VERCEL_TOKEN / CODECOV_TOKEN (\"pwn request\")

- [x] No workflow runs PR-head code in a context where `secrets.*` are available.
- [x] The zizmor "dangerous-triggers" check is clean.

План решения: pull_request вместо pull_request_target; секреты только для доверенного push, статическая проверка.

### #746: [AUDIT/V8] Backup restore overwrites `memory.db` but leaves stale `-wal`/`-shm` sidecars, so SQLite replays old WAL frames over the restored database

- [x] After `restoreBackup`, no `-wal`/`-shm`/`-journal` sidecar from before the restore exists for any restored SQLite file, and reopening returns exactly the backup contents.

План решения: Атомарная замена SQLite и очистка WAL/SHM/journal.

### #747: [AUDIT/V8] Ordinary messages starting with `.`, `!` or `/` are treated as admin commands and silently dropped (or answered with \"Admin access required\")

- [x] Messages that are not a known command reach the agent whatever their first character.
- [x] Known commands keep their current access control.

План решения: Распознавание только известных команд.

### #748: [AUDIT/V8] `toUnits()` uses `Number.toFixed(decimals)`, which gives wrong on-chain amounts for 18-decimal jettons and large amounts, and throws for amounts of 1e21 or more

- [x] `toUnits(x, d)` equals the exact decimal value of `String(x)` scaled by 10^d, truncated, for d from 0 to 255.
- [x] No throw for amounts written in exponent form.
- [x] Only one implementation remains.

План решения: Единственный decimal converter с exponent и truncation; без toFixed.

### #749: [AUDIT/V8] On-chain confirmation window (20 s) is shorter than the wallet message validity (about 60 s): a transfer reported as \"failed\" can still land, which leads to double payouts

- [x] Every wallet transfer carries an explicit `timeout`.
- [x] `confirmWalletTx` never gives up before that `valid_until` has passed.

План решения: Явный valid_until, подтверждение после окна валидности; неопределённость не выдаётся за отказ.

### #750: [AUDIT/V8] Non-admins can trigger the `[ADMIN TASK]` and `/boot` prompts when command access is opened

- [x] Only `admin_ids` can produce `[ADMIN TASK]` or bootstrap prompts.

План решения: Проверка admin для boot/task и JSON-кодирование текста.

### #751: [AUDIT/V8] compose.yaml publishes the WebUI (full agent control, wallet) on all host interfaces by default

- [x] By default the WebUI is reachable only from the host's loopback interface.

План решения: Loopback bind Compose и документированный opt-in.

### #752: [AUDIT/V8] install.sh installs the upstream TONresistor repo/image instead of this fork, and refuses fork clones

- [x] The installer's clone URL, docker image, and package metadata all name `xlabtg/teleton-agent`.
- [x] An existing xlabtg clone updates without error.

План решения: Единые fork URLs установщика и метаданных.

### #753: [AUDIT/V8] NVIDIA model catalog no longer contains the provider's default model `z-ai/glm-5.1` (catalog/default/test drift after fd9ac870)

- [x] The default and utility models appear in the catalog for every provider.
- [x] The GLM workarounds apply to every GLM entry in the catalog.
- [x] The NVIDIA provider tests pass.

План решения: Проверка уже внесённого исправления и общего GLM workaround.

### #754: [AUDIT/V8] `AuditTrailService.pruneBefore` makes `verifyIntegrity` report tampering on an untampered log

- [x] After a prune, verification still passes on an untouched log, and real tampering of the surviving rows (including the first one) is still detected.

План решения: Постоянный anchor цепочки, удаление только префикса в транзакции.

### #755: [AUDIT/V8] Webhook retries are lost on restart (rows stuck in `retrying` forever)

- [x] After a restart, due retries are attempted, and future retries are scheduled at their persisted time.

План решения: Восстановление persistent retry при запуске.

### #756: [AUDIT/V8] Marketplace `updatePlugin` uninstalls before installing; a failed download deletes the plugin

- [x] A failed update leaves the previously installed version on disk and registered.
- [x] A successful update replaces it atomically.

План решения: Staging, backup/swap и rollback регистрации.

### #757: [AUDIT/V8] Pipeline \"primary\" steps run the agent without toolContext: tool calls are dropped and the step is marked \"completed\" with an internal-error string

- [x] Primary pipeline steps can execute permitted tools, and an agent-loop failure marks the step `failed`.

План решения: ToolContext для primary pipeline; исключение при agent-loop failure.

### #758: [AUDIT/V8] The registry's hard 90s tool timeout abandons exec commands that are still running (exec default limit is 120s), so the agent is told the command failed while it keeps running

- [x] The configured exec timeout is honored end to end, and no tool keeps running after the registry has reported it as failed.

План решения: Exec timeout без раннего registry race; AbortSignal для отменяемых инструментов.

### #759: [AUDIT/V8] TON Proxy start sends SIGTERM to whatever process listens on the configured port (default 8080) and to a stale, possibly reused PID

- [x] No signal is ever sent to a process that is not the managed proxy binary.
- [x] Start fails cleanly when the port is taken.

План решения: Не посылать сигналы orphan PID; отказ при занятом порте.

### #760: [AUDIT/V8] Group commands in the `/cmd@botname` form are not recognised

- [x] `/cmd@ownbot` behaves the same as `/cmd`.
- [x] Commands addressed to other bots are ignored.

План решения: Разбор собственного @bot suffix, игнорирование чужого.

### #761: [AUDIT/V8] Nested `withFloodRetry` in user-mode `sendMessage` multiplies retries (9 attempts, up to ~16 minutes of blocking per message)

- [x] One logical send makes at most `maxRetries+1` API attempts.

План решения: Единственный retry budget для вложенных вызовов.

### #762: [AUDIT/V8] Payment verification scans only the latest 20 wallet transactions: cheap dust spam (or normal traffic) hides a real payment and the deal expires

- [x] A matching payment inside the time window is found no matter how many other transactions arrived after it, up to the documented cap.

План решения: Пагинация обеих проверок до requestTime с ограничением 200.

### #763: [AUDIT/V8] `resetSession` keeps the old session's accumulated input/output token counters, so the new session id inherits stale usage

- [x] After `resetSession`/`resetSessionWithPolicy`, `getSession` reports 0 input and output tokens for the new session id.

План решения: Обнуление session usage/context при reset.

### #764: [AUDIT/V8] Bot-mode `mentionsMe` is true for commands addressed to other bots and for usernames that start with the bot's name

- [x] Only commands and mentions aimed at this bot set `mentionsMe`.

План решения: Точный username и проверка адресата bot_command.

### #765: [AUDIT/V8] `splitMessageForTelegram` hard cut splits UTF-16 surrogate pairs (emoji, rare CJK)

- [x] Splitting never separates a surrogate pair.

План решения: Граница Unicode code point, включая maxLength=1.

### #766: [AUDIT/V8] Tracked scratch/automation artefacts in repo root leak bot paths and include a destructive auto-commit/push script

- [x] None of the listed files are tracked.
- [x] Вне `experiments/` отсутствуют пути временных рабочих копий автоматизации.

План решения: Удаление scratch-файлов, ignore и CI denylist.

## Альтернативы и готовые компоненты

Используем существующие Hono middleware, better-sqlite3 transactions, Node crypto/AbortController, undici dispatcher и общий SSRF guard репозитория. Это позволяет обойтись без новой runtime-зависимости. Для дробных чисел альтернативы decimal.js/big.js; здесь достаточно ограниченного decimal-to-bigint преобразования без арифметики. Для очереди webhook возможны BullMQ/Redis, но уже имеется SQLite delivery journal. Для CI подходят zizmor (security) и actionlint (syntax); добавляем repository policy test. Для Unicode подходит Intl.Segmenter, но требуется сохранять только пары суррогатов, поэтому используется code-point boundary.

Источники: [GitHub Security Lab](https://securitylab.github.com/resources/github-actions-preventing-pwn-requests/), [GitHub Actions security](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target), [SQLite WAL](https://www.sqlite.org/wal.html), [TON wallet validity](https://docs-next.ton.org/contracts/standard/wallets/how-it-works).


## Проверка всех путей и альтернативы по каждому требованию

| Задача | Причина и охват изменения | Альтернатива и выбранная последовательность | Регрессия |
| --- | --- | --- | --- |
| #740 | Tool и poller независимо принимали один подарок; DB не обеспечивала уникальность. | Отдельный receipt ledger тоже подходит. Выбран уникальный partial index существующего поля: фильтр → атомарный conditional UPDATE → payout. | `deals/gift-claim`: обе допустимые стадии, повторный claim и constraint. |
| #741 | CORS не препятствовал выполнению POST, Host не проверялся. | Одноразовый setup token потребовал бы изменения UI. Выбраны ранние Host/Origin/JSON проверки и явный `overwrite`. | `setup-server-launch`: cross-site, rebinding, content type, штатный launch, existing wallet. |
| #742 | Одинаковые HMAC домены и caller-controlled event type. | Отдельный секрет inbound допустим; выбран domain prefix плюс timestamp и SQLite replay receipts. Затем фиксированный event type и запрет fan-out. | `webhook-dispatcher`, `events-routes`, `public-ingress-middleware`: reflection, stale, replay, reserved type, no loop. |
| #743 | Literal-only guard и автоматические redirect обходили проверку. | Egress proxy возможен при deployment. В приложении используем общий guard → DNS всех адресов → pinned undici dispatcher → ручные redirects до 5 → cleanup. | `download-binary`: IPv6, DNS private, redirect, pinning, credentials crossing origin. |
| #744 | `loadConfig` добавлял env до сохранения child YAML; spawn копировал весь env. | Explicit child env mapping возможен позже. Выбраны `readConfigFile` во всех managed-agent edit/read путях и allowlist OS env. | `agents/service`: parent key/phone не попадают в child file/env. |
| #745 | PR-head checkout выполнялся в privileged trigger; отдельный `workflow_run` тоже опасен. | Две фазы artifact deployment возможны, но PR preview с секретами не нужен. Выбраны `pull_request`, trusted-main deployment и release notification внутри release workflow. | `deployment-policy`; zizmor `dangerous-triggers` по всем workflows. |
| #746 | SQLite WAL принадлежал прежней DB и перекрывал snapshot. | SQLite backup API на открытой DB требует координации процесса. Restore выполняется offline: temp file → удаление всех sidecars → rename. | `backup`: настоящий stale WAL с изменённым значением, reopen показывает backup. |
| #747 | Любой префикс `/`, `!`, `.` считался командой. | Отдельный router возможен; проще распознавать только существующий whitelist до access control. | `command-access`: неизвестные и обычные пунктуационные сообщения доходят до агента. |
| #748 | `toFixed` округлял, ограничивал decimals и ломал exponent. | decimal.js/big.js решают общую арифметику; для scaling достаточно String-number exponent parser + BigInt. Все три копии сведены к одной. | `units`: 0–255 decimals, exponent, 18 decimals, negative/truncation. |
| #749 | Confirmation заканчивался раньше wallet validity; timeout трактовался как failure. | Durable transaction reconciliation queue полезна отдельно. Здесь explicit validity → ожидание до expiry с indexing margin → confirmed rejection или pending exception; deal сохраняет payout lock. Оба DeDust пути собирают сообщения через Sender adapter и отправляют тем же helper. | `confirm-window`, `confirm`, `transfer`, `wallet-sender`: inclusion после 25 s, broadcast error, unresolved expiry. |
| #750 | Open command access давал доступ к privileged prompt. | Раздельные command roles возможны; добавлена независимая admin проверка непосредственно перед boot/task prompt, task текст JSON encoded. | `command-access`: non-admin запрещён даже при open access. |
| #751 | Compose port shorthand публиковал все interfaces. | Reverse proxy с auth подходит для remote access. Default 127.0.0.1; explicit `TELETON_WEBUI_BIND` для opt-in, согласованы docker инструкции. | `deployment-policy`: default bind. |
| #752 | Installer и metadata оставались upstream. | Настраиваемый fork URL не требуется. Исправлены clone/update/image URL, обе package metadata, CLI banner, quick-start/deployment инструкции и исходник/страницы SDK документации. | `deployment-policy`: installer/package URLs. |
| #753 | Каталог и provider defaults расходились; GLM workaround привязан к одной версии. | Runtime discovery API может дополнять каталог, но не гарантирует configured default. Каталог автоматически включает metadata default/utility; все GLM-5 entries используют общую compat/empty-response обработку. | `nvidia-model`, `nvidia-provider`: каждый provider, каждая GLM entry и recovery. |
| #754 | Prune удалял predecessor; FK SET NULL изменял hashed payload. | Пересчёт цепочки уничтожил бы исходное доказательство. Выбран persist anchor + contiguous prefix pruning в транзакции; hashed parent ID сохраняется. | `audit-trail`: first retained row tampering, FK boundary, whole-log pruning и продолжение sequence. |
| #755 | Retry существовал только в timer memory. | BullMQ даёт durable queue, но требует Redis. SQLite journal уже имеется: загрузить pending/retrying при start, due сразу, future по persisted timestamp. | `webhook-dispatcher`: stop/start и fake-clock due/future. |
| #756 | Update сначала удалял рабочую версию. | Versioned directories с pointer switch — более широкая переработка loader. Выбран staging → validation → backup/swap → import installed path → migrate/register/start → rollback при ошибке. | `marketplace-update`: download failure, start failure, successful replacement. |
| #757 | Pipeline primary не передавал tool context; error превращался в completed text. | Унифицированный agent execution facade возможен позже. Pipeline передаёт live bridge/config/db/memory/signal; structured runtime error или исключение завершает step как failed. | `pipeline/executor`, `pipelines-routes`: permitted tool context и loop failure. |
| #758 | Promise.race отбрасывал ещё работающий executor. | Worker isolation возможна для untrusted tools. Exec владеет timeout; registry ждёт settlement, остальные получают AbortSignal, MCP native cancellation; process group kill ждёт close. | `registry`, `exec/runner`, `mcp-loader`: 100 s exec, cooperative abort и process close. |
| #759 | PID file и порт считались доказательством ownership. | Проверка `/proc` platform-specific и имеет PID reuse race. Удаляем stale PID без signal, проверяем port, только собственный child может быть остановлен. | `ton-proxy/manager-port`: реальный занятый port, zero process.kill; сохранён прежний install suite. |
| #760 | Parser не отделял @bot suffix. | Telegram entities тоже можно использовать; whitelist parser принимает только own username case-insensitive и игнорирует foreign suffix. | `command-access`: own/foreign bot команды. |
| #761 | Вложенный wrapper создавал новый retry budget. | Перенос retries только в transport требует массовой переработки. Exhausted error marker предотвращает повторный бюджет во внешнем wrapper. | `flood-retry`: вложенный вызов делает ровно 3 API attempts. |
| #762 | Две проверки читали одну короткую страницу. | Indexer API помогает при больших историях. Общий reader пагинирует lt/hash, dedup, finite page cap, request/age window; core и SDK используют до 200 transactions. | `transaction-history`, `payment-verifier`, `sdk/ton`: payment за 20 dust transfers, cursor и bounded scans. |
| #763 | Reset менял ID, сохраняя usage и context. | Отдельная session history table возможна позже. Единый reset очищает usage/context/last message; policy reset делегирует ему. | `session/store`: новый ID и нулевые counters. |
| #764 | Prefix match совпадал с чужими usernames/commands. | Entity-only mention routing изменил бы поддержку plain text. Добавлены точные username boundaries и command target match. | `bot-bridge-html-split`: own/foreign mentions и похожие username. |
| #765 | UTF-16 hard cut делил пару суррогатов. | Intl.Segmenter сохранял бы grapheme clusters, но требование касается code points. Plain и HTML cut отступают от high surrogate; для limit=1 минимальная неделимая пара имеет длину 2. | `message-splitter`, `html-splitter`: emoji у границы и после HTML entity, обычный текст при limit=1. |
| #766 | Root содержал scratch dump и destructive automation scripts. | Исторические commits сохраняем, текущие tracked файлы удаляем. Добавлены gitignore/dockerignore и denylist regression. | `deployment-policy`: все перечисленные artefacts отсутствуют. |

## Дополнительные результаты исследования

На странице [NVIDIA GLM 5.3](https://build.nvidia.com/z-ai/glm-5-3?section=deploy) пример API использует `z-ai/glm-5.3`, а не slug страницы `z-ai/glm-5-3`. Аналогично исправлен Flash; ранее сохранённые slug IDs нормализуются при model resolution. Автоматический тест default/utility выявил ещё семь каталогов с пропусками: OpenAI, Google, xAI, Moonshot, Mistral, MiniMax и Hugging Face; они исправлены общим правилом без смены настроенных defaults. Полная проверка без исключения пустых каталогов дополнительно охватывает Claude Code и Local (`auto`).

Готовые компоненты: [decimal.js](https://github.com/MikeMcl/decimal.js), [big.js](https://github.com/MikeMcl/big.js), [BullMQ](https://docs.bullmq.io/), [zizmor](https://docs.zizmor.sh/usage/), [actionlint](https://github.com/rhysd/actionlint). Дополнительные runtime зависимости не требуются: Node crypto/AbortController, undici, Hono и better-sqlite3 уже используются проектом. Zizmor добавлен только в security CI. Проверяется именно `dangerous-triggers`; остальные прежние замечания, например unpinned actions, не входят в этот acceptance criterion.

## Воспроизведение и эксплуатационные изменения

`bash experiments/issue-768/reproduce-baseline.sh` запускает минимальные регрессии против commit `37609581` в отдельной временной копии и удаляет её после завершения. На исходной версии с окончательным набором минимальных регрессий получено 49 падающих и 94 проходящих проверки; ожидаемый exit code этого прогона — 1. Семь дополнительных provider-default regressions отдельно падали до исправления каталога. Полный набор текущей версии запускается `npm run test:coverage`.

- Inbound webhook теперь требует `X-Webhook-Timestamp` и новую domain-separated подпись; подробности в [webhook-inbound-signing.md](webhook-inbound-signing.md). Outbound wire format сохраняется.
- Исторические duplicate gift IDs требуют ручного reconciliation; миграция явно отказывает и не удаляет финансовые данные.
- Unconfirmed TON transfer — pending, требует reconciliation перед повторной отправкой; deal payout lock остаётся установленным.
- Audit retention удаляет только непрерывный prefix. Parent IDs за границей retention сохраняются как historical references, поскольку входят в checksum; они могут указывать на уже удалённые записи.
- Marketplace сохраняет предыдущие файлы/регистрацию при failure. Успешная DB migration, после которой падает plugin start, не откатывается: migration должна поддерживать прежнюю версию. Если восстановление directory само не удалось, backup сохраняется для recovery.
- Registry ожидает завершения executor и не заявляет failure, пока tool продолжает побочные эффекты. Некоперативный сторонний tool может завершаться дольше deadline; жёсткая изоляция такого plugin не входит в эту задачу.
- Backup restore требует остановленного агента, как существующая CLI процедура; atomic rename не предназначен для замены DB с активными writer connections.

## Результаты локальной проверки

- Vitest coverage: **270 файлов, 3917 тестов — все прошли**. Statements 52.87%, branches 45.33%, functions 59.66%, lines 53.88%; все repository thresholds выполнены.
- TypeScript, ESLint, Prettier, knip и circular dependency check прошли.
- Полная сборка SDK/backend/WebUI, WebUI typecheck и i18n проверены.
- OpenAPI regeneration не изменяет spec; OpenAPI lint проходит с тремя прежними warnings. SEO tests: 47 passed.
- `audit:ci` проходит с действующим repository allowlist. Compose config и Helm lint/templates проходят.
- Zizmor 1.30.1: **0 dangerous-triggers** во всех workflows. Другие прежние категории findings не входят в этот criterion.
- Для контейнера с ограниченной памятью тяжёлые проверки запускались последовательно, Vitest — с `--maxWorkers=2`.
