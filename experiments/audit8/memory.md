# Audit 8 — memory / session / backup / workspace / soul / config

## 1. NVIDIA model catalog no longer contains the provider's default model `z-ai/glm-5.1` (catalog/default/test drift after fd9ac870)

- Severity: medium
- Category: correctness
- Location: src/config/model-catalog.ts:491-512; src/config/providers.ts:196-197; src/providers/model-resolver.ts:82; src/agent/runtime-utils.ts:154-179; src/providers/__tests__/nvidia-provider.test.ts:21,56,78-83

### Problem
Commit fd9ac870 replaced the NVIDIA entries with `z-ai/glm-5-3`, `z-ai/glm-5-3-flash`, `deepseek-ai/deepseek-v4.1-flash`, `moonshotai/kimi-k3` and removed every other model, including the provider default:

```ts
// providers.ts
defaultModel: "z-ai/glm-5.1",
utilityModel: "z-ai/glm-5.1",
```

- The default (`z-ai/glm-5.1`) is no longer an option in the dropdown. Onboarding (`src/cli/commands/onboard.ts:498`) calls `select({ default: providerMeta.defaultModel, choices })` with a default that is not in the choices. The WebUI setup and config model lists (`/models/:provider`) leave out the model the agent actually runs on.
- All the GLM-specific workarounds use the exact string `z-ai/glm-5.1`: `NVIDIA_DISABLE_STREAMING_USAGE_MODELS` and `isNvidiaGlmEmptyStreamResponse` (runtime-utils.ts:155). The new GLM catalog entries (`z-ai/glm-5-3*`) therefore do not get the `supportsUsageInStreaming:false` compat flag or the empty-stream recovery that were added in #562/#627/#634/#677.
- The new ids use a hyphen (`glm-5-3`). NVIDIA NIM ids use dots (`z-ai/glm-5.1`, `deepseek-v3.1-terminus`, `kimi-k2.6`), so `glm-5-3` / `glm-5-3-flash` look malformed. The display name "DeepSeek v4.1 Flesh" also has a typo.
- `nvidia-provider.test.ts` still asserts on removed values (`z-ai/glm-5.1`, `qwen/qwen3-coder-480b-a35b-instruct`, `mistralai/mistral-small-4-119b-2603`, `deepseek-ai/deepseek-v3.1-terminus`, `moonshotai/kimi-k2.6`, `stepfun-ai/step-3.5-flash`), so the suite is red on main.

### How to reproduce
`npx vitest run src/providers/__tests__/nvidia-provider.test.ts`. The "contains chat completion models" test fails on `toContain("z-ai/glm-5.1")`. Or run `teleton setup`, choose NVIDIA and see that the default model is not listed.

### Impact
New users get a catalog that does not match the runtime default. Users who pick a new GLM entry lose the GLM streaming fixes and may hit an invalid model id at NVIDIA (a 404 or an empty stream). CI is red.

### Proposed fix
Restore `z-ai/glm-5.1` to the catalog, or move `defaultModel`/`utilityModel` to a verified, catalog-listed id. Check the new ids against `https://integrate.api.nvidia.com/v1/models` (dot notation). Turn the GLM matching into a prefix/regex such as `/^z-ai\/glm-5/`, used by both model-resolver and runtime-utils. Update the test assertions. Fix the "Flesh" typo.

### Regression test sketch
For every provider in `PROVIDER_REGISTRY` that has a catalog, assert that `getModelsForProvider(p).map(m=>m.value)` contains `meta.defaultModel` and `meta.utilityModel`. Assert that every NVIDIA GLM catalog entry yields `compat.supportsUsageInStreaming === false`.

### Acceptance criteria
The default and utility models appear in the catalog for every provider. The GLM workarounds apply to every GLM entry in the catalog. The NVIDIA provider tests pass.

### Verification evidence
`git show fd9ac870`; grep shows `z-ai/glm-5.1` only in providers.ts, model-resolver.ts, runtime-utils.ts and tests, and no longer in model-catalog.ts. I could not run the tests because node_modules is not installed in the checkout.

---

## 2. Backup restore overwrites `memory.db` but leaves stale `-wal`/`-shm` sidecars, so SQLite replays old WAL frames over the restored database

- Severity: high
- Category: data-integrity
- Location: src/backup/restore.ts:146-157 (restore loop); src/memory/database.ts:54 (`journal_mode = WAL`)

### Problem
```ts
for (const file of manifest.files) {
  ...
  writeFileSync(destAbs, data, { mode: 0o600 });
```
Restore only writes the main DB file. The live databases run in WAL mode, so `memory.db-wal`, `memory.db-shm`, `deals.db-wal` and the plugin `*.db-wal` files can still sit next to it, for example after a crash, a kill, or a restore while the agent is running (the CLI only prints a warning). When SQLite next opens the file it opens any non-empty `-wal` file regardless of the header's journal mode. It replays those frames over the freshly restored pages, so the restored data is silently replaced by the pre-restore state, or the two get mixed.

### How to reproduce
`experiments/audit8/repro-backup-1.py` uses Python's sqlite3, which has the same WAL semantics as better-sqlite3. It does this:
1. Create `backup.db` containing the row `restored`.
2. Create a WAL-mode `memory.db` with a committed but uncheckpointed row `stale-live`, and keep a copy of its `-wal` (this simulates a crash).
3. Copy `backup.db` over `memory.db` and leave the `-wal` in place, which is what `restoreBackup` does.
4. Open the database: `select * from t` returns `[('stale-live',)]` and `integrity_check` returns `ok`.

Run with `python3 -I experiments/audit8/repro-backup-1.py <empty-dir>`.

### Impact
A restore reports success, but the user's restored memory, deals and plugin data are silently replaced by stale content (no integrity error appears). Pages that only partly overlap can also corrupt the database. Restore is exactly what people run after a crash, which is when stale WALs are most likely to exist.

### Proposed fix
Before writing each `kind === "sqlite"` file, delete (`rmSync(..., {force:true})`) `${dest}-wal`, `${dest}-shm` and `${dest}-journal`. The safety backup has already captured the current state at that point, so nothing is lost. Better still, write to `${dest}.restore-tmp` and then `renameSync` it into place after removing the sidecars. Optionally, refuse to restore while the agent's lock or PID file shows it is running.

### Regression test sketch
In backup.test.ts:
1. Create a WAL db at `root/memory.db` with an uncheckpointed row (via `wal_autocheckpoint=0`), copy its `-wal` aside, close it, and put the `-wal` back.
2. Restore an archive whose memory.db holds different data.
3. Open with better-sqlite3 and assert that the restored row is present and the stale row is not, and that `memory.db-wal` no longer exists.

### Acceptance criteria
After `restoreBackup`, no `-wal`/`-shm`/`-journal` sidecar from before the restore exists for any restored SQLite file, and reopening returns exactly the backup contents.

### Verification evidence
The repro output is `[('stale-live',)]`, `[('ok',)]`. Neither src/backup nor src/cli/commands/backup.ts mentions wal/shm.

---

## 3. `resetSession` keeps the old session's accumulated input/output token counters, so the new session id inherits stale usage

- Severity: low
- Category: correctness
- Location: src/session/store.ts:265-273 (resetSession UPDATE); src/agent/runtime.ts:1574-1579 (accumulation)

### Problem
```ts
UPDATE sessions
SET id = ?, started_at = ?, updated_at = ?, message_count = 0
WHERE chat_id = ?
```
`input_tokens` and `output_tokens` are not reset. Runtime adds to them every turn: `inputTokens: (session.inputTokens ?? 0) + accumulatedUsage.input + ...`. After a daily/idle reset (`resetSessionWithPolicy`) or a context-overflow reset (runtime.ts:1035), the new session id therefore carries all previous usage. `resetSession` also returns an entry without token fields, which disagrees with the row it just wrote. The WebUI sessions page (webui/routes/sessions.ts:62-99, 250-292) shows these per-session values.

### How to reproduce
Using an in-memory DB with the schema:
1. `getOrCreateSession("1")`.
2. `updateSession("1",{inputTokens:5000,outputTokens:800})`.
3. `resetSession("1")`.
4. `getSession("1")` returns a new `sessionId`, `messageCount 0`, `inputTokens 5000`, `outputTokens 800`.

### Impact
Token and cost accounting per session is wrong and keeps growing across resets. Analytics and the Sessions page misreport usage.

### Proposed fix
Add `input_tokens = 0, output_tokens = 0` (and arguably `context_tokens = NULL`, `last_message_id = NULL`) to the reset UPDATE. Return the entry by reading the row back through `rowToSession`.

### Regression test sketch
The steps from "How to reproduce" as a vitest test in src/session/__tests__, asserting that the token counters are 0 after the reset.

### Acceptance criteria
After `resetSession`/`resetSessionWithPolicy`, `getSession` reports 0 input and output tokens for the new session id.

### Verification evidence
Code reading: the UPDATE statement at store.ts:265-273 and the accumulation at runtime.ts:1574-1579. Not executed because node_modules is unavailable.
