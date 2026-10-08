import Database from "better-sqlite3";
import { createHash } from "crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTarGz, parseTarGz } from "../archive.js";
import { createBackup } from "../backup.js";
import { createPreUpgradeBackup } from "../pre-upgrade.js";
import { compareVersions, inspectBackup, restoreBackup } from "../restore.js";
import { resolveBackupTargets } from "../targets.js";

let root: string;
const created: string[] = [];

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function buildArchiveWithEntry(path: string, data: Buffer): Buffer {
  const manifest = {
    format_version: 1,
    created_at: new Date(0).toISOString(),
    app_version: "0.0.0-test",
    schema_version: null,
    pre_upgrade: false,
    files: [{ path, sha256: sha256(data), size: data.length, kind: "file" }],
  };

  return createTarGz([
    { name: "manifest.json", data: Buffer.from(JSON.stringify(manifest), "utf-8") },
    { name: path, data, mode: 0o600 },
  ]);
}

/** Build a small, realistic TELETON_ROOT with a SQLite DB + plain files. */
function seedDataDir(dir: string, schemaVersion = "1.0.0"): void {
  mkdirSync(dir, { recursive: true });

  const db = new Database(join(dir, "memory.db"));
  db.pragma("journal_mode = WAL");
  db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)`);
  db.prepare(`INSERT INTO meta (key, value, updated_at) VALUES ('schema_version', ?, 0)`).run(
    schemaVersion
  );
  db.exec(`CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)`);
  const insert = db.prepare(`INSERT INTO notes (id, body) VALUES (?, ?)`);
  for (let i = 1; i <= 50; i++) insert.run(i, `note-${i}`);
  db.close();

  writeFileSync(join(dir, "config.yaml"), "telegram:\n  api_id: 123\n");
  writeFileSync(join(dir, "wallet.json"), JSON.stringify({ mnemonic: "enc:deadbeef" }));
  writeFileSync(join(dir, "telegram_session.txt"), "session-token-abc");

  mkdirSync(join(dir, "workspace"), { recursive: true });
  writeFileSync(join(dir, "workspace", "SOUL.md"), "# Soul\nhello world");

  mkdirSync(join(dir, "plugins", "data"), { recursive: true });
  const pluginDb = new Database(join(dir, "plugins", "data", "my-plugin.db"));
  pluginDb.exec(`CREATE TABLE kv (k TEXT, v TEXT)`);
  pluginDb.prepare(`INSERT INTO kv VALUES ('answer', '42')`).run();
  pluginDb.close();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "teleton-backup-test-"));
  created.push(root);
});

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("archive (tar.gz) round-trip", () => {
  it("preserves entry names and bytes through gzip+tar", () => {
    const entries = [
      { name: "manifest.json", data: Buffer.from('{"x":1}') },
      { name: "nested/dir/file.bin", data: Buffer.from([0, 1, 2, 255, 254]) },
      { name: "empty.txt", data: Buffer.alloc(0) },
    ];
    const archive = createTarGz(entries);
    const parsed = parseTarGz(archive);

    expect(parsed.map((e) => e.name)).toEqual(entries.map((e) => e.name));
    for (let i = 0; i < entries.length; i++) {
      expect(parsed[i].data.equals(entries[i].data)).toBe(true);
    }
  });

  it("handles long file names (> 100 bytes in UTF-8) via GNU LongLink", () => {
    // This reproduces the exact failure reported in issue #628: a workspace
    // path with Cyrillic characters whose UTF-8 byte length exceeds 100 bytes.
    const longName = "workspace/Alpha/blog/content/posts/как-зарегистрироваться-в-свой-в-альфе.md";
    expect(Buffer.byteLength(longName, "utf-8")).toBeGreaterThan(100);

    const entries = [
      { name: "manifest.json", data: Buffer.from('{"x":1}') },
      { name: longName, data: Buffer.from("# content") },
    ];
    const archive = createTarGz(entries);
    const parsed = parseTarGz(archive);

    expect(parsed.map((e) => e.name)).toEqual(entries.map((e) => e.name));
    expect(parsed[1].data.toString()).toBe("# content");
  });

  it("handles multiple long-named entries in the same archive", () => {
    const names = [
      "workspace/Alpha/blog/content/posts/как-зарегистрироваться-в-свой-в-альфе.md",
      "workspace/Alpha/blog/content/pages/очень-длинное-название-страницы-с-кириллицей.md",
      "short.txt",
    ];
    const entries = names.map((name) => ({ name, data: Buffer.from(name) }));
    const parsed = parseTarGz(createTarGz(entries));

    expect(parsed.map((e) => e.name)).toEqual(names);
    for (let i = 0; i < entries.length; i++) {
      expect(parsed[i].data.equals(entries[i].data)).toBe(true);
    }
  });
});

describe("compareVersions", () => {
  it("orders dotted numeric versions", () => {
    expect(compareVersions("1.2.0", "1.10.0")).toBe(-1);
    expect(compareVersions("2.0.0", "1.99.99")).toBe(1);
    expect(compareVersions("1.37.0", "1.37.0")).toBe(0);
    expect(compareVersions("1.5", "1.5.0")).toBe(0);
  });
});

describe("createBackup", () => {
  it("captures all critical targets with checksums and a manifest", () => {
    seedDataDir(root);
    const result = createBackup({ root });

    expect(existsSync(result.archivePath)).toBe(true);
    expect(result.manifest.schema_version).toBe("1.0.0");

    const paths = result.manifest.files.map((f) => f.path).sort();
    expect(paths).toContain("memory.db");
    expect(paths).toContain("config.yaml");
    expect(paths).toContain("wallet.json");
    expect(paths).toContain("telegram_session.txt");
    expect(paths).toContain("workspace/SOUL.md");
    expect(paths).toContain("plugins/data/my-plugin.db");

    // Every file record carries a non-empty checksum.
    for (const f of result.manifest.files) {
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("snapshots SQLite consistently (snapshot passes integrity_check)", () => {
    seedDataDir(root);
    const { entries } = inspectBackup(createBackup({ root }).archivePath);
    const snapshot = entries.get("memory.db")!;
    const db = new Database(snapshot);
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    expect((db.prepare("SELECT COUNT(*) AS n FROM notes").get() as { n: number }).n).toBe(50);
    db.close();
  });
});

describe("backup → wipe → restore → verify", () => {
  it("restores every file with identical content after a full wipe", () => {
    seedDataDir(root);
    const before = createBackup({ root, outDir: join(tmpdir(), "teleton-ext-backups") });
    created.push(join(tmpdir(), "teleton-ext-backups"));

    // Wipe everything that was backed up.
    for (const target of resolveBackupTargets(root)) {
      rmSync(target.absPath, { recursive: true, force: true });
    }
    expect(existsSync(join(root, "memory.db"))).toBe(false);
    expect(existsSync(join(root, "wallet.json"))).toBe(false);

    const result = restoreBackup({ archivePath: before.archivePath, root, skipSafetyBackup: true });
    expect(result.restoredFiles.length).toBe(before.manifest.files.length);

    // Plain files come back byte-for-byte.
    expect(readFileSync(join(root, "wallet.json"), "utf-8")).toContain("enc:deadbeef");
    expect(readFileSync(join(root, "workspace", "SOUL.md"), "utf-8")).toContain("hello world");

    // SQLite data is intact and queryable.
    const db = new Database(join(root, "memory.db"));
    expect((db.prepare("SELECT COUNT(*) AS n FROM notes").get() as { n: number }).n).toBe(50);
    expect(
      (db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string })
        .value
    ).toBe("1.0.0");
    db.close();

    const plugin = new Database(join(root, "plugins", "data", "my-plugin.db"));
    expect((plugin.prepare("SELECT v FROM kv WHERE k='answer'").get() as { v: string }).v).toBe(
      "42"
    );
    plugin.close();
  });

  it("creates a safety backup of current state before overwriting", () => {
    seedDataDir(root);
    const backup = createBackup({ root });

    const result = restoreBackup({ archivePath: backup.archivePath, root });
    expect(result.safetyBackupPath).toBeTruthy();
    expect(existsSync(result.safetyBackupPath!)).toBe(true);
  });
});

describe("integrity & compatibility guards", () => {
  it("rejects an archive with a tampered file (checksum mismatch)", () => {
    seedDataDir(root);
    const { archivePath } = createBackup({ root });

    // Tamper with one stored file but keep the manifest unchanged.
    const entries = parseTarGz(readFileSync(archivePath));
    const tampered = entries.map((e) =>
      e.name === "config.yaml" ? { ...e, data: Buffer.from("telegram:\n  api_id: 999\n") } : e
    );
    writeFileSync(archivePath, createTarGz(tampered));

    expect(() => inspectBackup(archivePath)).toThrow(/checksum mismatch/i);
  });

  it("refuses to restore a backup with a newer schema unless forced", () => {
    seedDataDir(root, "999.0.0"); // far newer than CURRENT_SCHEMA_VERSION
    const { archivePath } = createBackup({ root });

    expect(() => restoreBackup({ archivePath, root, skipSafetyBackup: true })).toThrow(
      /newer than this build/i
    );

    // --force overrides the guard.
    expect(() =>
      restoreBackup({ archivePath, root, force: true, skipSafetyBackup: true })
    ).not.toThrow();
  });

  it("throws a clear error when the archive is missing", () => {
    expect(() => inspectBackup(join(root, "does-not-exist.tar.gz"))).toThrow(/not found/i);
  });

  it("rejects a backup entry that escapes the target root", () => {
    const archivePath = join(root, "evil.tar.gz");
    const escapeName = `${basename(root)}-escape.txt`;
    const escapedPath = join(root, "..", escapeName);
    writeFileSync(archivePath, buildArchiveWithEntry(`../${escapeName}`, Buffer.from("owned")));

    try {
      expect(() => inspectBackup(archivePath)).toThrow(/invalid backup path|traversal|outside/i);
      expect(() => restoreBackup({ archivePath, root, skipSafetyBackup: true })).toThrow(
        /invalid backup path|traversal|outside/i
      );
      expect(existsSync(escapedPath)).toBe(false);
    } finally {
      rmSync(escapedPath, { force: true });
    }
  });

  it("rejects a backup entry with an absolute path", () => {
    const archivePath = join(root, "absolute.tar.gz");
    writeFileSync(
      archivePath,
      buildArchiveWithEntry("/tmp/teleton-absolute-restore.txt", Buffer.from("owned"))
    );

    expect(() => inspectBackup(archivePath)).toThrow(/invalid backup path|absolute|outside/i);
    expect(() => restoreBackup({ archivePath, root, skipSafetyBackup: true })).toThrow(
      /invalid backup path|absolute|outside/i
    );
  });

  it("rejects a backup entry with a Windows absolute path", () => {
    const archivePath = join(root, "windows-absolute.tar.gz");
    writeFileSync(
      archivePath,
      buildArchiveWithEntry("C:\\Windows\\Temp\\teleton-absolute-restore.txt", Buffer.from("owned"))
    );

    expect(() => inspectBackup(archivePath)).toThrow(/invalid backup path|absolute|outside/i);
    expect(() => restoreBackup({ archivePath, root, skipSafetyBackup: true })).toThrow(
      /invalid backup path|absolute|outside/i
    );
  });
});

describe("pre-upgrade backup hook", () => {
  it("creates a backup flagged pre_upgrade before a migration", () => {
    seedDataDir(root);
    createPreUpgradeBackup("1.0.0", "2.0.0", root);

    const backupsDir = join(root, "backups");
    const archive = readdirSync(backupsDir).find((f) => f.includes("pre-upgrade"));
    expect(archive).toBeTruthy();
    const { manifest } = inspectBackup(join(backupsDir, archive!));
    expect(manifest.pre_upgrade).toBe(true);
  });

  it("aborts (throws) when the backup cannot be created", () => {
    seedDataDir(root);
    // Corrupt memory.db so the SQLite snapshot fails — migration must abort.
    writeFileSync(join(root, "memory.db"), "not a sqlite file");
    expect(() => createPreUpgradeBackup("1.0.0", "2.0.0", root)).toThrow(
      /Pre-upgrade backup failed/i
    );
  });
});

it("clears stale SQLite sidecars on restore (#746)", () => {
  seedDataDir(root);
  const backup = createBackup({ root, outDir: join(root, "backups") });
  for (const suffix of ["-wal", "-shm", "-journal"])
    writeFileSync(join(root, `memory.db${suffix}`), "stale");
  restoreBackup({ root, archivePath: backup.archivePath, skipSafetyBackup: true });
  for (const suffix of ["-wal", "-shm", "-journal"])
    expect(existsSync(join(root, `memory.db${suffix}`))).toBe(false);
  const db = new Database(join(root, "memory.db"));
  expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
  db.close();
});

it("restores backup data instead of replaying real stale WAL frames (#746)", () => {
  seedDataDir(root);
  const backup = createBackup({ root, outDir: join(root, "backups") });
  const path = join(root, "memory.db");
  const live = new Database(path);
  live.pragma("journal_mode = WAL");
  live.pragma("wal_autocheckpoint = 0");
  live.exec("UPDATE notes SET body = 'stale WAL data' WHERE id = 1");
  const wal = readFileSync(`${path}-wal`);
  const shm = readFileSync(`${path}-shm`);
  expect(wal.length).toBeGreaterThan(32);
  live.close();
  writeFileSync(`${path}-wal`, wal);
  writeFileSync(`${path}-shm`, shm);
  restoreBackup({ root, archivePath: backup.archivePath, skipSafetyBackup: true });
  const restored = new Database(path);
  try {
    expect(restored.prepare("SELECT body FROM notes WHERE id = 1").get()).toEqual({
      body: "note-1",
    });
  } finally {
    restored.close();
  }
});
