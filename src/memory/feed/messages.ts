import type Database from "better-sqlite3";
import type { EmbeddingProvider } from "../embeddings/provider.js";
import { serializeEmbedding } from "../embeddings/index.js";
import type { SemanticVectorStore } from "../vector-store.js";
import { createLogger } from "../../utils/logger.js";
import {
  upsertTemporalMetadata,
  type TemporalContextConfig,
} from "../../services/temporal-context.js";

const log = createLogger("Memory");

export interface TelegramMessage {
  id: string;
  chatId: string;
  senderId: string | null;
  text: string | null;
  replyToId?: string;
  isFromAgent: boolean;
  hasMedia: boolean;
  mediaType?: string;
  timestamp: number;
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name) as { name: string } | undefined;
  return !!row;
}

function pruneMessagesBefore(db: Database.Database, cutoffSec: number): number {
  const hasMessageVec = tableExists(db, "tg_messages_vec");
  return db.transaction(() => {
    if (hasMessageVec) {
      db.prepare(
        `
        DELETE FROM tg_messages_vec
        WHERE id IN (
          SELECT id FROM tg_messages WHERE timestamp < ?
        )
      `
      ).run(cutoffSec);
    }
    const result = db.prepare("DELETE FROM tg_messages WHERE timestamp < ?").run(cutoffSec);
    return result.changes;
  })();
}

export function pruneOldMessages(db: Database.Database, maxAgeDays = 90): number {
  const cutoffSec = Math.floor(Date.now() / 1000) - maxAgeDays * 86_400;
  return pruneMessagesBefore(db, cutoffSec);
}

export class MessageStore {
  constructor(
    private db: Database.Database,
    private embedder: EmbeddingProvider,
    private vectorEnabled: boolean,
    private temporalConfig?: TemporalContextConfig,
    private semanticVectorStore?: SemanticVectorStore
  ) {}

  private ensureChat(chatId: string, isGroup: boolean = false): void {
    const existing = this.db.prepare(`SELECT id FROM tg_chats WHERE id = ?`).get(chatId);
    if (!existing) {
      this.db
        .prepare(`INSERT INTO tg_chats (id, type, is_monitored) VALUES (?, ?, 1)`)
        .run(chatId, isGroup ? "group" : "dm");
    }
  }

  private ensureUser(userId: string): void {
    if (!userId) return;
    const existing = this.db.prepare(`SELECT id FROM tg_users WHERE id = ?`).get(userId);
    if (!existing) {
      this.db.prepare(`INSERT INTO tg_users (id) VALUES (?)`).run(userId);
    }
  }

  async storeMessage(message: TelegramMessage): Promise<void> {
    this.ensureChat(message.chatId);
    if (message.senderId) {
      this.ensureUser(message.senderId);
    }

    // Compute an embedding when the local vector index OR the remote semantic
    // store needs one, so message search stays consistent with knowledge search
    // (which always dual-writes to the semantic store when configured). The
    // embedding is computed outside the DB transaction: a failure (network
    // error, provider outage) must degrade to "stored without vector" rather
    // than dropping the message row entirely.
    const needsEmbedding =
      Boolean(message.text) &&
      (this.vectorEnabled || this.semanticVectorStore?.isConfigured === true);
    let embedding: number[] = [];
    if (needsEmbedding && message.text) {
      try {
        embedding = await this.embedder.embedQuery(message.text);
      } catch (error) {
        log.warn(
          { err: error, messageId: message.id },
          "Embedding failed; storing message without vector"
        );
      }
    }
    const embeddingBuffer = serializeEmbedding(embedding);

    this.db.transaction(() => {
      this.db
        .prepare(
          `
        INSERT INTO tg_messages (
          id, chat_id, sender_id, text, embedding, reply_to_id,
          is_from_agent, has_media, media_type, timestamp
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          chat_id = excluded.chat_id,
          sender_id = excluded.sender_id,
          text = excluded.text,
          embedding = excluded.embedding,
          reply_to_id = excluded.reply_to_id,
          is_from_agent = excluded.is_from_agent,
          has_media = excluded.has_media,
          media_type = excluded.media_type,
          timestamp = excluded.timestamp,
          indexed_at = unixepoch()
      `
        )
        .run(
          message.id,
          message.chatId,
          message.senderId,
          message.text,
          embeddingBuffer,
          message.replyToId,
          message.isFromAgent ? 1 : 0,
          message.hasMedia ? 1 : 0,
          message.mediaType,
          message.timestamp
        );

      this.db
        .prepare(`UPDATE tg_chats SET last_message_at = ?, last_message_id = ? WHERE id = ?`)
        .run(message.timestamp, message.id, message.chatId);
    })();

    // Insert the vector in its own transaction so a vec0 failure (e.g. a
    // dimension mismatch when the active embedder differs from the table's
    // configured dimension) cannot roll back the already-stored message row.
    if (this.vectorEnabled) {
      try {
        this.db.transaction(() => {
          this.db.prepare(`DELETE FROM tg_messages_vec WHERE id = ?`).run(message.id);
          if (embedding.length > 0 && message.text) {
            this.db
              .prepare(`INSERT INTO tg_messages_vec (id, embedding) VALUES (?, ?)`)
              .run(message.id, embeddingBuffer);
          }
        })();
      } catch (error) {
        log.warn(
          { err: error, messageId: message.id },
          "Vector insert failed; message stored without vector"
        );
      }
    }

    upsertTemporalMetadata(this.db, "message", message.id, message.timestamp, {
      timezone: this.temporalConfig?.timezone,
      metadata: {
        chatId: message.chatId,
        senderId: message.senderId,
        isFromAgent: message.isFromAgent,
        hasMedia: message.hasMedia,
        mediaType: message.mediaType,
      },
    });

    await this.syncSemanticVectorStore(message, embedding);
  }

  /**
   * Dual-write the message vector to the remote semantic store (Upstash) so
   * semantic message search can serve matches the local index would miss.
   * Best-effort: failures fall back to the local index without blocking
   * message ingestion.
   */
  private async syncSemanticVectorStore(
    message: TelegramMessage,
    embedding: number[]
  ): Promise<void> {
    const store = this.semanticVectorStore;
    if (!store?.isConfigured || embedding.length === 0 || !message.text) return;

    try {
      await store.upsertMessages([
        {
          id: message.id,
          text: message.text,
          vector: embedding,
          metadata: {
            source: message.chatId,
            chatId: message.chatId,
            senderId: message.senderId,
            timestamp: message.timestamp,
            createdAt: message.timestamp,
            isFromAgent: message.isFromAgent,
          },
        },
      ]);
    } catch (error) {
      log.warn(
        { err: error, messageId: message.id },
        "Semantic memory message sync failed; local fallback ready"
      );
    }
  }

  pruneOldMessages(maxAgeDays = 90): number {
    const cutoffSec = Math.floor(Date.now() / 1000) - maxAgeDays * 86_400;
    return pruneMessagesBefore(this.db, cutoffSec);
  }

  getRecentMessages(chatId: string, limit: number = 20): TelegramMessage[] {
    const rows = this.db
      .prepare(
        `
      SELECT id, chat_id, sender_id, text, reply_to_id, is_from_agent, has_media, media_type, timestamp
      FROM tg_messages
      WHERE chat_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `
      )
      .all(chatId, limit) as Array<{
      id: string;
      chat_id: string;
      sender_id: string | null;
      text: string | null;
      reply_to_id: string | null;
      is_from_agent: number;
      has_media: number;
      media_type: string | null;
      timestamp: number;
    }>;

    return rows.reverse().map((row) => ({
      id: row.id,
      chatId: row.chat_id,
      senderId: row.sender_id,
      text: row.text,
      replyToId: row.reply_to_id ?? undefined,
      isFromAgent: Boolean(row.is_from_agent),
      hasMedia: Boolean(row.has_media),
      mediaType: row.media_type ?? undefined,
      timestamp: row.timestamp,
    }));
  }
}
