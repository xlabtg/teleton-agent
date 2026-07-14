import type Database from "better-sqlite3";
import { serializeEmbedding } from "../embeddings/index.js";
import {
  HYBRID_SEARCH_MIN_SCORE,
  RECENCY_DECAY_FACTOR,
  RECENCY_WEIGHT,
  SECONDS_PER_DAY,
  SECONDS_PER_HOUR,
} from "../../constants/limits.js";
import { createLogger } from "../../utils/logger.js";
import type { SemanticVectorStore } from "../vector-store.js";
import { MemoryScorer } from "../scoring.js";
import {
  applyTemporalSearchWeights,
  type TemporalSearchWeightingOptions,
} from "../../services/temporal-context.js";

const log = createLogger("Memory");

export interface HybridSearchResult {
  id: string;
  text: string;
  source: string;
  score: number;
  vectorScore?: number;
  keywordScore?: number;
  importanceScore?: number;
  temporalScore?: number;
  createdAt?: number;
}

/**
 * Parse temporal intent from a search query. Returns a Unix timestamp
 * representing the lower bound (afterTimestamp) if a time reference is found.
 */
const UNIT_SECONDS: Record<string, number> = {
  hour: SECONDS_PER_HOUR,
  day: SECONDS_PER_DAY,
  week: 7 * SECONDS_PER_DAY,
  month: 30 * SECONDS_PER_DAY,
};

export function parseTemporalIntent(query: string): { afterTimestamp?: number } {
  const now = Math.floor(Date.now() / 1000);
  const lower = query.toLowerCase();

  // "N days/hours/weeks ago" or "last N days/hours/weeks"
  const agoMatch = lower.match(/(\d+)\s*(day|hour|week|month)s?\s*ago/);
  if (agoMatch) {
    const n = parseInt(agoMatch[1], 10);
    return { afterTimestamp: now - n * (UNIT_SECONDS[agoMatch[2]] ?? SECONDS_PER_DAY) };
  }

  const lastNMatch = lower.match(/last\s+(\d+)\s*(day|hour|week|month)s?/);
  if (lastNMatch) {
    const n = parseInt(lastNMatch[1], 10);
    return { afterTimestamp: now - n * (UNIT_SECONDS[lastNMatch[2]] ?? SECONDS_PER_DAY) };
  }

  if (/\btoday\b/.test(lower)) return { afterTimestamp: now - SECONDS_PER_DAY };
  if (/\byesterday\b/.test(lower)) return { afterTimestamp: now - 2 * SECONDS_PER_DAY };
  if (/\blast\s+week\b/.test(lower)) return { afterTimestamp: now - 7 * SECONDS_PER_DAY };
  if (/\bthis\s+week\b/.test(lower)) return { afterTimestamp: now - 7 * SECONDS_PER_DAY };
  if (/\blast\s+month\b/.test(lower)) return { afterTimestamp: now - 30 * SECONDS_PER_DAY };
  if (/\brecently?\b/.test(lower)) return { afterTimestamp: now - 3 * SECONDS_PER_DAY };

  return {};
}

/**
 * Escape FTS5 special characters to prevent syntax errors.
 */
function escapeFts5Query(query: string): string {
  return query
    .replace(/["\*\-\+\(\)\:\^\~\?\.\@\#\$\%\&\!\[\]\{\}\|\\\/<>=,;'`]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Hybrid search combining vector similarity and BM25 keyword search.
 */
export class HybridSearch {
  constructor(
    private db: Database.Database,
    private vectorEnabled: boolean,
    private semanticVectorStore?: SemanticVectorStore,
    private temporalWeighting?: TemporalSearchWeightingOptions
  ) {}

  async searchKnowledge(
    query: string,
    queryEmbedding: number[],
    options: {
      limit?: number;
      vectorWeight?: number;
      keywordWeight?: number;
      minScore?: number;
      priorityWeight?: number;
    } = {}
  ): Promise<HybridSearchResult[]> {
    const limit = options.limit ?? 10;
    const vectorWeight = options.vectorWeight ?? 0.5;
    const keywordWeight = options.keywordWeight ?? 0.5;

    const semanticVectorResults = await this.semanticVectorSearchKnowledge(
      queryEmbedding,
      Math.ceil(limit * 3)
    );
    const vectorResults =
      semanticVectorResults.length > 0
        ? semanticVectorResults
        : this.vectorEnabled
          ? this.vectorSearchKnowledge(queryEmbedding, Math.ceil(limit * 3))
          : [];

    const keywordResults = this.keywordSearchKnowledge(query, Math.ceil(limit * 3));

    return this.mergeResults(vectorResults, keywordResults, vectorWeight, keywordWeight, limit, {
      applyMemoryScores: true,
      minScore: options.minScore,
      priorityWeight: options.priorityWeight,
      recordAccess: true,
    });
  }

  async searchMessages(
    query: string,
    queryEmbedding: number[],
    options: {
      chatId?: string;
      limit?: number;
      vectorWeight?: number;
      keywordWeight?: number;
      afterTimestamp?: number;
    } = {}
  ): Promise<HybridSearchResult[]> {
    const limit = options.limit ?? 10;
    const vectorWeight = options.vectorWeight ?? 0.5;
    const keywordWeight = options.keywordWeight ?? 0.5;

    const semanticVectorResults = await this.semanticVectorSearchMessages(
      queryEmbedding,
      Math.ceil(limit * 3),
      { chatId: options.chatId, afterTimestamp: options.afterTimestamp }
    );
    const vectorResults =
      semanticVectorResults.length > 0
        ? semanticVectorResults
        : this.vectorEnabled
          ? this.vectorSearchMessages(
              queryEmbedding,
              Math.ceil(limit * 3),
              options.chatId,
              options.afterTimestamp
            )
          : [];

    const keywordResults = this.keywordSearchMessages(
      query,
      Math.ceil(limit * 3),
      options.chatId,
      options.afterTimestamp
    );

    return this.mergeResults(vectorResults, keywordResults, vectorWeight, keywordWeight, limit);
  }

  private vectorSearchKnowledge(embedding: number[], limit: number): HybridSearchResult[] {
    if (!this.vectorEnabled || embedding.length === 0) return [];

    try {
      const embeddingBuffer = serializeEmbedding(embedding);

      const rows = this.db
        .prepare(
          `
        SELECT kv.id, k.text, COALESCE(k.path, k.source) as source, kv.distance, k.created_at
        FROM (
          SELECT id, distance
          FROM knowledge_vec
          WHERE embedding MATCH ? AND k = ?
        ) kv
        JOIN knowledge k ON k.id = kv.id
      `
        )
        .all(embeddingBuffer, limit) as Array<{
        id: string;
        text: string;
        source: string;
        distance: number;
        created_at: number | null;
      }>;

      return rows.map((row) => ({
        id: row.id,
        text: row.text,
        source: row.source,
        score: 1 - row.distance,
        vectorScore: 1 - row.distance,
        createdAt: row.created_at ?? undefined,
      }));
    } catch (error) {
      log.error({ err: error }, "Vector search error (knowledge)");
      return [];
    }
  }

  private async semanticVectorSearchKnowledge(
    embedding: number[],
    limit: number
  ): Promise<HybridSearchResult[]> {
    if (!this.semanticVectorStore?.isConfigured || embedding.length === 0) return [];

    try {
      return await this.semanticVectorStore.searchKnowledge(embedding, limit);
    } catch (error) {
      log.warn({ err: error }, "Semantic Memory: Fallback Mode (Upstash Vector search failed)");
      return [];
    }
  }

  private async semanticVectorSearchMessages(
    embedding: number[],
    limit: number,
    options: { chatId?: string; afterTimestamp?: number }
  ): Promise<HybridSearchResult[]> {
    if (!this.semanticVectorStore?.isConfigured || embedding.length === 0) return [];

    try {
      return await this.semanticVectorStore.searchMessages(embedding, limit, options);
    } catch (error) {
      log.warn(
        { err: error },
        "Semantic Memory: Fallback Mode (Upstash Vector message search failed)"
      );
      return [];
    }
  }

  private keywordSearchKnowledge(query: string, limit: number): HybridSearchResult[] {
    const safeQuery = escapeFts5Query(query);
    if (!safeQuery) return [];

    try {
      const rows = this.db
        .prepare(
          `
        SELECT k.id, k.text, COALESCE(k.path, k.source) as source, rank as score, k.created_at
        FROM knowledge_fts kf
        JOIN knowledge k ON k.rowid = kf.rowid
        WHERE knowledge_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `
        )
        .all(safeQuery, limit) as Array<{
        id: string;
        text: string;
        source: string;
        score: number;
        created_at: number | null;
      }>;

      return rows.map((row) => ({
        ...row,
        keywordScore: this.bm25ToScore(row.score),
        createdAt: row.created_at ?? undefined,
      }));
    } catch (error) {
      log.error({ err: error }, "FTS5 search error (knowledge)");
      return [];
    }
  }

  private vectorSearchMessages(
    embedding: number[],
    limit: number,
    chatId?: string,
    afterTimestamp?: number
  ): HybridSearchResult[] {
    if (!this.vectorEnabled || embedding.length === 0) return [];

    try {
      const embeddingBuffer = serializeEmbedding(embedding);
      const conditions: string[] = [];
      const params: unknown[] = [embeddingBuffer, limit];

      if (chatId) {
        conditions.push("m.chat_id = ?");
        params.push(chatId);
      }
      if (afterTimestamp) {
        conditions.push("m.timestamp >= ?");
        params.push(afterTimestamp);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      const sql = `
        SELECT mv.id, m.text, m.chat_id as source, mv.distance, m.timestamp
        FROM (
          SELECT id, distance
          FROM tg_messages_vec
          WHERE embedding MATCH ? AND k = ?
        ) mv
        JOIN tg_messages m ON m.id = mv.id
        ${whereClause}
      `;

      const rows = this.db.prepare(sql).all(...params) as Array<{
        id: string;
        text: string;
        source: string;
        distance: number;
        timestamp: number | null;
      }>;

      return rows.map((row) => ({
        id: row.id,
        text: row.text ?? "",
        source: row.source,
        score: 1 - row.distance,
        vectorScore: 1 - row.distance,
        createdAt: row.timestamp ?? undefined,
      }));
    } catch (error) {
      log.error({ err: error }, "Vector search error (messages)");
      return [];
    }
  }

  private keywordSearchMessages(
    query: string,
    limit: number,
    chatId?: string,
    afterTimestamp?: number
  ): HybridSearchResult[] {
    const safeQuery = escapeFts5Query(query);
    if (!safeQuery) return [];

    try {
      const conditions: string[] = ["tg_messages_fts MATCH ?"];
      const params: unknown[] = [safeQuery];

      if (chatId) {
        conditions.push("m.chat_id = ?");
        params.push(chatId);
      }
      if (afterTimestamp) {
        conditions.push("m.timestamp >= ?");
        params.push(afterTimestamp);
      }
      params.push(limit);

      const sql = `
        SELECT m.id, m.text, m.chat_id as source, rank as score, m.timestamp
        FROM tg_messages_fts mf
        JOIN tg_messages m ON m.rowid = mf.rowid
        WHERE ${conditions.join(" AND ")}
        ORDER BY rank
        LIMIT ?
      `;

      const rows = this.db.prepare(sql).all(...params) as Array<{
        id: string;
        text: string;
        source: string;
        score: number;
        timestamp: number | null;
      }>;

      return rows.map((row) => ({
        ...row,
        text: row.text ?? "",
        keywordScore: this.bm25ToScore(row.score),
        createdAt: row.timestamp ?? undefined,
      }));
    } catch (error) {
      log.error({ err: error }, "FTS5 search error (messages)");
      return [];
    }
  }

  private mergeResults(
    vectorResults: HybridSearchResult[],
    keywordResults: HybridSearchResult[],
    vectorWeight: number,
    keywordWeight: number,
    limit: number,
    options: {
      applyMemoryScores?: boolean;
      minScore?: number;
      priorityWeight?: number;
      recordAccess?: boolean;
    } = {}
  ): HybridSearchResult[] {
    const byId = new Map<string, HybridSearchResult>();

    for (const r of vectorResults) {
      byId.set(r.id, { ...r, score: vectorWeight * r.score, vectorScore: r.score });
    }

    for (const r of keywordResults) {
      const existing = byId.get(r.id);
      if (existing) {
        existing.keywordScore = r.keywordScore;
        existing.score =
          vectorWeight * (existing.vectorScore ?? 0) + keywordWeight * (r.keywordScore ?? 0);
      } else {
        byId.set(r.id, { ...r, score: keywordWeight * (r.keywordScore ?? 0) });
      }
    }

    const now = Math.floor(Date.now() / 1000);
    const results = Array.from(byId.values());
    for (const r of results) {
      if (r.createdAt) {
        const ageDays = Math.max(0, (now - r.createdAt) / SECONDS_PER_DAY);
        const boost = 1 / (1 + ageDays * RECENCY_DECAY_FACTOR);
        r.score *= 1 - RECENCY_WEIGHT + RECENCY_WEIGHT * boost;
      }
    }

    applyTemporalSearchWeights(results, {
      ...this.temporalWeighting,
      now,
    });

    if (options.applyMemoryScores) {
      this.applyMemoryPriority(results, options);
    }

    const filtered = results
      .filter((r) => r.score >= HYBRID_SEARCH_MIN_SCORE)
      .filter((r) => options.minScore === undefined || (r.importanceScore ?? 0) >= options.minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    if (options.applyMemoryScores && options.recordAccess) {
      new MemoryScorer(this.db).recordAccess(filtered.map((result) => result.id));
    }

    return filtered;
  }

  private applyMemoryPriority(
    results: HybridSearchResult[],
    options: { minScore?: number; priorityWeight?: number }
  ): void {
    if (results.length === 0) return;
    const ids = [...new Set(results.map((result) => result.id))];
    const placeholders = ids.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `
        SELECT memory_id, score
        FROM memory_scores
        WHERE memory_id IN (${placeholders})
      `
      )
      .all(...ids) as Array<{ memory_id: string; score: number }>;
    const scoreById = new Map(rows.map((row) => [row.memory_id, row.score]));
    const priorityWeight = Math.max(0, Math.min(1, options.priorityWeight ?? 0.25));

    for (const result of results) {
      const importanceScore = scoreById.get(result.id);
      if (importanceScore === undefined) continue;
      result.importanceScore = importanceScore;
      result.score = (1 - priorityWeight) * result.score + priorityWeight * importanceScore;
    }
  }

  /**
   * Convert BM25 rank to normalized score.
   * FTS5 rank is negative; more negative = better match.
   */
  private bm25ToScore(rank: number): number {
    return 1 / (1 + Math.exp(rank));
  }
}
