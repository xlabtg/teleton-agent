// Comprehensive Audit Trail Service
// Captures agent decisions, tool calls, LLM activity, user actions, and security
// validations in a hash-chained table suitable for forensic reconstruction.

import { createHash, randomUUID } from "crypto";
import { EventEmitter } from "events";
import type { Database } from "better-sqlite3";

export const AUDIT_EVENT_TYPES = [
  "agent.decision",
  "tool.invoke",
  "tool.result",
  "llm.request",
  "llm.response",
  "config.change",
  "security.validation",
  "network.message",
  "user.action",
  "session.lifecycle",
] as const;

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];
export type AuditExportFormat = "json" | "csv";
export type AuditReportType = "daily_activity" | "security_events" | "cost_resource" | "tool_usage";

export interface AuditEventInput {
  eventType: AuditEventType;
  actor?: string;
  sessionId?: string | null;
  payload?: Record<string, unknown>;
  parentEventId?: string | null;
  createdAt?: number;
}

interface AuditEventRow {
  id: string;
  sequence: number;
  event_type: AuditEventType;
  actor: string;
  session_id: string | null;
  payload: string;
  parent_event_id: string | null;
  previous_checksum: string | null;
  checksum: string;
  created_at: number;
}

export interface AuditEventRecord {
  id: string;
  sequence: number;
  event_type: AuditEventType;
  actor: string;
  session_id: string | null;
  payload: Record<string, unknown>;
  parent_event_id: string | null;
  previous_checksum: string | null;
  checksum: string;
  created_at: number;
}

export interface AuditEventPage {
  entries: AuditEventRecord[];
  total: number;
  page: number;
  limit: number;
}

export interface AuditVerifyResult {
  valid: boolean;
  checked: number;
  from: number | null;
  to: number | null;
  brokenAtEventId: string | null;
  expectedChecksum: string | null;
  actualChecksum: string | null;
  errors: string[];
}

export interface AuditChain {
  targetEventId: string;
  events: AuditEventRecord[];
}

export interface AuditReport {
  type: AuditReportType;
  generatedAt: string;
  periodHours: number;
  rows: Array<Record<string, unknown>>;
  summary: Record<string, unknown>;
}

export interface AuditExportResult {
  body: string;
  contentType: string;
  filename: string;
  signature: string;
}

export const auditTrailBus = new EventEmitter();

function hashHex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeForJson(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === undefined) return null;
  if (value === null) return null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "symbol" || typeof value === "function") {
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.map((item) => normalizeForJson(item, seen));
  }
  if (typeof value === "object") {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = normalizeForJson(source[key], seen);
    }
    seen.delete(value);
    return sorted;
  }
  return String(value);
}

function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeForJson(value));
}

function parsePayload(payload: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through to raw payload wrapper.
  }
  return { raw: payload };
}

function csvEscape(value: unknown): string {
  const text = value == null ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function toNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export class AuditTrailService {
  private readonly db: Database;
  private readonly maxPayloadBytes: number;

  constructor(db: Database, opts: { maxPayloadBytes?: number } = {}) {
    this.db = db;
    this.maxPayloadBytes = opts.maxPayloadBytes ?? 16 * 1024;
    this.ensureTable();
  }

  private ensureTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_anchor (id INTEGER PRIMARY KEY CHECK(id = 1), sequence INTEGER NOT NULL, checksum TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit_events (
        id                TEXT PRIMARY KEY,
        sequence          INTEGER NOT NULL UNIQUE,
        event_type        TEXT NOT NULL,
        actor             TEXT NOT NULL DEFAULT 'system',
        session_id        TEXT,
        payload           TEXT NOT NULL DEFAULT '{}',
        parent_event_id   TEXT,
        previous_checksum TEXT,
        checksum          TEXT NOT NULL,
        created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
        FOREIGN KEY (parent_event_id) REFERENCES audit_events(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_audit_events_created ON audit_events(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_events_type ON audit_events(event_type, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_events_session ON audit_events(session_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_events_actor ON audit_events(actor, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_events_parent ON audit_events(parent_event_id);
      CREATE INDEX IF NOT EXISTS idx_audit_events_sequence ON audit_events(sequence);
    `);
  }

  recordEvent(input: AuditEventInput): AuditEventRecord {
    const insert = this.db.transaction((event: AuditEventInput) => {
      const previous = this.db
        .prepare(`SELECT sequence, checksum FROM audit_events ORDER BY sequence DESC LIMIT 1`)
        .get() as { sequence: number; checksum: string } | undefined;
      const anchor = this.db
        .prepare("SELECT sequence, checksum FROM audit_anchor WHERE id = 1")
        .get() as { sequence: number; checksum: string } | undefined;
      const predecessor = previous ?? anchor;

      const rowWithoutChecksum = {
        id: randomUUID(),
        sequence: (predecessor?.sequence ?? 0) + 1,
        event_type: event.eventType,
        actor: event.actor ?? "system",
        session_id: event.sessionId ?? null,
        payload: this.serializePayload(event.payload ?? {}),
        parent_event_id: event.parentEventId ?? null,
        previous_checksum: predecessor?.checksum ?? null,
        created_at: event.createdAt ?? Math.floor(Date.now() / 1000),
      };
      const checksum = this.computeChecksum(rowWithoutChecksum);

      this.db
        .prepare(
          `INSERT INTO audit_events (
             id, sequence, event_type, actor, session_id, payload,
             parent_event_id, previous_checksum, checksum, created_at
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          rowWithoutChecksum.id,
          rowWithoutChecksum.sequence,
          rowWithoutChecksum.event_type,
          rowWithoutChecksum.actor,
          rowWithoutChecksum.session_id,
          rowWithoutChecksum.payload,
          rowWithoutChecksum.parent_event_id,
          rowWithoutChecksum.previous_checksum,
          checksum,
          rowWithoutChecksum.created_at
        );

      return this.getEvent(rowWithoutChecksum.id);
    });

    const record = insert(input);
    auditTrailBus.emit("event", record);
    return record;
  }

  listEvents(
    opts: {
      page?: number;
      limit?: number;
      eventType?: AuditEventType | null;
      sessionId?: string | null;
      actor?: string | null;
      since?: number | null;
      until?: number | null;
    } = {}
  ): AuditEventPage {
    const page = Math.max(1, opts.page ?? 1);
    const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
    const offset = (page - 1) * limit;
    const { where, params } = this.buildWhere(opts);

    const countRow = this.db
      .prepare(`SELECT COUNT(*) AS total FROM audit_events ${where}`)
      .get(...params) as { total: number };
    const rows = this.db
      .prepare(`SELECT * FROM audit_events ${where} ORDER BY sequence DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as AuditEventRow[];

    return {
      entries: rows.map((row) => this.toRecord(row)),
      total: countRow.total,
      page,
      limit,
    };
  }

  getDecisionChain(eventId: string): AuditChain {
    const events: AuditEventRecord[] = [];
    let currentId: string | null = eventId;
    let depth = 0;

    while (currentId && depth < 100) {
      const row = this.getEventRow(currentId);
      if (!row) break;
      events.unshift(this.toRecord(row));
      currentId = row.parent_event_id;
      depth++;
    }

    return { targetEventId: eventId, events };
  }

  verifyIntegrity(opts: { since?: number | null; until?: number | null } = {}): AuditVerifyResult {
    const { where, params } = this.buildWhere({ since: opts.since, until: opts.until });
    const rows = this.db
      .prepare(`SELECT * FROM audit_events ${where} ORDER BY sequence ASC`)
      .all(...params) as AuditEventRow[];

    let previousChecksum: string | null = null;
    if (rows[0]) {
      const previous = this.db
        .prepare(
          `SELECT checksum FROM audit_events WHERE sequence < ? ORDER BY sequence DESC LIMIT 1`
        )
        .get(rows[0].sequence) as { checksum: string } | undefined;
      const anchor = this.db
        .prepare("SELECT checksum FROM audit_anchor WHERE id = 1 AND sequence < ?")
        .get(rows[0].sequence) as { checksum: string } | undefined;
      previousChecksum = previous?.checksum ?? anchor?.checksum ?? null;
    }

    const result: AuditVerifyResult = {
      valid: true,
      checked: rows.length,
      from: opts.since ?? null,
      to: opts.until ?? null,
      brokenAtEventId: null,
      expectedChecksum: null,
      actualChecksum: null,
      errors: [],
    };

    for (const row of rows) {
      if (row.previous_checksum !== previousChecksum) {
        result.valid = false;
        result.brokenAtEventId = row.id;
        result.expectedChecksum = previousChecksum;
        result.actualChecksum = row.previous_checksum;
        result.errors.push(`Previous checksum mismatch at event ${row.id}`);
        return result;
      }

      const expected = this.computeChecksum({
        id: row.id,
        sequence: row.sequence,
        event_type: row.event_type,
        actor: row.actor,
        session_id: row.session_id,
        payload: row.payload,
        parent_event_id: row.parent_event_id,
        previous_checksum: row.previous_checksum,
        created_at: row.created_at,
      });
      if (row.checksum !== expected) {
        result.valid = false;
        result.brokenAtEventId = row.id;
        result.expectedChecksum = expected;
        result.actualChecksum = row.checksum;
        result.errors.push(`Checksum mismatch at event ${row.id}`);
        return result;
      }

      previousChecksum = row.checksum;
    }

    return result;
  }

  generateReport(type: AuditReportType, opts: { periodHours?: number } = {}): AuditReport {
    const periodHours = Math.max(1, opts.periodHours ?? 24);
    const since = Math.floor(Date.now() / 1000) - periodHours * 3600;
    const rows = this.db
      .prepare(`SELECT * FROM audit_events WHERE created_at >= ? ORDER BY sequence ASC`)
      .all(since) as AuditEventRow[];
    const events = rows.map((row) => this.toRecord(row));

    switch (type) {
      case "daily_activity":
        return this.dailyActivityReport(type, periodHours, events);
      case "security_events":
        return this.securityEventsReport(type, periodHours, events);
      case "cost_resource":
        return this.costResourceReport(type, periodHours, events);
      case "tool_usage":
        return this.toolUsageReport(type, periodHours, events);
    }
  }

  exportEvents(
    opts: {
      format?: AuditExportFormat;
      eventType?: AuditEventType | null;
      sessionId?: string | null;
      actor?: string | null;
      since?: number | null;
      until?: number | null;
    } = {}
  ): AuditExportResult {
    const format = opts.format ?? "json";
    const { where, params } = this.buildWhere({
      eventType: opts.eventType ?? null,
      sessionId: opts.sessionId ?? null,
      actor: opts.actor ?? null,
      since: opts.since ?? null,
      until: opts.until ?? null,
    });
    const rows = this.db
      .prepare(`SELECT * FROM audit_events ${where} ORDER BY sequence ASC`)
      .all(...params) as AuditEventRow[];
    const events = rows.map((row) => this.toRecord(row));
    const verification = this.verifyIntegrity({ since: opts.since, until: opts.until });
    const generatedAt = new Date().toISOString();
    const signatureSource = { generatedAt, filters: opts, events, verification };
    const signature = hashHex(stableStringify(signatureSource));

    if (format === "csv") {
      const lines = [
        "id,sequence,event_type,actor,session_id,parent_event_id,checksum,created_at,payload",
      ];
      for (const event of events) {
        lines.push(
          [
            event.id,
            event.sequence,
            event.event_type,
            event.actor,
            event.session_id ?? "",
            event.parent_event_id ?? "",
            event.checksum,
            new Date(event.created_at * 1000).toISOString(),
            csvEscape(JSON.stringify(event.payload)),
          ].join(",")
        );
      }
      return {
        body: lines.join("\n"),
        contentType: "text/csv; charset=utf-8",
        filename: `audit-events-${Date.now()}.csv`,
        signature,
      };
    }

    const bundle = {
      ...signatureSource,
      signature: { algorithm: "sha256", value: signature },
    };
    return {
      body: JSON.stringify(bundle, null, 2),
      contentType: "application/json; charset=utf-8",
      filename: `audit-events-${Date.now()}.json`,
      signature,
    };
  }

  reportToCsv(report: AuditReport): string {
    const keys = Array.from(new Set(report.rows.flatMap((row) => Object.keys(row))));
    const lines = [keys.join(",")];
    for (const row of report.rows) {
      lines.push(keys.map((key) => csvEscape(row[key])).join(","));
    }
    return lines.join("\n");
  }

  pruneBefore(cutoffUnix: number): number {
    if (this.db.inTransaction) throw new Error("Audit pruning requires its own transaction");
    const foreignKeys = this.db.pragma("foreign_keys", { simple: true });
    // Preserve hashed parent IDs at the retention boundary (ON DELETE SET NULL would mutate them).
    this.db.pragma("foreign_keys = OFF");
    try {
      return this.db.transaction(() => {
        const boundary = this.db
          .prepare("SELECT MIN(sequence) AS seq FROM audit_events WHERE created_at >= ?")
          .get(cutoffUnix) as { seq: number | null };
        const last = this.db
          .prepare(
            "SELECT sequence, checksum FROM audit_events WHERE sequence < ? ORDER BY sequence DESC LIMIT 1"
          )
          .get(boundary.seq ?? Number.MAX_SAFE_INTEGER) as
          | { sequence: number; checksum: string }
          | undefined;
        if (!last) return 0;
        this.db
          .prepare(
            "INSERT INTO audit_anchor (id, sequence, checksum) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET sequence = excluded.sequence, checksum = excluded.checksum"
          )
          .run(last.sequence, last.checksum);
        return this.db.prepare("DELETE FROM audit_events WHERE sequence <= ?").run(last.sequence)
          .changes;
      })();
    } finally {
      this.db.pragma(`foreign_keys = ${foreignKeys ? "ON" : "OFF"}`);
    }
  }

  private serializePayload(payload: Record<string, unknown>): string {
    const json = stableStringify(payload);
    const bytes = Buffer.byteLength(json, "utf8");
    if (bytes <= this.maxPayloadBytes) return json;

    return stableStringify({
      _truncated: true,
      originalBytes: bytes,
      preview: json.slice(0, Math.max(0, this.maxPayloadBytes - 200)),
    });
  }

  private computeChecksum(row: Omit<AuditEventRow, "checksum">): string {
    return hashHex(
      stableStringify({
        id: row.id,
        sequence: row.sequence,
        event_type: row.event_type,
        actor: row.actor,
        session_id: row.session_id,
        payload: row.payload,
        parent_event_id: row.parent_event_id,
        previous_checksum: row.previous_checksum,
        created_at: row.created_at,
      })
    );
  }

  private getEvent(id: string): AuditEventRecord {
    const row = this.getEventRow(id);
    if (!row) throw new Error(`Audit event not found: ${id}`);
    return this.toRecord(row);
  }

  private getEventRow(id: string): AuditEventRow | null {
    return (
      (this.db.prepare(`SELECT * FROM audit_events WHERE id = ?`).get(id) as
        | AuditEventRow
        | undefined) ?? null
    );
  }

  private toRecord(row: AuditEventRow): AuditEventRecord {
    return {
      id: row.id,
      sequence: row.sequence,
      event_type: row.event_type,
      actor: row.actor,
      session_id: row.session_id,
      payload: parsePayload(row.payload),
      parent_event_id: row.parent_event_id,
      previous_checksum: row.previous_checksum,
      checksum: row.checksum,
      created_at: row.created_at,
    };
  }

  private buildWhere(opts: {
    eventType?: AuditEventType | null;
    sessionId?: string | null;
    actor?: string | null;
    since?: number | null;
    until?: number | null;
  }): { where: string; params: unknown[] } {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts.eventType) {
      conditions.push("event_type = ?");
      params.push(opts.eventType);
    }
    if (opts.sessionId) {
      conditions.push("session_id = ?");
      params.push(opts.sessionId);
    }
    if (opts.actor) {
      conditions.push("actor = ?");
      params.push(opts.actor);
    }
    if (opts.since != null) {
      conditions.push("created_at >= ?");
      params.push(opts.since);
    }
    if (opts.until != null) {
      conditions.push("created_at <= ?");
      params.push(opts.until);
    }

    return {
      where: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "",
      params,
    };
  }

  private dailyActivityReport(
    type: AuditReportType,
    periodHours: number,
    events: AuditEventRecord[]
  ): AuditReport {
    const byDate = new Map<
      string,
      { date: string; total: number; byType: Record<string, number> }
    >();
    for (const event of events) {
      const date = new Date(event.created_at * 1000).toISOString().slice(0, 10);
      const row = byDate.get(date) ?? { date, total: 0, byType: {} };
      row.total++;
      row.byType[event.event_type] = (row.byType[event.event_type] ?? 0) + 1;
      byDate.set(date, row);
    }
    return this.makeReport(type, periodHours, Array.from(byDate.values()), {
      totalEvents: events.length,
    });
  }

  private securityEventsReport(
    type: AuditReportType,
    periodHours: number,
    events: AuditEventRecord[]
  ): AuditReport {
    const rows = events
      .filter((event) => {
        const status = toNumber(event.payload.status);
        return (
          event.event_type === "security.validation" ||
          event.event_type === "config.change" ||
          (event.event_type === "user.action" && status >= 400)
        );
      })
      .map((event) => ({
        id: event.id,
        eventType: event.event_type,
        actor: event.actor,
        sessionId: event.session_id,
        createdAt: event.created_at,
        payload: event.payload,
      }));
    return this.makeReport(type, periodHours, rows, { totalEvents: rows.length });
  }

  private costResourceReport(
    type: AuditReportType,
    periodHours: number,
    events: AuditEventRecord[]
  ): AuditReport {
    let requestCount = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let totalTokens = 0;
    let costUsd = 0;

    for (const event of events) {
      if (event.event_type !== "llm.response") continue;
      requestCount++;
      const usage = event.payload.usage as Record<string, unknown> | undefined;
      inputTokens += toNumber(usage?.input);
      outputTokens += toNumber(usage?.output);
      totalTokens +=
        toNumber(usage?.totalTokens) ||
        toNumber(usage?.input) +
          toNumber(usage?.output) +
          toNumber(usage?.cacheRead) +
          toNumber(usage?.cacheWrite);
      costUsd += toNumber(usage?.costUsd) || toNumber(usage?.totalCost);
    }

    return this.makeReport(
      type,
      periodHours,
      [{ requestCount, inputTokens, outputTokens, totalTokens, costUsd }],
      { requestCount, totalTokens, costUsd }
    );
  }

  private toolUsageReport(
    type: AuditReportType,
    periodHours: number,
    events: AuditEventRecord[]
  ): AuditReport {
    const grouped = new Map<
      string,
      {
        tool: string;
        count: number;
        successCount: number;
        failureCount: number;
        totalDurationMs: number;
      }
    >();

    for (const event of events) {
      if (event.event_type !== "tool.result") continue;
      const tool = typeof event.payload.toolName === "string" ? event.payload.toolName : "unknown";
      const row = grouped.get(tool) ?? {
        tool,
        count: 0,
        successCount: 0,
        failureCount: 0,
        totalDurationMs: 0,
      };
      row.count++;
      if (event.payload.success === true) row.successCount++;
      else row.failureCount++;
      row.totalDurationMs += toNumber(event.payload.durationMs);
      grouped.set(tool, row);
    }

    const rows = Array.from(grouped.values())
      .map((row) => ({
        tool: row.tool,
        count: row.count,
        successCount: row.successCount,
        failureCount: row.failureCount,
        avgDurationMs: row.count > 0 ? row.totalDurationMs / row.count : 0,
      }))
      .sort((a, b) => b.count - a.count);
    return this.makeReport(type, periodHours, rows, { totalTools: rows.length });
  }

  private makeReport(
    type: AuditReportType,
    periodHours: number,
    rows: Array<Record<string, unknown>>,
    summary: Record<string, unknown>
  ): AuditReport {
    return {
      type,
      generatedAt: new Date().toISOString(),
      periodHours,
      rows,
      summary,
    };
  }
}

let _instance: AuditTrailService | null = null;
let _instanceDb: Database | null = null;

export function initAuditTrail(
  db: Database,
  opts?: { maxPayloadBytes?: number }
): AuditTrailService {
  if (_instance && _instanceDb === db && !opts) {
    return _instance;
  }
  _instance = new AuditTrailService(db, opts);
  _instanceDb = db;
  return _instance;
}

export function getAuditTrailInstance(): AuditTrailService | null {
  return _instance;
}
