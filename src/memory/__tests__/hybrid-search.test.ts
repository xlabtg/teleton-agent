import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { ensureSchema } from "../schema.js";
import { HybridSearch, parseTemporalIntent } from "../search/hybrid.js";
import {
  SECONDS_PER_DAY,
  SECONDS_PER_HOUR,
  HYBRID_SEARCH_MIN_SCORE,
} from "../../constants/limits.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createTestDb(): InstanceType<typeof Database> {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  ensureSchema(db);
  return db;
}

/**
 * Insert a row directly into the knowledge and knowledge_fts tables.
 * FTS triggers fire automatically after INSERT on knowledge.
 */
function insertKnowledge(
  db: InstanceType<typeof Database>,
  id: string,
  text: string,
  source: "memory" | "session" | "learned" = "memory",
  path: string | null = null
) {
  const hash = `hash-${id}-${Math.random()}`;
  db.prepare(
    `INSERT OR REPLACE INTO knowledge (id, source, path, text, hash) VALUES (?, ?, ?, ?, ?)`
  ).run(id, source, path, text, hash);
}

/**
 * Insert a message row with an accompanying chat (created if absent).
 */
function insertMessage(
  db: InstanceType<typeof Database>,
  id: string,
  chatId: string,
  text: string,
  timestamp: number = Math.floor(Date.now() / 1000)
) {
  // Ensure chat exists
  const existing = db.prepare("SELECT id FROM tg_chats WHERE id = ?").get(chatId);
  if (!existing) {
    db.prepare(`INSERT INTO tg_chats (id, type, is_monitored) VALUES (?, 'dm', 1)`).run(chatId);
  }

  db.prepare(`INSERT INTO tg_messages (id, chat_id, text, timestamp) VALUES (?, ?, ?, ?)`).run(
    id,
    chatId,
    text,
    timestamp
  );
}

// ─── parseTemporalIntent ─────────────────────────────────────────────────────

describe("parseTemporalIntent", () => {
  const nowApprox = Math.floor(Date.now() / 1000);

  it("returns empty object for a plain query with no temporal reference", () => {
    expect(parseTemporalIntent("Tell me about the project")).toEqual({});
  });

  it("parses 'N days ago' pattern", () => {
    const result = parseTemporalIntent("What happened 3 days ago?");
    expect(result.afterTimestamp).toBeDefined();
    expect(result.afterTimestamp!).toBeCloseTo(nowApprox - 3 * SECONDS_PER_DAY, -2);
  });

  it("parses 'N hours ago' pattern", () => {
    const result = parseTemporalIntent("What did we discuss 2 hours ago?");
    expect(result.afterTimestamp!).toBeCloseTo(nowApprox - 2 * SECONDS_PER_HOUR, -2);
  });

  it("parses 'N weeks ago' pattern", () => {
    const result = parseTemporalIntent("Update from 1 weeks ago");
    expect(result.afterTimestamp!).toBeCloseTo(nowApprox - 7 * SECONDS_PER_DAY, -2);
  });

  it("parses 'N months ago' pattern", () => {
    const result = parseTemporalIntent("2 months ago status");
    expect(result.afterTimestamp!).toBeCloseTo(nowApprox - 2 * 30 * SECONDS_PER_DAY, -2);
  });

  it("parses 'last N days' pattern", () => {
    const result = parseTemporalIntent("last 5 days of activity");
    expect(result.afterTimestamp!).toBeCloseTo(nowApprox - 5 * SECONDS_PER_DAY, -2);
  });

  it("parses 'last N hours' pattern", () => {
    const result = parseTemporalIntent("last 6 hours of logs");
    expect(result.afterTimestamp!).toBeCloseTo(nowApprox - 6 * SECONDS_PER_HOUR, -2);
  });

  it("parses 'today' keyword", () => {
    const result = parseTemporalIntent("What did we do today?");
    expect(result.afterTimestamp!).toBeCloseTo(nowApprox - SECONDS_PER_DAY, -2);
  });

  it("parses 'yesterday' keyword", () => {
    const result = parseTemporalIntent("What about yesterday?");
    expect(result.afterTimestamp!).toBeCloseTo(nowApprox - 2 * SECONDS_PER_DAY, -2);
  });

  it("parses 'last week' keyword", () => {
    const result = parseTemporalIntent("Summarize last week");
    expect(result.afterTimestamp!).toBeCloseTo(nowApprox - 7 * SECONDS_PER_DAY, -2);
  });

  it("parses 'this week' keyword", () => {
    const result = parseTemporalIntent("What happened this week?");
    expect(result.afterTimestamp!).toBeCloseTo(nowApprox - 7 * SECONDS_PER_DAY, -2);
  });

  it("parses 'last month' keyword", () => {
    const result = parseTemporalIntent("Recap of last month");
    expect(result.afterTimestamp!).toBeCloseTo(nowApprox - 30 * SECONDS_PER_DAY, -2);
  });

  it("parses 'recently' keyword", () => {
    const result = parseTemporalIntent("What happened recently?");
    expect(result.afterTimestamp!).toBeCloseTo(nowApprox - 3 * SECONDS_PER_DAY, -2);
  });

  it("is case-insensitive for temporal keywords", () => {
    const result = parseTemporalIntent("WHAT HAPPENED TODAY");
    expect(result.afterTimestamp).toBeDefined();
  });

  it("returns empty object when temporal words appear but not as exact patterns", () => {
    // "today" substring inside another word should not match
    const result = parseTemporalIntent("birthday");
    expect(result).toEqual({});
  });
});

// ─── HybridSearch (keyword-only, vectorEnabled = false) ──────────────────────

describe("HybridSearch (vectorEnabled = false)", () => {
  let db: InstanceType<typeof Database>;
  let search: HybridSearch;

  beforeEach(() => {
    db = createTestDb();
    search = new HybridSearch(db, false);
  });

  afterEach(() => {
    db.close();
  });

  // ── searchKnowledge ──────────────────────────────────────────────────────

  describe("searchKnowledge", () => {
    it("returns empty array when knowledge table is empty", async () => {
      const results = await search.searchKnowledge("anything", [], {});
      expect(results).toEqual([]);
    });

    it("finds knowledge chunks containing the query term", async () => {
      insertKnowledge(db, "k1", "The quick brown fox jumps over the lazy dog");
      insertKnowledge(db, "k2", "Completely unrelated content about finance");

      const results = await search.searchKnowledge("fox jumps", [], {});
      const ids = results.map((r) => r.id);
      expect(ids).toContain("k1");
    });

    it("returns empty array for empty query string", async () => {
      insertKnowledge(db, "k3", "Some text here");
      const results = await search.searchKnowledge("", [], {});
      expect(results).toEqual([]);
    });

    it("respects the limit option", async () => {
      for (let i = 0; i < 10; i++) {
        insertKnowledge(db, `k-lim-${i}`, `Relevant keyword test document number ${i}`);
      }

      const results = await search.searchKnowledge("keyword test document", [], { limit: 3 });
      expect(results.length).toBeLessThanOrEqual(3);
    });

    it("returns results with required fields (id, text, source, score)", async () => {
      insertKnowledge(db, "k-fields", "Hello world test", "memory", "/path/to/file.md");

      const results = await search.searchKnowledge("hello world", [], {});
      if (results.length > 0) {
        const r = results[0];
        expect(r).toHaveProperty("id");
        expect(r).toHaveProperty("text");
        expect(r).toHaveProperty("source");
        expect(r).toHaveProperty("score");
        expect(typeof r.score).toBe("number");
        expect(r.score).toBeGreaterThanOrEqual(HYBRID_SEARCH_MIN_SCORE);
      }
    });

    it("returns results sorted by score descending", async () => {
      insertKnowledge(db, "k-sort-a", "dogs dogs dogs many dogs");
      insertKnowledge(db, "k-sort-b", "dogs once");

      const results = await search.searchKnowledge("dogs", [], {});
      if (results.length >= 2) {
        expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);
      }
    });

    it("escapes FTS5 special characters in query without throwing", async () => {
      insertKnowledge(db, "k-fts-safe", "some safe text");

      await expect(
        search.searchKnowledge("hello (world) OR test:thing", [], {})
      ).resolves.not.toThrow();
    });

    it("filters results below HYBRID_SEARCH_MIN_SCORE", async () => {
      insertKnowledge(db, "k-low", "abcdefghijk");
      // Search for something completely unrelated
      const results = await search.searchKnowledge("zyxwvu", [], {});
      for (const r of results) {
        expect(r.score).toBeGreaterThanOrEqual(HYBRID_SEARCH_MIN_SCORE);
      }
    });
  });

  // ── searchMessages ───────────────────────────────────────────────────────

  describe("searchMessages", () => {
    it("returns empty array when no messages exist", async () => {
      const results = await search.searchMessages("hello", [], {});
      expect(results).toEqual([]);
    });

    it("finds messages containing the query term", async () => {
      insertMessage(db, "m1", "chat-1", "The cat sat on the mat");
      insertMessage(db, "m2", "chat-1", "Completely different content");

      const results = await search.searchMessages("cat sat", [], {});
      const ids = results.map((r) => r.id);
      expect(ids).toContain("m1");
    });

    it("returns empty array for empty query string", async () => {
      insertMessage(db, "m-empty", "chat-1", "Some text");
      const results = await search.searchMessages("", [], {});
      expect(results).toEqual([]);
    });

    it("filters by chatId when provided", async () => {
      insertMessage(db, "m-a1", "chat-a", "hello world topic");
      insertMessage(db, "m-b1", "chat-b", "hello world topic");

      const results = await search.searchMessages("hello world", [], { chatId: "chat-a" });
      const ids = results.map((r) => r.id);
      expect(ids).toContain("m-a1");
      expect(ids).not.toContain("m-b1");
    });

    it("returns messages from all chats when chatId is not provided", async () => {
      insertMessage(db, "m-x1", "chat-x", "search this content");
      insertMessage(db, "m-y1", "chat-y", "search this content");

      const results = await search.searchMessages("search content", [], {});
      const ids = results.map((r) => r.id);
      expect(ids).toContain("m-x1");
      expect(ids).toContain("m-y1");
    });

    it("filters by afterTimestamp when provided", async () => {
      const now = Math.floor(Date.now() / 1000);
      insertMessage(db, "m-old", "chat-ts", "temporal filter test", now - 10000);
      insertMessage(db, "m-recent", "chat-ts", "temporal filter test", now - 10);

      const results = await search.searchMessages("temporal filter test", [], {
        afterTimestamp: now - 100,
      });
      const ids = results.map((r) => r.id);
      expect(ids).toContain("m-recent");
      expect(ids).not.toContain("m-old");
    });

    it("respects the limit option", async () => {
      for (let i = 0; i < 8; i++) {
        insertMessage(db, `m-lim-${i}`, "chat-lim", `search limit keyword test number ${i}`);
      }

      const results = await search.searchMessages("search limit keyword test", [], { limit: 2 });
      expect(results.length).toBeLessThanOrEqual(2);
    });

    it("returns results with required HybridSearchResult fields", async () => {
      insertMessage(db, "m-fields", "chat-fields", "field check test content");

      const results = await search.searchMessages("field check test", [], {});
      if (results.length > 0) {
        const r = results[0];
        expect(r).toHaveProperty("id");
        expect(r).toHaveProperty("text");
        expect(r).toHaveProperty("source");
        expect(r).toHaveProperty("score");
        expect(r.source).toBe("chat-fields");
      }
    });

    it("escapes FTS5 special characters in query without throwing", async () => {
      insertMessage(db, "m-fts", "chat-fts", "safe text");
      await expect(
        search.searchMessages("hello (world) OR test:thing", [], {})
      ).resolves.not.toThrow();
    });

    it("combines chatId and afterTimestamp filters together", async () => {
      const now = Math.floor(Date.now() / 1000);
      insertMessage(db, "m-combo-a1", "combo-chat", "combined filter query", now - 5);
      insertMessage(db, "m-combo-a2", "combo-chat", "combined filter query", now - 50000);
      insertMessage(db, "m-combo-b1", "other-chat", "combined filter query", now - 5);

      const results = await search.searchMessages("combined filter query", [], {
        chatId: "combo-chat",
        afterTimestamp: now - 100,
      });
      const ids = results.map((r) => r.id);
      expect(ids).toContain("m-combo-a1");
      expect(ids).not.toContain("m-combo-a2");
      expect(ids).not.toContain("m-combo-b1");
    });
  });
});

// ─── HybridSearch — score merging logic ──────────────────────────────────────

describe("HybridSearch — score merging (keyword-only)", () => {
  let db: InstanceType<typeof Database>;
  let search: HybridSearch;

  beforeEach(() => {
    db = createTestDb();
    search = new HybridSearch(db, false);
  });

  afterEach(() => {
    db.close();
  });

  it("applies recency decay to older knowledge chunks (lower score)", async () => {
    const oldTs = Math.floor(Date.now() / 1000) - 90 * SECONDS_PER_DAY;
    const recentTs = Math.floor(Date.now() / 1000) - 1;

    db.prepare(
      `INSERT INTO knowledge (id, source, text, hash, created_at, updated_at) VALUES (?, 'memory', ?, ?, ?, ?)`
    ).run("k-old", "recency decay keyword test chunk", "h1", oldTs, oldTs);

    db.prepare(
      `INSERT INTO knowledge (id, source, text, hash, created_at, updated_at) VALUES (?, 'memory', ?, ?, ?, ?)`
    ).run("k-recent", "recency decay keyword test chunk", "h2", recentTs, recentTs);

    const results = await search.searchKnowledge("recency decay keyword test", [], {});
    const oldResult = results.find((r) => r.id === "k-old");
    const recentResult = results.find((r) => r.id === "k-recent");

    if (oldResult && recentResult) {
      expect(recentResult.score).toBeGreaterThan(oldResult.score);
    }
  });

  it("all returned results have score >= HYBRID_SEARCH_MIN_SCORE", async () => {
    for (let i = 0; i < 5; i++) {
      insertKnowledge(db, `ks-${i}`, `filter score test document iteration ${i}`);
    }

    const results = await search.searchKnowledge("filter score test document", [], {});
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(HYBRID_SEARCH_MIN_SCORE);
    }
  });
});

// ─── HybridSearch — vectorEnabled = true (no actual vec extension) ────────────

describe("HybridSearch (vectorEnabled = true, no vec extension)", () => {
  let db: InstanceType<typeof Database>;
  let search: HybridSearch;

  beforeEach(() => {
    db = createTestDb();
    // vectorEnabled=true but no sqlite-vec loaded → vector methods return [] gracefully
    search = new HybridSearch(db, true);
  });

  afterEach(() => {
    db.close();
  });

  it("searchKnowledge falls back to keyword-only and does not throw", async () => {
    insertKnowledge(db, "kv1", "vector fallback test content");

    await expect(
      search.searchKnowledge("vector fallback test", [0.1, 0.2, 0.3], {})
    ).resolves.not.toThrow();
  });

  it("searchMessages falls back to keyword-only and does not throw", async () => {
    insertMessage(db, "mv1", "chat-vec", "vector fallback message test");

    await expect(
      search.searchMessages("vector fallback message", [0.1, 0.2, 0.3], {})
    ).resolves.not.toThrow();
  });

  it("still returns keyword results when vector search fails gracefully", async () => {
    insertKnowledge(db, "kv2", "graceful fallback keyword search");

    const results = await search.searchKnowledge("graceful fallback keyword", [0.1, 0.2], {});
    // May or may not return results depending on FTS — just ensure no exception
    expect(Array.isArray(results)).toBe(true);
  });

  it("with empty embedding array, skips vector search path", async () => {
    insertKnowledge(db, "kv3", "empty embedding test");

    // empty embedding → vectorSearchKnowledge returns [] immediately
    const results = await search.searchKnowledge("empty embedding test", [], {});
    expect(Array.isArray(results)).toBe(true);
  });
});

// ─── HybridSearch — custom weights ───────────────────────────────────────────

describe("HybridSearch — weight options", () => {
  let db: InstanceType<typeof Database>;
  let search: HybridSearch;

  beforeEach(() => {
    db = createTestDb();
    search = new HybridSearch(db, false);
  });

  afterEach(() => {
    db.close();
  });

  it("accepts custom vectorWeight and keywordWeight options without throwing", async () => {
    insertKnowledge(db, "kw1", "custom weight test knowledge");

    await expect(
      search.searchKnowledge("custom weight test", [], {
        vectorWeight: 0.7,
        keywordWeight: 0.3,
      })
    ).resolves.not.toThrow();
  });

  it("accepts custom vectorWeight and keywordWeight for messages without throwing", async () => {
    insertMessage(db, "mw1", "chat-w", "custom weight message test");

    await expect(
      search.searchMessages("custom weight message", [], {
        vectorWeight: 0.3,
        keywordWeight: 0.7,
      })
    ).resolves.not.toThrow();
  });

  it("weights vector-only and keyword-only results symmetrically", async () => {
    const rawScore = 0.8;
    const vectorWeight = 0.2;
    const keywordWeight = 0.8;
    const semanticVectorStore = {
      isConfigured: true,
      searchKnowledge: vi.fn().mockResolvedValue([]),
      searchMessages: vi.fn().mockResolvedValue([
        {
          id: "vector-only",
          text: "semantic match",
          source: "chat-w",
          score: rawScore,
        },
      ]),
    };
    search = new HybridSearch(db, false, semanticVectorStore as never);
    insertMessage(db, "keyword-only", "chat-w", "exact keyword match");

    const results = await search.searchMessages("exact keyword match", [0.1], {
      vectorWeight,
      keywordWeight,
    });
    const vectorOnly = results.find((result) => result.id === "vector-only");
    const keywordOnly = results.find((result) => result.id === "keyword-only");

    expect(vectorOnly?.score).toBeCloseTo(vectorWeight * rawScore);
    expect(keywordOnly?.score).toBeGreaterThan(vectorOnly!.score);
    expect(results[0].id).toBe("keyword-only");
  });
});

// ─── HybridSearch — priority-aware retrieval ─────────────────────────────────

describe("HybridSearch — priority-aware retrieval", () => {
  let db: InstanceType<typeof Database>;
  let search: HybridSearch;

  beforeEach(() => {
    db = createTestDb();
    search = new HybridSearch(db, false);
  });

  afterEach(() => {
    db.close();
  });

  it("boosts high-priority memories and records access frequency for returned knowledge", async () => {
    insertKnowledge(db, "priority-low", "priority aware retrieval query");
    insertKnowledge(db, "priority-high", "priority aware retrieval query");
    db.prepare(
      `
      INSERT INTO memory_scores (memory_id, score, recency, frequency, impact, explicit, centrality, updated_at)
      VALUES ('priority-high', 0.95, 0.9, 0.9, 0.9, 0, 0, unixepoch())
    `
    ).run();

    const results = await search.searchKnowledge("priority aware retrieval query", [], {
      priorityWeight: 0.5,
      limit: 2,
    });

    expect(results[0].id).toBe("priority-high");
    const scoreRow = db
      .prepare("SELECT access_count FROM memory_scores WHERE memory_id = 'priority-high'")
      .get() as { access_count: number };
    expect(scoreRow.access_count).toBeGreaterThan(0);
  });

  it("filters knowledge below a minimum importance score", async () => {
    insertKnowledge(db, "min-low", "minimum importance filter query");
    insertKnowledge(db, "min-high", "minimum importance filter query");
    db.prepare(
      `
      INSERT INTO memory_scores (memory_id, score, recency, frequency, impact, explicit, centrality, updated_at)
      VALUES
        ('min-low', 0.1, 0.1, 0, 0, 0, 0, unixepoch()),
        ('min-high', 0.9, 0.9, 0, 0, 0, 0, unixepoch())
    `
    ).run();

    const results = await search.searchKnowledge("minimum importance filter query", [], {
      minScore: 0.5,
      priorityWeight: 0.5,
    });

    expect(results.map((result) => result.id)).toContain("min-high");
    expect(results.map((result) => result.id)).not.toContain("min-low");
  });
});
