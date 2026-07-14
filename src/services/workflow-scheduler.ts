import type Database from "better-sqlite3";
import { timingSafeEqual } from "node:crypto";
import type { ITelegramBridge } from "../telegram/bridge-interface.js";
import { WorkflowStore } from "./workflows.js";
import type { CronTrigger, EventTrigger, WebhookTrigger } from "./workflows.js";
import { WorkflowExecutor } from "./workflow-executor.js";
import { createLogger } from "../utils/logger.js";
import { getEventBus } from "./event-bus.js";

const log = createLogger("WorkflowScheduler");

const TICK_INTERVAL_MS = 60_000;

export type WorkflowEventName = "agent.start" | "agent.stop" | "agent.error" | "tool.complete";

export function matchWebhookSecret(expected: string | undefined, provided: string): boolean {
  if (!expected || !provided) return false;
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);
  if (expectedBuffer.length !== providedBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, providedBuffer);
}

export class WorkflowScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private store: WorkflowStore;
  private runningWorkflowIds = new Set<string>();

  constructor(
    private db: Database.Database,
    private bridge?: ITelegramBridge
  ) {
    this.store = new WorkflowStore(db);
  }

  start(): void {
    if (this.timer) return;
    void this.tick().catch((err) => {
      log.warn({ err }, "Workflow scheduler initial tick failed");
    });
    this.timer = setInterval(() => {
      void this.tick().catch((err) => {
        log.warn({ err }, "Workflow scheduler tick failed");
      });
    }, TICK_INTERVAL_MS);
    this.timer.unref?.();
    log.info("Workflow scheduler started");
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    log.info("Workflow scheduler stopped");
  }

  async fireEvent(event: WorkflowEventName): Promise<void> {
    const workflows = this.store.list();
    const enabled = workflows.filter(
      (w) =>
        w.enabled &&
        w.config.trigger.type === "event" &&
        (w.config.trigger as EventTrigger).event === event
    );
    for (const wf of enabled) {
      log.info({ workflowId: wf.id, event }, "Firing event workflow");
      await this.execute(wf.id);
    }
  }

  async handleWebhook(secret: string): Promise<boolean> {
    const workflows = this.store.list();
    const matching = workflows.filter(
      (w) =>
        w.enabled &&
        w.config.trigger.type === "webhook" &&
        matchWebhookSecret((w.config.trigger as WebhookTrigger).secret, secret)
    );
    if (matching.length === 0) return false;
    for (const wf of matching) {
      log.info({ workflowId: wf.id }, "Firing webhook workflow");
      await this.execute(wf.id);
    }
    return true;
  }

  private async tick(): Promise<void> {
    const now = new Date();
    const bucket = Math.floor(Date.now() / 60_000);
    const workflows = this.store.list();
    const cronWorkflows = workflows.filter((w) => w.enabled && w.config.trigger.type === "cron");
    for (const wf of cronWorkflows) {
      const trigger = wf.config.trigger as CronTrigger;
      if (!cronMatches(trigger.cron, now)) continue;
      if (this.runningWorkflowIds.has(wf.id)) {
        log.warn({ workflowId: wf.id }, "Skipping cron workflow already running");
        continue;
      }
      if (wf.lastFiredBucket === bucket) {
        log.warn({ workflowId: wf.id, bucket }, "Skipping cron workflow already fired this minute");
        continue;
      }
      log.info({ workflowId: wf.id, cron: trigger.cron }, "Firing cron workflow");
      this.store.recordFiredBucket(wf.id, bucket);
      void getEventBus(this.db)
        .publish({
          type: "schedule.triggered",
          source: "workflow-scheduler",
          payload: {
            workflowId: wf.id,
            workflowName: wf.name,
            cron: trigger.cron,
            bucket,
          },
        })
        .catch((err: unknown) => {
          log.warn({ err, workflowId: wf.id }, "Schedule event publish failed");
        });
      await this.execute(wf.id);
    }
  }

  private async execute(workflowId: string): Promise<void> {
    if (this.runningWorkflowIds.has(workflowId)) {
      log.warn({ workflowId }, "Skipping workflow already running");
      return;
    }
    this.runningWorkflowIds.add(workflowId);
    const wf = this.store.get(workflowId);
    try {
      if (!wf) return;
      const executor = new WorkflowExecutor({ store: this.store, bridge: this.bridge });
      await executor.execute(wf);
    } catch (err) {
      log.error({ err, workflowId }, "Workflow execution failed");
    } finally {
      this.runningWorkflowIds.delete(workflowId);
    }
  }
}

// ── Cron matching ─────────────────────────────────────────────────────────────

function cronMatches(expr: string, date: Date): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;

  const [minuteF, hourF, domF, monthF, dowF] = parts;

  const minute = date.getUTCMinutes();
  const hour = date.getUTCHours();
  const dom = date.getUTCDate();
  const month = date.getUTCMonth() + 1; // 1-12
  const dow = date.getUTCDay(); // 0=Sunday

  return (
    fieldMatches(minuteF, minute) &&
    fieldMatches(hourF, hour) &&
    fieldMatches(domF, dom) &&
    fieldMatches(monthF, month) &&
    (fieldMatches(dowF, dow) || fieldMatches(dowF, dow === 0 ? 7 : dow))
  );
}

function fieldMatches(field: string, value: number): boolean {
  if (field === "*") return true;

  if (field.includes("/")) {
    const [range, stepStr] = field.split("/");
    const step = Number(stepStr);
    if (!Number.isInteger(step) || step < 1) return false;
    if (range === "*") return value % step === 0;
    const start = Number(range);
    if (!Number.isInteger(start)) return false;
    return value >= start && (value - start) % step === 0;
  }

  if (field.includes(",")) {
    return field.split(",").some((v) => fieldMatches(v, value));
  }

  if (field.includes("-")) {
    const [startStr, endStr] = field.split("-");
    const start = Number(startStr);
    const end = Number(endStr);
    return value >= start && value <= end;
  }

  return Number(field) === value;
}
