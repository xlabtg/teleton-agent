---
title: "[AUDIT/V8] Backup restore overwrites `memory.db` but leaves stale `-wal`/`-shm` sidecars, so SQLite replays old WAL frames over the restored database"
labels: ["bug", "audit-finding-v8", "high", "v3.0-blocker", "data-integrity"]
milestone: "v3.0 - Production Ready"
audit-source: "#738"
finding-id: "WORK8-007"
severity: "high"
category: "data-integrity"
github-issue: "TBD"
---

## Problem Description

```ts
for (const file of manifest.files) {
  ...
  writeFileSync(destAbs, data, { mode: 0o600 });
```
Restore only writes the main DB file. The live databases run in WAL mode, so `memory.db-wal`, `memory.db-shm`, `deals.db-wal` and the plugin `*.db-wal` files can still sit next to it, for example after a crash, a kill, or a restore while the agent is running (the CLI only prints a warning). When SQLite next opens the file it opens any non-empty `-wal` file regardless of the header's journal mode. It replays those frames over the freshly restored pages, so the restored data is silently replaced by the pre-restore state, or the two get mixed.

## Location

- src/backup/restore.ts:146-157 (restore loop)
- src/memory/database.ts:54 (`journal_mode = WAL`)

## How To Reproduce

`experiments/audit8/repro-backup-1.py` uses Python's sqlite3, which has the same WAL semantics as better-sqlite3. It does this:
1. Create `backup.db` containing the row `restored`.
2. Create a WAL-mode `memory.db` with a committed but uncheckpointed row `stale-live`, and keep a copy of its `-wal` (this simulates a crash).
3. Copy `backup.db` over `memory.db` and leave the `-wal` in place, which is what `restoreBackup` does.
4. Open the database: `select * from t` returns `[('stale-live',)]` and `integrity_check` returns `ok`.

Run with `python3 -I experiments/audit8/repro-backup-1.py <empty-dir>`.

**Verification evidence:** The repro output is `[('stale-live',)]`, `[('ok',)]`. Neither src/backup nor src/cli/commands/backup.ts mentions wal/shm.

## Impact

A restore reports success, but the user's restored memory, deals and plugin data are silently replaced by stale content (no integrity error appears). Pages that only partly overlap can also corrupt the database. Restore is exactly what people run after a crash, which is when stale WALs are most likely to exist.

## Proposed Fix

Before writing each `kind === "sqlite"` file, delete (`rmSync(..., {force:true})`) `${dest}-wal`, `${dest}-shm` and `${dest}-journal`. The safety backup has already captured the current state at that point, so nothing is lost. Better still, write to `${dest}.restore-tmp` and then `renameSync` it into place after removing the sidecars. Optionally, refuse to restore while the agent's lock or PID file shows it is running.

## Regression Test

In backup.test.ts:
1. Create a WAL db at `root/memory.db` with an uncheckpointed row (via `wal_autocheckpoint=0`), copy its `-wal` aside, close it, and put the `-wal` back.
2. Restore an archive whose memory.db holds different data.
3. Open with better-sqlite3 and assert that the restored row is present and the stale row is not, and that `memory.db-wal` no longer exists.

## Acceptance Criteria

- [ ] After `restoreBackup`, no `-wal`/`-shm`/`-journal` sidecar from before the restore exists for any restored SQLite file, and reopening returns exactly the backup contents.

## Related Artifacts

- Report: `improvements/work8/AUDIT_V8_REPORT.md#work8-007`
- Audit track notes: `experiments/audit8/memory.md` (finding 2)
- Repro: `experiments/audit8/repro-backup-1.py`
