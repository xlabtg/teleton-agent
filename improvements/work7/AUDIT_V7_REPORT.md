# Teleton Agent — Full Logic Audit V7 (Issue #689)

**Source issue:** [#689](https://github.com/xlabtg/teleton-agent/issues/689) ·
**PR:** [#690](https://github.com/xlabtg/teleton-agent/pull/690) ·
**Branch:** `issue-689-d289e747e6ff`

**Compared base (`main`):** `af252b67` (release 0.8.55) · **Auditor:** Claude
Opus 4.8 (Claude Code).

## 1. Executive Summary

Issue #689 asked for a thorough, end-to-end review of the application logic so
that every flaw, bug, and vulnerability could be filed as a separate,
professional issue with labels and implementation stages, allowing the team to
fix them step by step.

This audit fanned out across the whole tree — memory/RAG storage (FTS5 triggers,
hybrid scoring, re-embedding, tool index), autonomous/financial safety (TON
policy budgets, wallet tx-lock, jetton decimals), agent tooling (result
truncation, workspace permissions), the Telegram bot bridge and message
formatting, services (integration providers, workflow scheduler, managed-agent
runtime), the WebUI backend (lifecycle SSE), the gocoon wallet CLI, the
prompt-injection sanitizer, and the React frontend (Config, Security, Network,
Events, Pipelines) — and then **adversarially verified each candidate against the
exact source** before filing. It builds on the prior audit waves in
`improvements/work`..`work6`, and deliberately avoids re-filing findings already
captured there.

**22 findings** are confirmed against the current source, each with its own
professional issue template in [`issues/`](issues/) and filed upstream as a
separate issue. The set is intentionally *new* — every prior-wave finding and the
existing backlog were treated as a duplicate baseline. This wave introduces a
new **financial-safety** category alongside security / data-integrity /
reliability.

The highest-leverage findings are:

- **WORK7-003** — the autonomous policy engine declares a `daily` TON budget
  (default `0.5`) but **never enforces it**: the budget check only compares a
  single action against `perTask`, and no cumulative daily spend is tracked, so
  an autonomous run can drain the wallet across many sub-limit actions.
- **WORK7-004** — `withTxLock` releases the wallet mutex on its 60s
  `Promise.race` timeout **while the transaction may still be in-flight**,
  letting the next queued send read the same seqno → seqno reuse / double-send.
- **WORK7-001 / WORK7-002** — the `knowledge_fts` and `tool_index_fts` FTS5
  **external-content** indexes are maintained with a plain `DELETE FROM …_fts
  WHERE rowid` in their triggers (and `tool_index` upserts with `INSERT OR
  REPLACE` on a `TEXT PRIMARY KEY`), the exact corruption pattern fixed for
  `tg_messages` in WORK6-003 but still present on these two indexes.

### Severity breakdown

| Severity | Count | IDs                                                                       |
| -------- | ----- | ------------------------------------------------------------------------- |
| High     | 5     | WORK7-001, -002, -003, -004, -005                                         |
| Medium   | 14    | WORK7-006, -007, -008, -009, -010, -011, -012, -013, -014, -015, -016, -017, -018, -022 |
| Low      | 3     | WORK7-019, -020, -021                                                     |

### Category breakdown

| Category         | IDs                                                                 |
| ---------------- | ------------------------------------------------------------------- |
| data-integrity   | 001, 002, 007, 008                                                  |
| financial-safety | 003, 004, 010                                                       |
| security         | 006, 015, 022                                                       |
| reliability      | 005, 009, 011, 012, 013, 014, 016, 017, 018, 019, 020, 021          |

## 2. Method

- Read issue #689 and the prior audit folders (`improvements/work`..`work6`) plus
  the closed audit issues/PRs to build a duplicate baseline (~119
  previously-filed findings across #252–#623).
- Decomposed the system into subsystem lanes and reviewed each in parallel,
  producing a candidate list of ~25+ observations.
- **Adversarially verified** every reported candidate against the exact file and
  line on the current branch (base `main` = `af252b67`, release 0.8.55),
  discarding false positives, duplicates, and already-fixed items. Notable
  discards/narrowings:
  - DeDust **`asset?.decimals ?? 9`** was flagged as breaking 0-decimal jettons
    but is **correct** — `??` preserves `0`; only `||` is buggy. Discarded. The
    genuine variant is `jetton-send.ts:104` (`decimals || 9`), kept as WORK7-010.
  - `tg_messages` re-embedding, feed retention, and the frontend stale-response
    class were already filed in WORK6 (WORK6-003/-011/-013) and are not
    re-filed; WORK7-008 covers the distinct *stale-vector-on-empty-reembed*
    gap, and WORK7-019/-020 cover distinct frontend pages/handlers.
- Recorded reproduction steps, a regression test, and acceptance criteria per
  confirmed finding.

## 3. Findings index

| ID        | Severity | Category         | Summary                                                                        | Task file | GitHub |
| --------- | -------- | ---------------- | ------------------------------------------------------------------------------ | --------- | ------ |
| WORK7-001 | High     | data-integrity   | `knowledge_fts`/`tool_index_fts` triggers use a plain DELETE on external-content | [file](issues/WORK7-001-fts5-delete-triggers-plain-delete.md) | [#691](https://github.com/xlabtg/teleton-agent/issues/691) |
| WORK7-002 | High     | data-integrity   | `tool_index` INSERT OR REPLACE reassigns rowid and desyncs its FTS index         | [file](issues/WORK7-002-tool-index-insert-or-replace-rowid-churn.md) | [#692](https://github.com/xlabtg/teleton-agent/issues/692) |
| WORK7-003 | High     | financial-safety | Policy engine never enforces the daily TON budget (only per-task)                | [file](issues/WORK7-003-policy-engine-daily-ton-budget-never-enforced.md) | [#693](https://github.com/xlabtg/teleton-agent/issues/693) |
| WORK7-004 | High     | financial-safety | `withTxLock` releases the wallet mutex on timeout while the tx is in-flight       | [file](issues/WORK7-004-tx-lock-releases-mutex-on-timeout.md) | [#694](https://github.com/xlabtg/teleton-agent/issues/694) |
| WORK7-005 | High     | reliability      | `markdownToTelegramHtml` corrupts messages via `$` replacement patterns          | [file](issues/WORK7-005-markdown-placeholder-dollar-replacement-corruption.md) | [#695](https://github.com/xlabtg/teleton-agent/issues/695) |
| WORK7-006 | Medium   | security         | HTTP integration provider fetches caller URLs with no SSRF guard                 | [file](issues/WORK7-006-integration-provider-read-ssrf.md) | [#696](https://github.com/xlabtg/teleton-agent/issues/696) |
| WORK7-007 | Medium   | data-integrity   | Hybrid search leaves vector-only results unweighted (over-ranked)                | [file](issues/WORK7-007-hybrid-search-vector-only-score-unweighted.md) | [#697](https://github.com/xlabtg/teleton-agent/issues/697) |
| WORK7-008 | Medium   | data-integrity   | Empty re-embedding leaves the stale `tg_messages_vec` row in place               | [file](issues/WORK7-008-stale-message-vector-on-failed-reembed.md) | [#698](https://github.com/xlabtg/teleton-agent/issues/698) |
| WORK7-009 | Medium   | reliability      | `truncateToolResult` can still return a payload larger than `maxSize`            | [file](issues/WORK7-009-tool-result-truncator-cap-not-guaranteed.md) | [#699](https://github.com/xlabtg/teleton-agent/issues/699) |
| WORK7-010 | Medium   | financial-safety | `jetton_send` uses `decimals || 9`, mis-scaling 0-decimal jettons                | [file](issues/WORK7-010-jetton-send-zero-decimals.md) | [#700](https://github.com/xlabtg/teleton-agent/issues/700) |
| WORK7-011 | Medium   | reliability      | Event/webhook workflow triggers bypass the cron dedup/concurrency guard          | [file](issues/WORK7-011-workflow-event-webhook-bypass-dedup.md) | [#701](https://github.com/xlabtg/teleton-agent/issues/701) |
| WORK7-012 | Medium   | reliability      | Managed-agent inbox/results grow unbounded, rewritten per message (O(n²))         | [file](issues/WORK7-012-managed-agent-inbox-unbounded.md) | [#702](https://github.com/xlabtg/teleton-agent/issues/702) |
| WORK7-013 | Medium   | reliability      | `restartCount` never reset after recovery (permanent "degraded", cap exhausted)  | [file](issues/WORK7-013-managed-agent-restart-count-never-reset.md) | [#703](https://github.com/xlabtg/teleton-agent/issues/703) |
| WORK7-014 | Medium   | reliability      | Lifecycle SSE leaks its `stateChange` listener on a write error (no try/finally)  | [file](issues/WORK7-014-lifecycle-sse-listener-leak.md) | [#704](https://github.com/xlabtg/teleton-agent/issues/704) |
| WORK7-015 | Medium   | security         | `workspace_write` creates files `0o666` (inconsistent with the `0o600` append)    | [file](issues/WORK7-015-workspace-write-world-readable-files.md) | [#705](https://github.com/xlabtg/teleton-agent/issues/705) |
| WORK7-016 | Medium   | reliability      | Saving one config key reloads all inputs, discarding unsaved edits               | [file](issues/WORK7-016-config-save-clobbers-unsaved-edits.md) | [#706](https://github.com/xlabtg/teleton-agent/issues/706) |
| WORK7-017 | Medium   | reliability      | Security page `JSON.parse(approval.params)` at render crashes the whole page      | [file](issues/WORK7-017-security-approval-params-json-parse-render-crash.md) | [#707](https://github.com/xlabtg/teleton-agent/issues/707) |
| WORK7-018 | Medium   | reliability      | Bot bridge splits rendered HTML on whitespace → unbalanced tags Telegram rejects  | [file](issues/WORK7-018-bot-bridge-splits-html-mid-tag.md) | [#708](https://github.com/xlabtg/teleton-agent/issues/708) |
| WORK7-019 | Low      | reliability      | Network/Events mutations fire via `void`/`.then` with no catch (silent failure)   | [file](issues/WORK7-019-ui-mutations-swallow-promise-rejections.md) | [#709](https://github.com/xlabtg/teleton-agent/issues/709) |
| WORK7-020 | Low      | reliability      | Pipelines poll re-selects the newest run every 2s, yanking the user's selection   | [file](issues/WORK7-020-pipelines-poll-resets-selected-run.md) | [#710](https://github.com/xlabtg/teleton-agent/issues/710) |
| WORK7-021 | Low      | reliability      | `stripMarkupTags` over-consumes, deleting plain text after a tag                  | [file](issues/WORK7-021-strip-markup-tags-over-consumes-text.md) | [#711](https://github.com/xlabtg/teleton-agent/issues/711) |
| WORK7-022 | Medium   | security         | gocoon data dir holding `wallet.json` is created without `0o700`                  | [file](issues/WORK7-022-gocoon-data-dir-not-0700.md) | [#712](https://github.com/xlabtg/teleton-agent/issues/712) |

## 4. Findings detail

### WORK7-001 — FTS5 external-content delete/update triggers use plain DELETE {#work7-001}

`knowledge_fts` (`content='knowledge'`, `schema.ts:264`) and `tool_index_fts`
(`content='tool_index'`, `schema.ts:1291`) are FTS5 external-content indexes, but
their delete/update triggers run `DELETE FROM knowledge_fts WHERE rowid =
old.rowid` (`schema.ts:275,279`) and `DELETE FROM tool_index_fts WHERE rowid =
old.rowid` (`schema.ts:1301,1305`). The correct maintenance for external-content
tables is the `INSERT INTO fts(fts, rowid, …) VALUES('delete', …)` special
command (as `tg_messages_fts` uses). A plain DELETE leaves orphaned postings and
desyncs the index — the WORK6-003 class, still present here.
See [issue template](issues/WORK7-001-fts5-delete-triggers-plain-delete.md).

### WORK7-002 — tool_index INSERT OR REPLACE desyncs its FTS index {#work7-002}

`tool-index.ts:172` upserts with `INSERT OR REPLACE INTO tool_index (…)` while
`tool_index` has `name TEXT PRIMARY KEY` (separate rowid) feeding an
external-content FTS index (`schema.ts:1281-1282,1288-1308`). REPLACE deletes and
re-inserts the row with a **new rowid**, and with `recursive_triggers=off` the
delete trigger doesn't fire — orphaning FTS postings and skewing tool search.
See [issue template](issues/WORK7-002-tool-index-insert-or-replace-rowid-churn.md).

### WORK7-003 — Daily TON budget never enforced {#work7-003}

The autonomous policy config declares `tonSpending.daily` (default `0.5`,
`policy-engine.ts:19,41`) but the budget check
(`policy-engine.ts:302-320`) compares a single action only against
`constraints.budgetTON ?? this.config.tonSpending.perTask`. `daily` is read
nowhere and no cumulative spend is tracked, so an autonomous run can exceed the
daily cap across many sub-`perTask` actions.
See [issue template](issues/WORK7-003-policy-engine-daily-ton-budget-never-enforced.md).

### WORK7-004 — tx-lock releases the mutex on timeout {#work7-004}

`withTxLock` (`tx-lock.ts:8-27`) runs `Promise.race([fn(), timeoutPromise])` with
a 60s timeout and advances the queue on race settle
(`pending = execute.then(...)`). If a send exceeds 60s, the lock is released and
the next queued send runs **while the first tx is still in-flight**, reading a
stale seqno → seqno reuse / double-send.
See [issue template](issues/WORK7-004-tx-lock-releases-mutex-on-timeout.md).

### WORK7-005 — markdown HTML corruption via `$` replacement {#work7-005}

`markdownToTelegramHtml` (`formatting.ts`) re-inserts extracted code/blockquote
content with `html.replace(placeholder, content)`. `String.replace` interprets
`$&`, `$'`, `` $` ``, `$$` in the *replacement* string, and `escapeHtml` does not
escape `$`, so user content containing those patterns is corrupted on render.
See [issue template](issues/WORK7-005-markdown-placeholder-dollar-replacement-corruption.md).

### WORK7-006 — integration provider read SSRF {#work7-006}

The HTTP integration provider fetches `resolveUrl(actionConfig, params)` /
`healthCheckUrl` (`providers.ts:50-61,83-111,137-165`) via `fetchWithTimeout`
with only scheme (and optional same-origin) checks — no private/link-local/
metadata-IP guard — allowing SSRF to internal services.
See [issue template](issues/WORK7-006-integration-provider-read-ssrf.md).

### WORK7-007 — hybrid search leaves vector-only results unweighted {#work7-007}

`mergeResults` (`hybrid.ts:400-411`) seeds vector hits as `{ ...r, vectorScore:
r.score }` — keeping the raw `score` unweighted — while keyword-only hits get
`keywordWeight * keywordScore` and combined hits get the full weighted sum.
Vector-only results are therefore over-ranked relative to keyword-only ones.
See [issue template](issues/WORK7-007-hybrid-search-vector-only-score-unweighted.md).

### WORK7-008 — stale message vector on empty re-embed {#work7-008}

`upsertMessage` (`messages.ts:151-165`) guards the `DELETE`+`INSERT` of
`tg_messages_vec` behind `embedding.length > 0 && message.text`. When a message
is re-embedded and the provider returns an empty embedding, the stale vector row
survives, so search matches on outdated content.
See [issue template](issues/WORK7-008-stale-message-vector-on-failed-reembed.md).

### WORK7-009 — tool-result truncation cap not guaranteed {#work7-009}

`truncateToolResult` (`tool-result-truncator.ts:5-42`) short-circuits when
`length <= maxSize` then summarizes field-by-field, copying non-array / short
(`<= 500` char) values verbatim with **no final length check**, so an object with
many medium fields can still exceed `maxSize`.
See [issue template](issues/WORK7-009-tool-result-truncator-cap-not-guaranteed.md).

### WORK7-010 — jetton_send mishandles 0-decimal jettons {#work7-010}

`jetton-send.ts:104` computes `const decimals = jettonBalance.jetton.decimals ||
9;`. For a legitimate 0-decimal jetton, `0 || 9` yields `9`, so `toUnits`
(`:109`) scales the amount by `10^9` — sending a vastly wrong amount and
mis-reporting balance (`:113`). Should use `??`.
See [issue template](issues/WORK7-010-jetton-send-zero-decimals.md).

### WORK7-011 — event/webhook triggers bypass dedup {#work7-011}

The cron path guards on `runningWorkflowIds.has(...)` and `lastFiredBucket`
(`workflow-scheduler.ts:95-104`), but `fireEvent`/`handleWebhook`
(`:57-84`) call `execute` directly and `execute` (`:123-135`) only *adds* to
`runningWorkflowIds` without checking it — so bursts of the same event / repeated
webhook hits run overlapping duplicate executions.
See [issue template](issues/WORK7-011-workflow-event-webhook-bypass-dedup.md).

### WORK7-012 — managed-agent inbox unbounded {#work7-012}

Inter-agent `messages/inbox.json` / `messages/results.json`
(`agents/service.ts:1443,1447`) are whole-file JSON arrays that each delivery
reads, pushes to, and rewrites (`:974-978,898-902`) — O(n) per message, O(n²) per
session — with no cap or pruning, so they grow without bound.
See [issue template](issues/WORK7-012-managed-agent-inbox-unbounded.md).

### WORK7-013 — restartCount never reset {#work7-013}

`restartCount` is incremented per crash-restart (`agents/service.ts:617`) and
initialized to `0` only at creation (`:1376`), never reset after recovery. Health
reports "degraded" forever after the first crash (`:1439`), and `maxRestarts`
becomes a lifetime budget that sparse recovered crashes eventually exhaust.
See [issue template](issues/WORK7-013-managed-agent-restart-count-never-reset.md).

### WORK7-014 — lifecycle SSE listener leak {#work7-014}

`createLifecycleSSE` attaches `lifecycle.on("stateChange", …)`
(`lifecycle-sse.ts:44`) and only detaches it after the heartbeat loop (`:56`); a
throwing `writeSSE` (`:50`) skips the `off`, leaking a listener per abnormal
disconnect. The WORK6-009 class, on the lifecycle endpoint.
See [issue template](issues/WORK7-014-lifecycle-sse-listener-leak.md).

### WORK7-015 — workspace files created world-readable {#work7-015}

`safeWriteFileSync` (`validator.ts:292`) and the binary write path
(`write.ts:99`) open with `0o666` (→ `0o644` under umask 022), while the append
path (`write.ts:91`) uses `0o600`. New workspace files — potentially holding
secrets — are world/group-readable, inconsistently with the append path.
See [issue template](issues/WORK7-015-workspace-write-world-readable-files.md).

### WORK7-016 — config save discards unsaved edits {#work7-016}

`saveConfig` persists one key then calls `loadData()`, which overwrites the entire
`localInputs` map from the server (`useConfigState.ts:44-50,83-93`). Unsaved edits
in every other field are silently discarded.
See [issue template](issues/WORK7-016-config-save-clobbers-unsaved-edits.md).

### WORK7-017 — Security page render-time JSON.parse crash {#work7-017}

`Security.tsx:1020` calls `compactJson(JSON.parse(approval.params))` inline in
JSX; `compactJson` (`:661-667`) guards only `stringify`. A single malformed
`params` value throws during render and takes down the whole Security page.
See [issue template](issues/WORK7-017-security-approval-params-json-parse-render-crash.md).

### WORK7-018 — bot bridge splits HTML mid-tag {#work7-018}

`sendLongMessage` (`bot.ts:144-168`) splits already-rendered Telegram HTML on
`\n\n`/`\n`/space or a hard cut, with no tag/entity awareness, and the guest path
(`:549`) `.slice(0, MAX)`s rendered HTML. Boundaries can fall inside a tag/entity,
producing unbalanced markup that Telegram rejects or renders corrupted.
See [issue template](issues/WORK7-018-bot-bridge-splits-html-mid-tag.md).

### WORK7-019 — UI mutations swallow rejections {#work7-019}

`Network.tsx:329-342` (`updateTrust`/`toggleBlocked`/`removeAgent`) have no
try/catch and are invoked via `void`; `Events.tsx:420-423` uses `.then` with no
`.catch`. Failures are silent — safety-relevant controls appear to succeed when
they didn't.
See [issue template](issues/WORK7-019-ui-mutations-swallow-promise-rejections.md).

### WORK7-020 — Pipelines poll resets selected run {#work7-020}

`loadRuns` (`Pipelines.tsx:471-490`) always loads `next[0]` (newest) into
`selectedRun`, and the 2s poll (`:500-506`) re-invokes it, snapping the user off
any older run they opened while a run is active.
See [issue template](issues/WORK7-020-pipelines-poll-resets-selected-run.md).

### WORK7-021 — stripMarkupTags over-consumes text {#work7-021}

`stripMarkupTags` (`sanitize.ts:16-24`) greedily swallows subsequent
`>`-delimited fragments as long as each matches `isTagNameFragment`, deleting
legitimate text between `>` characters (e.g. `<a>foo>bar` → `bar`).
See [issue template](issues/WORK7-021-strip-markup-tags-over-consumes-text.md).

### WORK7-022 — gocoon wallet dir not 0o700 {#work7-022}

`mkdirSync(gocoonDataDir(), { recursive: true })` (`gocoon/cli.ts:84`) creates
the directory holding `wallet.json` (`gocoon/paths.ts:16`) with no restrictive
mode (→ `0o755`), leaving wallet key material world-traversable.
See [issue template](issues/WORK7-022-gocoon-data-dir-not-0700.md).

## 5. Implementation stages (suggested)

1. **Stage 1 — financial safety (blockers):** WORK7-003 (daily budget),
   WORK7-004 (tx-lock timeout), WORK7-010 (jetton decimals).
2. **Stage 2 — data & search integrity:** WORK7-001 / WORK7-002 (FTS5
   external-content), WORK7-007 (hybrid weighting), WORK7-008 (stale vector).
3. **Stage 3 — secret/permission exposure & SSRF:** WORK7-006 (provider SSRF),
   WORK7-015 (workspace file mode), WORK7-022 (gocoon dir mode).
4. **Stage 4 — reliability & resource hygiene:** WORK7-005 (HTML `$` corruption),
   WORK7-009 (truncation cap), WORK7-011 (workflow dedup), WORK7-012 (inbox
   growth), WORK7-013 (restartCount reset), WORK7-014 (SSE leak), WORK7-016
   (config edits), WORK7-017 (render crash), WORK7-018 (HTML split), WORK7-019
   (UI rejections), WORK7-020 (pipelines poll), WORK7-021 (sanitizer).

## 6. Filing note

The automation account used for issue creation has no triage rights on the
upstream repository, so the issue bodies carry the suggested labels/milestone in
their frontmatter and a footer, and **maintainers still need to apply the
labels, milestone, and assignment** in GitHub. The `github-issue` frontmatter
field and the index table above are updated with the issue URLs once filed.
