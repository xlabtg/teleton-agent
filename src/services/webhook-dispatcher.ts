import type { Database } from "better-sqlite3";
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchWebhookUrl, validateWebhookUrl, redactSecrets } from "./alerting.js";
import { getEventBus, type EventPayload, type TeletonEvent } from "./event-bus.js";
import { createLogger } from "../utils/logger.js";
import { TELETON_ROOT } from "../workspace/paths.js";

const log = createLogger("WebhookDispatcher");

const DEFAULT_MAX_RETRIES = 5;
const MAX_RETRIES = 10;
const DEFAULT_RETRY_BACKOFFS_MS = [1_000, 5_000, 30_000, 5 * 60_000];
const DELIVERY_TIMEOUT_MS = 5_000;
const SECRET_KEY_FILENAME = ".webhook-secret-key";
const SECRET_ALGORITHM = "aes-256-gcm";

export type WebhookDeliveryStatus = "pending" | "delivered" | "retrying" | "failed";

export interface WebhookRegistration {
  id: string;
  url: string;
  events: string[];
  active: boolean;
  maxRetries: number;
  createdAt: number;
  updatedAt: number;
}

export interface WebhookInput {
  url: string;
  events: string[];
  secret?: string;
  active?: boolean;
  maxRetries?: number;
}

export interface WebhookUpdateInput {
  url?: string;
  events?: string[];
  secret?: string;
  active?: boolean;
  maxRetries?: number;
}

export interface WebhookDelivery {
  id: string;
  webhookId: string;
  eventId: string;
  eventType: string;
  payload: EventPayload;
  status: WebhookDeliveryStatus;
  attempts: number;
  nextAttemptAt: number | null;
  lastAttemptAt: number | null;
  responseStatus: number | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

interface WebhookRow {
  id: string;
  url: string;
  events: string;
  secret: string;
  active: number;
  max_retries: number;
  created_at: number;
  updated_at: number;
}

interface DeliveryRow {
  id: string;
  webhook_id: string;
  event_id: string;
  event_type: string;
  payload: string;
  status: WebhookDeliveryStatus;
  attempts: number;
  next_attempt_at: number | null;
  last_attempt_at: number | null;
  response_status: number | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

interface StoredWebhook extends WebhookRegistration {
  secret: string;
}

interface EncryptedSecret {
  encrypted: true;
  algorithm: typeof SECRET_ALGORITHM;
  iv: string;
  tag: string;
  ciphertext: string;
}

export interface WebhookDispatcherOptions {
  enabled?: boolean;
  retryBackoffsMs?: number[];
  defaultMaxRetries?: number;
  deliveryTimeoutMs?: number;
  secretKey?: Buffer;
}

function nowMs(): number {
  return Date.now();
}

function clampMaxRetries(value: number | undefined, defaultValue = DEFAULT_MAX_RETRIES): number {
  if (value === undefined) return defaultValue;
  if (!Number.isInteger(value) || value < 1 || value > MAX_RETRIES) {
    throw new Error(`maxRetries must be an integer between 1 and ${MAX_RETRIES}`);
  }
  return value;
}

function normalizeEvents(events: string[]): string[] {
  if (!Array.isArray(events)) throw new Error("events must be an array");
  const normalized = Array.from(
    new Set(
      events
        .map((event) => (typeof event === "string" ? event.trim() : ""))
        .filter((event) => event.length > 0)
    )
  );
  if (normalized.length === 0) throw new Error("at least one event type is required");
  if (normalized.length > 50) throw new Error("maximum 50 event types are allowed");
  if (normalized.some((event) => event.length > 120)) {
    throw new Error("event types must be 120 characters or fewer");
  }
  return normalized;
}

function rowToWebhook(row: WebhookRow): WebhookRegistration {
  return {
    id: row.id,
    url: row.url,
    events: JSON.parse(row.events) as string[],
    active: row.active === 1,
    maxRetries: row.max_retries,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToDelivery(row: DeliveryRow): WebhookDelivery {
  return {
    id: row.id,
    webhookId: row.webhook_id,
    eventId: row.event_id,
    eventType: row.event_type,
    payload: JSON.parse(row.payload) as EventPayload,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    lastAttemptAt: row.last_attempt_at,
    responseStatus: row.response_status,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function matchesEvent(webhook: WebhookRegistration, type: string): boolean {
  return webhook.events.includes("*") || webhook.events.includes(type);
}

function getErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function signedHeader(secret: string, payload: string): string {
  const digest = createHmac("sha256", secret).update(payload).digest("hex");
  return `sha256=${digest}`;
}

function safeCompare(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function eventDeliveryPayload(event: TeletonEvent): EventPayload {
  return {
    id: event.id,
    type: event.type,
    timestamp: event.timestamp,
    source: event.source,
    correlationId: event.correlationId,
    payload: redactSecrets(event.payload),
  };
}

export class WebhookDispatcher {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly retryBackoffsMs: number[];
  private readonly defaultMaxRetries: number;
  private readonly deliveryTimeoutMs: number;
  private readonly secretKey?: Buffer;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly db: Database,
    options: WebhookDispatcherOptions = {}
  ) {
    this.retryBackoffsMs = options.retryBackoffsMs ?? DEFAULT_RETRY_BACKOFFS_MS;
    this.defaultMaxRetries = clampMaxRetries(options.defaultMaxRetries);
    this.deliveryTimeoutMs = options.deliveryTimeoutMs ?? DELIVERY_TIMEOUT_MS;
    this.secretKey = options.secretKey;
    this.migrate();
    if (options.enabled !== false) this.start();
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = getEventBus(this.db).subscribe("*", (event) => {
      if (!this.unsubscribe) return;
      void this.dispatchEvent(event).catch((err: unknown) => {
        log.warn({ err, eventId: event.id, eventType: event.type }, "Webhook dispatch failed");
      });
    });
    const pending = this.db
      .prepare(
        "SELECT id, next_attempt_at FROM webhook_deliveries WHERE status IN ('retrying', 'pending')"
      )
      .all() as Array<{ id: string; next_attempt_at: number | null }>;
    for (const row of pending)
      this.scheduleRetry(row.id, Math.max(0, (row.next_attempt_at ?? nowMs()) - nowMs()));
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  createWebhook(input: WebhookInput): WebhookRegistration {
    validateWebhookUrl(input.url, { resolve: false });
    const id = randomUUID();
    const events = normalizeEvents(input.events);
    const secret =
      typeof input.secret === "string" && input.secret.length > 0
        ? input.secret
        : randomBytes(32).toString("hex");
    const maxRetries = clampMaxRetries(input.maxRetries, this.defaultMaxRetries);
    const now = nowMs();

    this.db
      .prepare(
        `INSERT INTO webhooks (id, url, events, secret, active, max_retries, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.url,
        JSON.stringify(events),
        this.encryptSecret(secret),
        input.active === false ? 0 : 1,
        maxRetries,
        now,
        now
      );

    const created = this.getWebhook(id);
    if (!created) throw new Error(`Webhook ${id} not found after insert`);
    return created;
  }

  listWebhooks(): WebhookRegistration[] {
    const rows = this.db
      .prepare("SELECT * FROM webhooks ORDER BY created_at DESC")
      .all() as WebhookRow[];
    return rows.map(rowToWebhook);
  }

  getWebhook(id: string): WebhookRegistration | null {
    const row = this.getWebhookRow(id);
    return row ? rowToWebhook(row) : null;
  }

  updateWebhook(id: string, input: WebhookUpdateInput): WebhookRegistration | null {
    const existing = this.getStoredWebhook(id);
    if (!existing) return null;

    const url = input.url ?? existing.url;
    validateWebhookUrl(url, { resolve: false });
    const events = input.events ? normalizeEvents(input.events) : existing.events;
    const maxRetries =
      input.maxRetries !== undefined ? clampMaxRetries(input.maxRetries) : existing.maxRetries;
    const secret =
      typeof input.secret === "string" && input.secret.length > 0 ? input.secret : existing.secret;
    const active = input.active !== undefined ? input.active : existing.active;
    const now = nowMs();

    this.db
      .prepare(
        `UPDATE webhooks
         SET url = ?, events = ?, secret = ?, active = ?, max_retries = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        url,
        JSON.stringify(events),
        this.encryptSecret(secret),
        active ? 1 : 0,
        maxRetries,
        now,
        id
      );

    return this.getWebhook(id);
  }

  deleteWebhook(id: string): boolean {
    this.db.prepare("DELETE FROM webhook_deliveries WHERE webhook_id = ?").run(id);
    const result = this.db.prepare("DELETE FROM webhooks WHERE id = ?").run(id);
    return result.changes > 0;
  }

  listDeliveries(webhookId: string, limit = 50): WebhookDelivery[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM webhook_deliveries
         WHERE webhook_id = ?
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(webhookId, Math.min(Math.max(limit, 1), 200)) as DeliveryRow[];
    return rows.map(rowToDelivery);
  }

  getDelivery(id: string): WebhookDelivery | null {
    const row = this.db.prepare("SELECT * FROM webhook_deliveries WHERE id = ?").get(id) as
      | DeliveryRow
      | undefined;
    return row ? rowToDelivery(row) : null;
  }

  async dispatchEvent(event: TeletonEvent): Promise<WebhookDelivery[]> {
    // Inbound events are a terminal integration boundary: never reflect them outbound.
    if (event.type === "webhook.incoming") return [];
    const webhooks = this.listStoredWebhooks().filter(
      (webhook) => webhook.active && matchesEvent(webhook, event.type)
    );
    const deliveries: WebhookDelivery[] = [];
    for (const webhook of webhooks) {
      deliveries.push(await this.dispatchToWebhook(webhook, event));
    }
    return deliveries;
  }

  async testWebhook(id: string): Promise<WebhookDelivery> {
    const webhook = this.getStoredWebhook(id);
    if (!webhook) throw new Error("Webhook not found");
    const event: TeletonEvent = {
      id: randomUUID(),
      type: "webhook.test",
      timestamp: new Date().toISOString(),
      source: "webhook-dispatcher",
      correlationId: randomUUID(),
      payload: { webhookId: id, test: true },
    };
    return this.dispatchToWebhook(webhook, event);
  }

  async retryDelivery(webhookId: string, deliveryId: string): Promise<WebhookDelivery> {
    const delivery = this.getDelivery(deliveryId);
    if (!delivery || delivery.webhookId !== webhookId) throw new Error("Delivery not found");
    if (delivery.status === "delivered") return delivery;
    this.clearScheduledRetry(deliveryId);
    this.db
      .prepare(
        `UPDATE webhook_deliveries
         SET status = 'pending', next_attempt_at = NULL, updated_at = ?
         WHERE id = ?`
      )
      .run(nowMs(), deliveryId);
    return this.attemptDelivery(deliveryId);
  }

  verifyIncomingSignature(
    webhookId: string,
    rawBody: string,
    signatureHeader: string | null,
    timestampHeader?: string | null
  ): void {
    const webhook = this.getStoredWebhook(webhookId);
    if (!webhook || !webhook.active) throw new Error("Webhook not found");
    if (!signatureHeader) throw new Error("Missing X-Webhook-Signature header");
    if (
      !timestampHeader ||
      !/^\d{1,12}$/.test(timestampHeader) ||
      Math.abs(nowMs() - Number(timestampHeader) * 1000) > 300_000
    ) {
      throw new Error("Invalid or stale webhook signature timestamp");
    }
    const expected = signedHeader(webhook.secret, `inbound:${timestampHeader}.${rawBody}`);
    if (!safeCompare(signatureHeader, expected)) throw new Error("Invalid webhook signature");
    const claim = this.db.transaction(() => {
      this.db.prepare("DELETE FROM webhook_incoming_receipts WHERE expires_at < ?").run(nowMs());
      return this.db
        .prepare(
          "INSERT OR IGNORE INTO webhook_incoming_receipts (webhook_id, signature, expires_at) VALUES (?, ?, ?)"
        )
        .run(webhookId, expected, Number(timestampHeader) * 1000 + 300_000).changes;
    })();
    if (claim !== 1) throw new Error("Replayed webhook signature");
  }

  private async dispatchToWebhook(
    webhook: StoredWebhook,
    event: TeletonEvent
  ): Promise<WebhookDelivery> {
    const deliveryId = randomUUID();
    const payload = eventDeliveryPayload(event);
    const now = nowMs();
    this.db
      .prepare(
        `INSERT INTO webhook_deliveries (
           id, webhook_id, event_id, event_type, payload, status, attempts,
           next_attempt_at, last_attempt_at, response_status, error, created_at, updated_at
         )
         VALUES (?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, NULL, NULL, ?, ?)`
      )
      .run(deliveryId, webhook.id, event.id, event.type, JSON.stringify(payload), now, now);
    return this.attemptDelivery(deliveryId);
  }

  private async attemptDelivery(deliveryId: string): Promise<WebhookDelivery> {
    const row = this.getDeliveryRow(deliveryId);
    if (!row) throw new Error("Delivery not found");
    const webhook = this.getStoredWebhook(row.webhook_id);
    if (!webhook) throw new Error("Webhook not found");

    const payload = row.payload;
    const attempts = row.attempts + 1;
    const attemptedAt = nowMs();

    try {
      const response = await fetchWebhookUrl(webhook.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Event": row.event_type,
          "X-Webhook-Delivery": row.id,
          "X-Webhook-Timestamp": String(Math.floor(attemptedAt / 1000)),
          "X-Webhook-Signature": signedHeader(webhook.secret, payload),
        },
        body: payload,
        signal: AbortSignal.timeout(this.deliveryTimeoutMs),
      });

      if (!response.ok) throw new Error(`Webhook returned HTTP ${response.status}`);

      this.db
        .prepare(
          `UPDATE webhook_deliveries
           SET status = 'delivered',
               attempts = ?,
               last_attempt_at = ?,
               next_attempt_at = NULL,
               response_status = ?,
               error = NULL,
               updated_at = ?
           WHERE id = ?`
        )
        .run(attempts, attemptedAt, response.status, nowMs(), deliveryId);
    } catch (error) {
      const errorText = getErrorText(error);
      const permanent = errorText.startsWith("Webhook URL ");
      const exhausted = attempts >= webhook.maxRetries || permanent;
      const status: WebhookDeliveryStatus = exhausted ? "failed" : "retrying";
      const nextAttemptAt = exhausted ? null : attemptedAt + this.backoffForAttempt(attempts);

      this.db
        .prepare(
          `UPDATE webhook_deliveries
           SET status = ?,
               attempts = ?,
               last_attempt_at = ?,
               next_attempt_at = ?,
               response_status = NULL,
               error = ?,
               updated_at = ?
           WHERE id = ?`
        )
        .run(status, attempts, attemptedAt, nextAttemptAt, errorText, nowMs(), deliveryId);

      if (!exhausted && nextAttemptAt !== null) {
        this.scheduleRetry(deliveryId, nextAttemptAt - attemptedAt);
      }
    }

    const updated = this.getDelivery(deliveryId);
    if (!updated) throw new Error("Delivery not found after attempt");
    return updated;
  }

  private scheduleRetry(deliveryId: string, delayMs: number): void {
    this.clearScheduledRetry(deliveryId);
    const timer = setTimeout(() => {
      this.timers.delete(deliveryId);
      void this.attemptDelivery(deliveryId).catch((err: unknown) => {
        log.warn({ err, deliveryId }, "Webhook retry failed");
      });
    }, delayMs);
    timer.unref?.();
    this.timers.set(deliveryId, timer);
  }

  private clearScheduledRetry(deliveryId: string): void {
    const timer = this.timers.get(deliveryId);
    if (timer) clearTimeout(timer);
    this.timers.delete(deliveryId);
  }

  private backoffForAttempt(attempts: number): number {
    return this.retryBackoffsMs[Math.min(attempts - 1, this.retryBackoffsMs.length - 1)];
  }

  private getWebhookRow(id: string): WebhookRow | null {
    const row = this.db.prepare("SELECT * FROM webhooks WHERE id = ?").get(id) as
      | WebhookRow
      | undefined;
    return row ?? null;
  }

  private getStoredWebhook(id: string): StoredWebhook | null {
    const row = this.getWebhookRow(id);
    return row ? { ...rowToWebhook(row), secret: this.decryptSecret(row.secret) } : null;
  }

  private listStoredWebhooks(): StoredWebhook[] {
    const rows = this.db
      .prepare("SELECT * FROM webhooks ORDER BY created_at DESC")
      .all() as WebhookRow[];
    return rows.map((row) => ({ ...rowToWebhook(row), secret: this.decryptSecret(row.secret) }));
  }

  private getDeliveryRow(id: string): DeliveryRow | null {
    const row = this.db.prepare("SELECT * FROM webhook_deliveries WHERE id = ?").get(id) as
      | DeliveryRow
      | undefined;
    return row ?? null;
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS webhook_incoming_receipts (webhook_id TEXT NOT NULL, signature TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(webhook_id, signature));
      CREATE TABLE IF NOT EXISTS webhooks (
        id          TEXT PRIMARY KEY,
        url         TEXT NOT NULL,
        events      TEXT NOT NULL DEFAULT '[]',
        secret      TEXT NOT NULL,
        active      INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
        max_retries INTEGER NOT NULL DEFAULT ${DEFAULT_MAX_RETRIES},
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_webhooks_active ON webhooks(active);

      CREATE TABLE IF NOT EXISTS webhook_deliveries (
        id              TEXT PRIMARY KEY,
        webhook_id      TEXT NOT NULL,
        event_id        TEXT NOT NULL,
        event_type      TEXT NOT NULL,
        payload         TEXT NOT NULL,
        status          TEXT NOT NULL CHECK(status IN ('pending', 'delivered', 'retrying', 'failed')),
        attempts        INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER,
        last_attempt_at INTEGER,
        response_status INTEGER,
        error           TEXT,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL,
        FOREIGN KEY (webhook_id) REFERENCES webhooks(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook
        ON webhook_deliveries(webhook_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_status
        ON webhook_deliveries(status, next_attempt_at);
      CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_event
        ON webhook_deliveries(event_type, created_at DESC);
    `);
  }

  private encryptSecret(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv(SECRET_ALGORITHM, this.getSecretKey(), iv);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const encrypted: EncryptedSecret = {
      encrypted: true,
      algorithm: SECRET_ALGORITHM,
      iv: iv.toString("hex"),
      tag: cipher.getAuthTag().toString("hex"),
      ciphertext: ciphertext.toString("hex"),
    };
    return JSON.stringify(encrypted);
  }

  private decryptSecret(value: string): string {
    let encrypted: EncryptedSecret;
    try {
      const parsed = JSON.parse(value) as Partial<EncryptedSecret>;
      if (parsed.encrypted !== true || parsed.algorithm !== SECRET_ALGORITHM) return value;
      if (!parsed.iv || !parsed.tag || !parsed.ciphertext) return value;
      encrypted = parsed as EncryptedSecret;
    } catch {
      return value;
    }

    const decipher = createDecipheriv(
      encrypted.algorithm,
      this.getSecretKey(),
      Buffer.from(encrypted.iv, "hex")
    );
    decipher.setAuthTag(Buffer.from(encrypted.tag, "hex"));
    return Buffer.concat([
      decipher.update(Buffer.from(encrypted.ciphertext, "hex")),
      decipher.final(),
    ]).toString("utf8");
  }

  private getSecretKey(): Buffer {
    if (this.secretKey) {
      if (this.secretKey.length !== 32) throw new Error("Webhook secret key must be 32 bytes");
      return this.secretKey;
    }

    const envKey = process.env.TELETON_WEBHOOK_KEY;
    if (envKey) {
      if (!/^[0-9a-fA-F]{64}$/.test(envKey)) {
        throw new Error("TELETON_WEBHOOK_KEY must be a 64-character hex string");
      }
      return Buffer.from(envKey, "hex");
    }

    mkdirSync(TELETON_ROOT, { recursive: true, mode: 0o700 });
    const keyPath = join(TELETON_ROOT, SECRET_KEY_FILENAME);
    try {
      const keyHex = readFileSync(keyPath, "utf-8").trim();
      if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) {
        throw new Error("Webhook secret key file is invalid");
      }
      return Buffer.from(keyHex, "hex");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const keyHex = randomBytes(32).toString("hex");
    try {
      writeFileSync(keyPath, `${keyHex}\n`, {
        encoding: "utf-8",
        mode: 0o600,
        flag: "wx",
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return this.getSecretKey();
    }
    return Buffer.from(keyHex, "hex");
  }
}

const instances = new WeakMap<Database, WebhookDispatcher>();

export function getWebhookDispatcher(
  db: Database,
  options?: WebhookDispatcherOptions
): WebhookDispatcher {
  let instance = instances.get(db);
  if (!instance) {
    instance = new WebhookDispatcher(db, options);
    instances.set(db, instance);
  }
  return instance;
}

export function resetWebhookDispatcherForTesting(db: Database): void {
  const instance = instances.get(db);
  instance?.stop();
  instances.delete(db);
}
