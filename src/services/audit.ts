// ── Audit Service ─────────────────────────────────────────────────────────────
// Records and retrieves all admin actions for the Security Center audit log.

import type { Database } from "better-sqlite3";

export type AuditActionType =
  | "config_change"
  | "tool_toggle"
  | "soul_edit"
  | "agent_restart"
  | "agent_stop"
  | "plugin_install"
  | "plugin_remove"
  | "hook_change"
  | "mcp_change"
  | "integration_change"
  | "memory_delete"
  | "workspace_change"
  | "session_delete"
  | "secret_change"
  | "security_change"
  | "login"
  | "logout"
  | "financial_operation"
  | "other";

/** Structured record for a financial (TON/jetton) audit entry. */
export interface FinancialAuditDetails {
  operation: "ton_transfer" | "jetton_transfer" | "ton_swap" | string;
  amount: number;
  asset: string; // "TON" or jetton ticker
  recipient: string;
  comment?: string;
  /** Pseudo-hash or transaction ID returned by the operation */
  txId?: string | null;
  /** "success" | "failed" */
  status: "success" | "failed" | "pending";
  error?: string;
}

export interface AuditLogEntry {
  id: number;
  action: AuditActionType;
  details: string;
  ip: string | null;
  user_agent: string | null;
  created_at: number; // Unix timestamp (seconds)
}

export interface AuditLogPage {
  entries: AuditLogEntry[];
  total: number;
  page: number;
  limit: number;
}

export class AuditService {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
    this.ensureTable();
  }

  private ensureTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        action     TEXT    NOT NULL,
        details    TEXT    NOT NULL DEFAULT '',
        ip         TEXT,
        user_agent TEXT,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
      );

      CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_log_action     ON audit_log(action);
    `);
  }

  /** Record a new audit log entry. */
  log(
    action: AuditActionType,
    details: string,
    opts: { ip?: string | null; userAgent?: string | null } = {}
  ): void {
    this.db
      .prepare(
        `INSERT INTO audit_log (action, details, ip, user_agent)
         VALUES (?, ?, ?, ?)`
      )
      .run(action, details, opts.ip ?? null, opts.userAgent ?? null);
  }

  /**
   * Record a financial operation (TON transfer, jetton send, swap, etc.) to the
   * dedicated financial audit trail. The structured details are serialized as JSON
   * so they can be queried and exported separately from generic admin actions.
   */
  logFinancial(details: FinancialAuditDetails): void {
    this.log("financial_operation", JSON.stringify(details));
  }

  /** List audit log entries with optional filtering. */
  list(
    opts: {
      page?: number;
      limit?: number;
      action?: AuditActionType | null;
      since?: number | null; // Unix timestamp
      until?: number | null; // Unix timestamp
    } = {}
  ): AuditLogPage {
    const page = Math.max(1, opts.page ?? 1);
    const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
    const offset = (page - 1) * limit;

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts.action) {
      conditions.push("action = ?");
      params.push(opts.action);
    }
    if (opts.since != null) {
      conditions.push("created_at >= ?");
      params.push(opts.since);
    }
    if (opts.until != null) {
      conditions.push("created_at <= ?");
      params.push(opts.until);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const countRow = this.db
      .prepare(`SELECT COUNT(*) AS total FROM audit_log ${where}`)
      .get(...params) as { total: number };

    const rows = this.db
      .prepare(`SELECT * FROM audit_log ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as AuditLogEntry[];

    return {
      entries: rows,
      total: countRow.total,
      page,
      limit,
    };
  }

  /** Export all entries matching filters as CSV string. */
  exportCsv(
    opts: {
      action?: AuditActionType | null;
      since?: number | null;
      until?: number | null;
    } = {}
  ): string {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts.action) {
      conditions.push("action = ?");
      params.push(opts.action);
    }
    if (opts.since != null) {
      conditions.push("created_at >= ?");
      params.push(opts.since);
    }
    if (opts.until != null) {
      conditions.push("created_at <= ?");
      params.push(opts.until);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM audit_log ${where} ORDER BY created_at DESC`)
      .all(...params) as AuditLogEntry[];

    const lines: string[] = ["id,action,details,ip,user_agent,created_at"];
    for (const r of rows) {
      const ts = new Date(r.created_at * 1000).toISOString();
      lines.push(
        [
          r.id,
          r.action,
          `"${r.details.replace(/"/g, '""')}"`,
          r.ip ?? "",
          r.user_agent ?? "",
          ts,
        ].join(",")
      );
    }
    return lines.join("\n");
  }
}

let _instance: AuditService | null = null;

export function initAudit(db: Database): AuditService {
  if (!_instance) {
    _instance = new AuditService(db);
  }
  return _instance;
}

/**
 * Return the existing AuditService singleton without initializing it.
 * Returns null if initAudit() has not been called yet (e.g. in standalone
 * scripts or during TON transfers before the WebUI/API starts).
 */
export function getAuditInstance(): AuditService | null {
  return _instance;
}
