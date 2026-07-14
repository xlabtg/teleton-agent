import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { ensureSchema, ensureVectorTables } from "../schema.js";
import { MessageStore, pruneOldMessages, type TelegramMessage } from "../feed/messages.js";
import type { EmbeddingProvider } from "../embeddings/provider.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createTestDb(): InstanceType<typeof Database> {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  ensureSchema(db);
  return db;
}

function makeEmbedder(embedding: number[] = []): EmbeddingProvider {
  return {
    id: "mock",
    model: "mock-model",
    dimensions: embedding.length,
    embedQuery: vi.fn().mockResolvedValue(embedding),
    embedBatch: vi.fn().mockResolvedValue([embedding]),
  };
}

/** Vector of the given dimension filled with a constant, for vec0 inserts. */
function vectorOfDim(dim: number, fill = 0.1): number[] {
  return new Array(dim).fill(fill);
}

/**
 * Create an in-memory DB with the sqlite-vec extension loaded and vec0 tables
 * created at the given dimension. Returns null if sqlite-vec is unavailable.
 */
function createVectorDb(dimensions: number): InstanceType<typeof Database> | null {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  ensureSchema(db);
  try {
    sqliteVec.load(db);
    ensureVectorTables(db, dimensions);
  } catch {
    db.close();
    return null;
  }
  return db;
}

function ensurePlainVectorTable(db: InstanceType<typeof Database>): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tg_messages_vec (
      id TEXT PRIMARY KEY,
      embedding BLOB NOT NULL
    )
  `);
}

function makeMessage(overrides: Partial<TelegramMessage> = {}): TelegramMessage {
  return {
    id: "msg-1",
    chatId: "chat-1",
    senderId: "user-1",
    text: "Hello world",
    isFromAgent: false,
    hasMedia: false,
    timestamp: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("MessageStore", () => {
  let db: InstanceType<typeof Database>;
  let embedder: EmbeddingProvider;
  let store: MessageStore;

  beforeEach(() => {
    db = createTestDb();
    embedder = makeEmbedder();
    store = new MessageStore(db, embedder, false);
  });

  afterEach(() => {
    db.close();
    vi.clearAllMocks();
  });

  // ============================================
  // storeMessage — basic insertion
  // ============================================

  describe("storeMessage", () => {
    it("persists a simple text message", async () => {
      await store.storeMessage(makeMessage());

      const rows = db.prepare("SELECT * FROM tg_messages WHERE id = 'msg-1'").all();
      expect(rows).toHaveLength(1);
    });

    it("auto-creates the chat record if it does not exist", async () => {
      await store.storeMessage(makeMessage({ chatId: "new-chat" }));

      const chat = db.prepare("SELECT * FROM tg_chats WHERE id = 'new-chat'").get();
      expect(chat).toBeDefined();
    });

    it("auto-creates the user record when senderId is set", async () => {
      await store.storeMessage(makeMessage({ senderId: "new-user" }));

      const user = db.prepare("SELECT * FROM tg_users WHERE id = 'new-user'").get();
      expect(user).toBeDefined();
    });

    it("does not create a user record when senderId is null", async () => {
      await store.storeMessage(makeMessage({ senderId: null }));

      const count = (db.prepare("SELECT COUNT(*) as cnt FROM tg_users").get() as { cnt: number })
        .cnt;
      expect(count).toBe(0);
    });

    it("stores isFromAgent as 1 when true", async () => {
      await store.storeMessage(makeMessage({ id: "agent-msg", isFromAgent: true }));

      const row = db
        .prepare("SELECT is_from_agent FROM tg_messages WHERE id = 'agent-msg'")
        .get() as {
        is_from_agent: number;
      };
      expect(row.is_from_agent).toBe(1);
    });

    it("stores isFromAgent as 0 when false", async () => {
      await store.storeMessage(makeMessage({ id: "user-msg", isFromAgent: false }));

      const row = db
        .prepare("SELECT is_from_agent FROM tg_messages WHERE id = 'user-msg'")
        .get() as {
        is_from_agent: number;
      };
      expect(row.is_from_agent).toBe(0);
    });

    it("stores hasMedia as 1 when true", async () => {
      await store.storeMessage(
        makeMessage({ id: "media-msg", hasMedia: true, mediaType: "photo" })
      );

      const row = db
        .prepare("SELECT has_media, media_type FROM tg_messages WHERE id = 'media-msg'")
        .get() as {
        has_media: number;
        media_type: string;
      };
      expect(row.has_media).toBe(1);
      expect(row.media_type).toBe("photo");
    });

    it("stores replyToId in reply_to_id column", async () => {
      await store.storeMessage(makeMessage({ id: "msg-reply", replyToId: "msg-1" }));

      const row = db
        .prepare("SELECT reply_to_id FROM tg_messages WHERE id = 'msg-reply'")
        .get() as {
        reply_to_id: string;
      };
      expect(row.reply_to_id).toBe("msg-1");
    });

    it("stores null text when text is null", async () => {
      await store.storeMessage(makeMessage({ id: "no-text", text: null }));

      const row = db.prepare("SELECT text FROM tg_messages WHERE id = 'no-text'").get() as {
        text: string | null;
      };
      expect(row.text).toBeNull();
    });

    it("updates the chat last_message_at after storing a message", async () => {
      const ts = 1700000000;
      await store.storeMessage(makeMessage({ chatId: "chat-ts", timestamp: ts }));

      const chat = db
        .prepare("SELECT last_message_at FROM tg_chats WHERE id = 'chat-ts'")
        .get() as {
        last_message_at: number;
      };
      expect(chat.last_message_at).toBe(ts);
    });

    it("updates an existing message with same id", async () => {
      await store.storeMessage(makeMessage({ id: "dup-msg", text: "First version" }));
      await store.storeMessage(makeMessage({ id: "dup-msg", text: "Updated version" }));

      const rows = db.prepare("SELECT text FROM tg_messages WHERE id = 'dup-msg'").all() as {
        text: string;
      }[];
      expect(rows).toHaveLength(1);
      expect(rows[0].text).toBe("Updated version");
    });

    it("keeps tg_messages_fts in sync when a message is updated", async () => {
      await store.storeMessage(makeMessage({ id: "dup-fts", text: "oldtoken message" }));
      const before = db.prepare("SELECT rowid FROM tg_messages WHERE id = ?").get("dup-fts") as {
        rowid: number;
      };

      await store.storeMessage(makeMessage({ id: "dup-fts", text: "newtoken message" }));
      const after = db.prepare("SELECT rowid FROM tg_messages WHERE id = ?").get("dup-fts") as {
        rowid: number;
      };

      const oldMatches = db
        .prepare(
          `
          SELECT mf.rowid AS fts_rowid, m.id, m.text
          FROM tg_messages_fts mf
          LEFT JOIN tg_messages m ON m.rowid = mf.rowid
          WHERE tg_messages_fts MATCH ?
        `
        )
        .all("oldtoken");
      const newMatches = db
        .prepare(
          `
          SELECT m.id, m.text
          FROM tg_messages_fts mf
          JOIN tg_messages m ON m.rowid = mf.rowid
          WHERE tg_messages_fts MATCH ?
        `
        )
        .all("newtoken") as Array<{ id: string; text: string }>;

      expect(after.rowid).toBe(before.rowid);
      expect(oldMatches).toHaveLength(0);
      expect(newMatches).toEqual([{ id: "dup-fts", text: "newtoken message" }]);
    });

    it("does not call embedder when vectorEnabled is false", async () => {
      await store.storeMessage(makeMessage({ text: "some text" }));
      expect(embedder.embedQuery).not.toHaveBeenCalled();
    });

    it("calls embedder when vectorEnabled is true and text is not null", async () => {
      // The embedder is called before the vector DB insert. We verify the call
      // happened even if the vec table is absent (no sqlite-vec extension in tests).
      const vecEmbedder = makeEmbedder([]); // return empty → no vec insert attempted
      const vecStore = new MessageStore(db, vecEmbedder, true);

      await vecStore.storeMessage(makeMessage({ text: "embed this" }));

      expect(vecEmbedder.embedQuery).toHaveBeenCalledWith("embed this");
    });

    it("skips embedder when vectorEnabled is true but text is null", async () => {
      const vecEmbedder = makeEmbedder([]);
      const vecStore = new MessageStore(db, vecEmbedder, true);

      await vecStore.storeMessage(makeMessage({ text: null }));

      expect(vecEmbedder.embedQuery).not.toHaveBeenCalled();
    });

    it("stores multiple messages for the same chat", async () => {
      await store.storeMessage(makeMessage({ id: "msg-a", timestamp: 1000 }));
      await store.storeMessage(makeMessage({ id: "msg-b", timestamp: 2000 }));

      const rows = db.prepare("SELECT id FROM tg_messages WHERE chat_id = 'chat-1'").all();
      expect(rows).toHaveLength(2);
    });
  });

  // ============================================
  // getRecentMessages
  // ============================================

  describe("getRecentMessages", () => {
    it("returns empty array when no messages exist for the chat", () => {
      const msgs = store.getRecentMessages("empty-chat");
      expect(msgs).toEqual([]);
    });

    it("returns messages for the specified chat only", async () => {
      await store.storeMessage(makeMessage({ id: "m1", chatId: "chat-a", timestamp: 1000 }));
      await store.storeMessage(makeMessage({ id: "m2", chatId: "chat-b", timestamp: 2000 }));

      const msgs = store.getRecentMessages("chat-a");
      expect(msgs).toHaveLength(1);
      expect(msgs[0].id).toBe("m1");
    });

    it("returns messages in ascending timestamp order (oldest first)", async () => {
      await store.storeMessage(makeMessage({ id: "m-new", chatId: "chat-ord", timestamp: 3000 }));
      await store.storeMessage(makeMessage({ id: "m-mid", chatId: "chat-ord", timestamp: 2000 }));
      await store.storeMessage(makeMessage({ id: "m-old", chatId: "chat-ord", timestamp: 1000 }));

      const msgs = store.getRecentMessages("chat-ord");
      expect(msgs[0].id).toBe("m-old");
      expect(msgs[1].id).toBe("m-mid");
      expect(msgs[2].id).toBe("m-new");
    });

    it("respects the limit parameter and returns the most recent N messages", async () => {
      for (let i = 0; i < 10; i++) {
        await store.storeMessage(makeMessage({ id: `m-${i}`, chatId: "chat-lim", timestamp: i }));
      }

      const msgs = store.getRecentMessages("chat-lim", 3);
      expect(msgs).toHaveLength(3);
      // Should return the 3 most recent (reversed back to ascending order)
      const ids = msgs.map((m) => m.id);
      expect(ids).toContain("m-7");
      expect(ids).toContain("m-8");
      expect(ids).toContain("m-9");
    });

    it("uses default limit of 20", async () => {
      for (let i = 0; i < 25; i++) {
        await store.storeMessage(
          makeMessage({ id: `m-def-${i}`, chatId: "chat-def", timestamp: i })
        );
      }

      const msgs = store.getRecentMessages("chat-def");
      expect(msgs).toHaveLength(20);
    });

    it("maps is_from_agent integer to boolean", async () => {
      await store.storeMessage(
        makeMessage({ id: "agent-1", isFromAgent: true, chatId: "chat-agent" })
      );

      const msgs = store.getRecentMessages("chat-agent");
      expect(typeof msgs[0].isFromAgent).toBe("boolean");
      expect(msgs[0].isFromAgent).toBe(true);
    });

    it("maps has_media integer to boolean", async () => {
      await store.storeMessage(
        makeMessage({ id: "media-1", hasMedia: true, chatId: "chat-media" })
      );

      const msgs = store.getRecentMessages("chat-media");
      expect(typeof msgs[0].hasMedia).toBe("boolean");
      expect(msgs[0].hasMedia).toBe(true);
    });

    it("maps reply_to_id null to undefined", async () => {
      await store.storeMessage(makeMessage({ id: "no-reply", chatId: "chat-rep" }));

      const msgs = store.getRecentMessages("chat-rep");
      expect(msgs[0].replyToId).toBeUndefined();
    });

    it("maps media_type null to undefined", async () => {
      await store.storeMessage(
        makeMessage({ id: "no-media", chatId: "chat-mtype", mediaType: undefined })
      );

      const msgs = store.getRecentMessages("chat-mtype");
      expect(msgs[0].mediaType).toBeUndefined();
    });

    it("returns correct chatId on each message", async () => {
      await store.storeMessage(makeMessage({ id: "cid-msg", chatId: "correct-chat" }));

      const msgs = store.getRecentMessages("correct-chat");
      expect(msgs[0].chatId).toBe("correct-chat");
    });

    it("returns correct senderId including null", async () => {
      await store.storeMessage(
        makeMessage({ id: "null-sender", chatId: "chat-ns", senderId: null })
      );

      const msgs = store.getRecentMessages("chat-ns");
      expect(msgs[0].senderId).toBeNull();
    });

    it("returns correct replyToId when set", async () => {
      // Store parent message first
      await store.storeMessage(makeMessage({ id: "parent", chatId: "chat-r" }));
      await store.storeMessage(
        makeMessage({ id: "child", chatId: "chat-r", replyToId: "parent", timestamp: 999 })
      );

      const msgs = store.getRecentMessages("chat-r");
      const child = msgs.find((m) => m.id === "child");
      expect(child!.replyToId).toBe("parent");
    });
  });

  // ============================================
  // pruneOldMessages
  // ============================================

  describe("pruneOldMessages", () => {
    it("deletes old feed rows with their local vectors and FTS postings", async () => {
      ensurePlainVectorTable(db);
      const now = Math.floor(Date.now() / 1000);
      await store.storeMessage(
        makeMessage({ id: "old-prune", text: "legacytoken old", timestamp: now - 120 * 86400 })
      );
      await store.storeMessage(
        makeMessage({ id: "new-prune", text: "keeptoken new", timestamp: now - 2 * 86400 })
      );
      db.prepare(`INSERT INTO tg_messages_vec (id, embedding) VALUES (?, ?)`).run(
        "old-prune",
        Buffer.from("vector")
      );
      db.prepare(`INSERT INTO tg_messages_vec (id, embedding) VALUES (?, ?)`).run(
        "new-prune",
        Buffer.from("vector")
      );

      const deleted = pruneOldMessages(db, 90);
      const oldVectorCount = (
        db.prepare(`SELECT COUNT(*) AS c FROM tg_messages_vec WHERE id = 'old-prune'`).get() as {
          c: number;
        }
      ).c;
      const oldMatches = db
        .prepare(
          `
          SELECT m.id
          FROM tg_messages_fts mf
          JOIN tg_messages m ON m.rowid = mf.rowid
          WHERE tg_messages_fts MATCH ?
        `
        )
        .all("legacytoken");

      expect(deleted).toBe(1);
      expect(db.prepare(`SELECT id FROM tg_messages WHERE id = 'old-prune'`).get()).toBeUndefined();
      expect(oldVectorCount).toBe(0);
      expect(oldMatches).toHaveLength(0);
      expect(db.prepare(`SELECT id FROM tg_messages WHERE id = 'new-prune'`).get()).toBeDefined();
      expect(
        db.prepare(`SELECT id FROM tg_messages_vec WHERE id = 'new-prune'`).get()
      ).toBeDefined();
    });
  });

  // ============================================
  // Vector insert isolation (issue #537)
  // ============================================

  describe("vector insert isolation", () => {
    it("removes the stale vector when a re-embed yields no embedding", async () => {
      ensurePlainVectorTable(db);
      const firstEmbedding = [0.1, 0.2, 0.3];
      const changingEmbedder = makeEmbedder(firstEmbedding);
      const vecStore = new MessageStore(db, changingEmbedder, true);

      await vecStore.storeMessage(makeMessage({ id: "m1", text: "alpha" }));
      vi.mocked(changingEmbedder.embedQuery).mockResolvedValueOnce([]);
      await vecStore.storeMessage(makeMessage({ id: "m1", text: "beta" }));

      expect(db.prepare("SELECT id FROM tg_messages_vec WHERE id = 'm1'").get()).toBeUndefined();
    });

    it("stores message and vector for a non-384-dim provider (Voyage 1024)", async () => {
      const vdb = createVectorDb(1024);
      if (!vdb) return; // sqlite-vec unavailable in this environment
      try {
        const vecStore = new MessageStore(vdb, makeEmbedder(vectorOfDim(1024)), true);
        await vecStore.storeMessage(makeMessage({ id: "m1", text: "hello" }));

        const rowCount = (
          vdb.prepare("SELECT COUNT(*) AS c FROM tg_messages WHERE id='m1'").get() as { c: number }
        ).c;
        const vecCount = (
          vdb.prepare("SELECT COUNT(*) AS c FROM tg_messages_vec WHERE id='m1'").get() as {
            c: number;
          }
        ).c;
        expect(rowCount).toBe(1);
        expect(vecCount).toBe(1);
      } finally {
        vdb.close();
      }
    });

    it("does not drop the message row when the vector insert fails (dimension mismatch)", async () => {
      // vec0 table expects 1024 dims, embedder emits 384 → vec insert fails the
      // dimension check. The message row must still be stored.
      const vdb = createVectorDb(1024);
      if (!vdb) return;
      try {
        const vecStore = new MessageStore(vdb, makeEmbedder(vectorOfDim(384)), true);
        await expect(
          vecStore.storeMessage(makeMessage({ id: "m1", text: "hello" }))
        ).resolves.not.toThrow();

        const rowCount = (
          vdb.prepare("SELECT COUNT(*) AS c FROM tg_messages WHERE id='m1'").get() as { c: number }
        ).c;
        const vecCount = (
          vdb.prepare("SELECT COUNT(*) AS c FROM tg_messages_vec WHERE id='m1'").get() as {
            c: number;
          }
        ).c;
        expect(rowCount).toBe(1); // row preserved despite the vec failure
        expect(vecCount).toBe(0); // vector degraded, not inserted
      } finally {
        vdb.close();
      }
    });

    it("does not drop the message row when the embedder throws", async () => {
      const throwingEmbedder: EmbeddingProvider = {
        id: "mock",
        model: "mock-model",
        dimensions: 1024,
        embedQuery: vi.fn().mockRejectedValue(new Error("provider down")),
        embedBatch: vi.fn().mockResolvedValue([]),
      };
      const vecStore = new MessageStore(db, throwingEmbedder, true);

      await expect(
        vecStore.storeMessage(makeMessage({ id: "m1", text: "hello" }))
      ).resolves.not.toThrow();

      const rowCount = (
        db.prepare("SELECT COUNT(*) AS c FROM tg_messages WHERE id='m1'").get() as { c: number }
      ).c;
      expect(rowCount).toBe(1);
    });
  });
});
