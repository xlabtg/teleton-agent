import { renameSync, rmSync } from "fs";
import { randomUUID } from "crypto";
// src/backup/restore.ts
//
// Restores a `.tar.gz` backup produced by createBackup(). The restore is
// defensive: it verifies every file's checksum against the manifest, refuses
// to downgrade onto an older binary (unless forced), and always snapshots the
// current state into a safety backup before overwriting anything.

import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, isAbsolute, join, relative, resolve, win32 } from "path";
import { CURRENT_SCHEMA_VERSION } from "../memory/schema.js";
import { createLogger } from "../utils/logger.js";
import { TELETON_ROOT } from "../workspace/paths.js";
import { parseTarGz } from "./archive.js";
import { createBackup } from "./backup.js";
import { resolveBackupTargets } from "./targets.js";
import { MANIFEST_NAME, type BackupManifest, type RestoreResult } from "./types.js";

const log = createLogger("Restore");

export interface RestoreOptions {
  /** Path to the `.tar.gz` archive to restore. */
  archivePath: string;
  /** Target root directory (default: TELETON_ROOT). */
  root?: string;
  /** Allow restoring a backup whose schema is newer than this binary. */
  force?: boolean;
  /** Skip the pre-restore safety backup (not recommended). */
  skipSafetyBackup?: boolean;
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function validateBackupPath(path: string): void {
  const normalized = path.replace(/\\/g, "/");
  if (
    normalized.length === 0 ||
    isAbsolute(path) ||
    path.startsWith("/") ||
    win32.isAbsolute(path) ||
    normalized.split("/").some((segment) => segment === "..")
  ) {
    throw new Error(`Invalid backup path: ${path}`);
  }
}

function resolveRestorePath(root: string, path: string): string {
  validateBackupPath(path);

  const rootAbs = resolve(root);
  const destAbs = resolve(rootAbs, path);
  const rel = relative(rootAbs, destAbs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Invalid backup path outside restore root: ${path}`);
  }

  return destAbs;
}

/** Compare dot-separated numeric versions. Returns -1 / 0 / 1. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

/** Read and validate the manifest + checksums from an archive on disk. */
export function inspectBackup(archivePath: string): {
  manifest: BackupManifest;
  entries: Map<string, Buffer>;
} {
  if (!existsSync(archivePath)) {
    throw new Error(`Backup archive not found: ${archivePath}`);
  }

  const entries = new Map<string, Buffer>();
  for (const entry of parseTarGz(readFileSync(archivePath))) {
    validateBackupPath(entry.name);
    entries.set(entry.name, entry.data);
  }

  const manifestRaw = entries.get(MANIFEST_NAME);
  if (!manifestRaw) {
    throw new Error(`Invalid backup: missing ${MANIFEST_NAME}`);
  }
  const manifest = JSON.parse(manifestRaw.toString("utf-8")) as BackupManifest;

  // Verify every recorded file is present and intact.
  for (const file of manifest.files) {
    validateBackupPath(file.path);
    const data = entries.get(file.path);
    if (!data) {
      throw new Error(`Corrupt backup: file listed in manifest is missing: ${file.path}`);
    }
    const actual = sha256(data);
    if (actual !== file.sha256) {
      throw new Error(
        `Corrupt backup: checksum mismatch for ${file.path} (expected ${file.sha256}, got ${actual})`
      );
    }
  }

  return { manifest, entries };
}

/**
 * Restore a backup archive into `root`. Throws on corruption or on an
 * incompatible (newer-schema) backup unless `force` is set.
 */
export function restoreBackup(options: RestoreOptions): RestoreResult {
  const root = options.root ?? TELETON_ROOT;
  const { manifest, entries } = inspectBackup(options.archivePath);

  // Refuse to restore a backup whose schema is NEWER than this binary supports:
  // migrations only move forward, so a downgrade would corrupt or lose data.
  if (manifest.schema_version) {
    const cmp = compareVersions(manifest.schema_version, CURRENT_SCHEMA_VERSION);
    if (cmp > 0 && !options.force) {
      throw new Error(
        `Backup schema version ${manifest.schema_version} is newer than this build ` +
          `(${CURRENT_SCHEMA_VERSION}). Upgrade Teleton first, or re-run with --force to override.`
      );
    }
  }

  // Snapshot the current state before overwriting, unless explicitly skipped or
  // there is nothing to lose (empty/fresh install).
  let safetyBackupPath: string | null = null;
  if (!options.skipSafetyBackup && resolveBackupTargets(root).length > 0) {
    const safety = createBackup({ root, outDir: join(root, "backups"), preUpgrade: false });
    safetyBackupPath = safety.archivePath;
    log.info({ safetyBackupPath }, "Created safety backup of current state before restore");
  }

  const restoredFiles: string[] = [];
  for (const file of manifest.files) {
    const data = entries.get(file.path);
    if (!data) continue; // already validated in inspectBackup
    const destAbs = resolveRestorePath(root, file.path);
    const destDir = dirname(destAbs);
    if (!existsSync(destDir)) {
      mkdirSync(destDir, { recursive: true });
    }
    const temp = `${destAbs}.restore-${randomUUID()}`;
    try {
      writeFileSync(temp, data, { mode: 0o600, flag: "wx" });
      if (file.kind === "sqlite") {
        for (const suffix of ["-wal", "-shm", "-journal"])
          rmSync(`${destAbs}${suffix}`, { force: true });
      }
      renameSync(temp, destAbs);
    } finally {
      rmSync(temp, { force: true });
    }
    restoredFiles.push(file.path);
  }

  log.info(
    { archivePath: options.archivePath, restored: restoredFiles.length },
    "Restore complete"
  );

  return {
    archivePath: options.archivePath,
    manifest,
    restoredFiles,
    safetyBackupPath,
  };
}
