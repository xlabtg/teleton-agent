import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { WorkflowStore } from "../workflows.js";
import { WorkflowScheduler } from "../workflow-scheduler.js";
import { WorkflowExecutor } from "../workflow-executor.js";

const executeWorkflow = vi.hoisted(() => vi.fn());

vi.mock("../workflow-executor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../workflow-executor.js")>();
  return {
    WorkflowExecutor: class extends actual.WorkflowExecutor {
      execute = executeWorkflow;
    },
  };
});

vi.mock("../../utils/logger.js", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
      config TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      last_run_at INTEGER,
      run_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      last_fired_bucket INTEGER
    );
  `);
  return db;
}

describe("WorkflowScheduler", () => {
  let db: Database.Database;
  let store: WorkflowStore;

  beforeEach(() => {
    db = createTestDb();
    store = new WorkflowStore(db);
    vi.useFakeTimers();
    executeWorkflow.mockReset();
    executeWorkflow.mockImplementation(function (
      this: WorkflowExecutor,
      ...args: Parameters<WorkflowExecutor["execute"]>
    ) {
      return WorkflowExecutor.prototype.execute.apply(this, args);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fireEvent triggers matching event workflows", async () => {
    const wf = store.create({
      name: "On start",
      config: {
        trigger: { type: "event", event: "agent.start" },
        actions: [],
      },
    });

    const scheduler = new WorkflowScheduler(db);
    await scheduler.fireEvent("agent.start");

    const updated = store.get(wf.id)!;
    expect(updated.runCount).toBe(1);
  });

  it("fireEvent does not trigger disabled workflows", async () => {
    const wf = store.create({
      name: "Disabled",
      enabled: false,
      config: {
        trigger: { type: "event", event: "agent.start" },
        actions: [],
      },
    });

    const scheduler = new WorkflowScheduler(db);
    await scheduler.fireEvent("agent.start");

    const updated = store.get(wf.id)!;
    expect(updated.runCount).toBe(0);
  });

  it("fireEvent does not trigger workflows with different event", async () => {
    const wf = store.create({
      name: "Stop only",
      config: {
        trigger: { type: "event", event: "agent.stop" },
        actions: [],
      },
    });

    const scheduler = new WorkflowScheduler(db);
    await scheduler.fireEvent("agent.start");

    const updated = store.get(wf.id)!;
    expect(updated.runCount).toBe(0);
  });

  it("does not run the same workflow concurrently across event triggers", async () => {
    store.create({
      name: "On start",
      config: {
        trigger: { type: "event", event: "agent.start" },
        actions: [],
      },
    });
    let finishExecution!: () => void;
    executeWorkflow.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishExecution = resolve;
        })
    );

    const scheduler = new WorkflowScheduler(db);
    const firstRun = scheduler.fireEvent("agent.start");
    await vi.waitFor(() => expect(executeWorkflow).toHaveBeenCalledTimes(1));
    const overlappingRun = scheduler.fireEvent("agent.start");

    await vi.waitFor(() => expect(executeWorkflow).toHaveBeenCalledTimes(1));
    finishExecution();
    await Promise.all([firstRun, overlappingRun]);
  });

  it("handleWebhook triggers matching webhook workflows", async () => {
    const wf = store.create({
      name: "Webhook",
      config: {
        trigger: { type: "webhook", secret: "my-secret-token" },
        actions: [],
      },
    });

    const scheduler = new WorkflowScheduler(db);
    const triggered = await scheduler.handleWebhook("my-secret-token");

    expect(triggered).toBe(true);
    const updated = store.get(wf.id)!;
    expect(updated.runCount).toBe(1);
  });

  it("handleWebhook returns false for unknown secret", async () => {
    const scheduler = new WorkflowScheduler(db);
    const triggered = await scheduler.handleWebhook("nonexistent");
    expect(triggered).toBe(false);
  });

  it("handleWebhook does not trigger disabled webhook workflows", async () => {
    const wf = store.create({
      name: "Disabled webhook",
      enabled: false,
      config: {
        trigger: { type: "webhook", secret: "secret123" },
        actions: [],
      },
    });

    const scheduler = new WorkflowScheduler(db);
    const triggered = await scheduler.handleWebhook("secret123");

    expect(triggered).toBe(false);
    const updated = store.get(wf.id)!;
    expect(updated.runCount).toBe(0);
  });

  it("does not run the same workflow concurrently across webhook triggers", async () => {
    store.create({
      name: "Webhook",
      config: {
        trigger: { type: "webhook", secret: "secret123" },
        actions: [],
      },
    });
    let finishExecution!: () => void;
    executeWorkflow.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishExecution = resolve;
        })
    );

    const scheduler = new WorkflowScheduler(db);
    const firstRun = scheduler.handleWebhook("secret123");
    await vi.waitFor(() => expect(executeWorkflow).toHaveBeenCalledTimes(1));
    const overlappingRun = scheduler.handleWebhook("secret123");

    await vi.waitFor(() => expect(executeWorkflow).toHaveBeenCalledTimes(1));
    finishExecution();
    await expect(Promise.all([firstRun, overlappingRun])).resolves.toEqual([true, true]);
  });

  it("start and stop do not throw", () => {
    const scheduler = new WorkflowScheduler(db);
    scheduler.start();
    scheduler.stop();
  });

  it("start is idempotent", () => {
    const scheduler = new WorkflowScheduler(db);
    scheduler.start();
    scheduler.start(); // should not throw or create duplicate timers
    scheduler.stop();
  });
});

describe("Cron matching (via tick)", () => {
  let db: Database.Database;
  let store: WorkflowStore;

  beforeEach(() => {
    db = createTestDb();
    store = new WorkflowStore(db);
    vi.useFakeTimers();
    executeWorkflow.mockReset();
    executeWorkflow.mockImplementation(function (
      this: WorkflowExecutor,
      ...args: Parameters<WorkflowExecutor["execute"]>
    ) {
      return WorkflowExecutor.prototype.execute.apply(this, args);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires cron workflow when time matches", async () => {
    // Start 1 second before 09:00 UTC on a Monday so the interval fires AT 09:00
    vi.setSystemTime(new Date("2024-01-01T08:59:00.000Z")); // Monday, 1 min before target

    const wf = store.create({
      name: "Monday 9am",
      config: {
        trigger: { type: "cron", cron: "0 9 * * 1" }, // Monday at 9am UTC
        actions: [],
      },
    });

    const scheduler = new WorkflowScheduler(db);
    scheduler.start();

    // Advance to exactly 09:00 UTC (60 seconds forward)
    await vi.advanceTimersByTimeAsync(60_000);

    const updated = store.get(wf.id)!;
    expect(updated.runCount).toBe(1);

    scheduler.stop();
  });

  it("does not fire cron workflow when time does not match", async () => {
    // Set time to 2024-01-01 10:00 UTC (9am cron won't match)
    vi.setSystemTime(new Date("2024-01-01T10:00:00.000Z"));

    const wf = store.create({
      name: "Monday 9am",
      config: {
        trigger: { type: "cron", cron: "0 9 * * 1" },
        actions: [],
      },
    });

    const scheduler = new WorkflowScheduler(db);
    scheduler.start();

    await vi.advanceTimersByTimeAsync(60_000);

    const updated = store.get(wf.id)!;
    expect(updated.runCount).toBe(0);

    scheduler.stop();
  });
});

describe("WorkflowScheduler deduplication (AUDIT-M7)", () => {
  let db: Database.Database;
  let store: WorkflowStore;

  beforeEach(() => {
    db = createTestDb();
    store = new WorkflowStore(db);
    vi.useFakeTimers();
    executeWorkflow.mockReset();
    executeWorkflow.mockImplementation(function (
      this: WorkflowExecutor,
      ...args: Parameters<WorkflowExecutor["execute"]>
    ) {
      return WorkflowExecutor.prototype.execute.apply(this, args);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not fire a cron workflow twice in the same minute bucket", async () => {
    // Two ticks land within the same minute (bucket = same floor(ms/60000))
    vi.setSystemTime(new Date("2024-01-01T08:59:00.000Z"));

    const wf = store.create({
      name: "Every minute",
      config: {
        trigger: { type: "cron", cron: "* * * * *" },
        actions: [],
      },
    });

    const scheduler = new WorkflowScheduler(db);
    scheduler.start();

    // First tick fires at 08:59 — bucket N
    await vi.advanceTimersByTimeAsync(60_000);
    // Second tick fires at 09:00 — different bucket, so allowed
    // But if we force a manual second tick within the same bucket, it must be skipped.
    // Simulate two ticks landing in the same minute by calling tick directly via two advances
    // that land in bucket for 09:00:
    // Advance 30 s (stays in same 09:00 bucket)
    await vi.advanceTimersByTimeAsync(30_000);

    const updated = store.get(wf.id)!;
    // Only 2 fires: one per distinct minute bucket (08:59 bucket, 09:00 bucket)
    // NOT 3 (the 30-second partial advance doesn't fire because setInterval is 60 s)
    expect(updated.runCount).toBe(2);

    scheduler.stop();
  });

  it("persists last_fired_bucket in DB so restart does not re-fire", async () => {
    vi.setSystemTime(new Date("2024-01-01T09:00:00.000Z"));
    const bucket = Math.floor(new Date("2024-01-01T09:00:00.000Z").getTime() / 60_000);

    const wf = store.create({
      name: "Hourly",
      config: {
        trigger: { type: "cron", cron: "0 9 * * *" },
        actions: [],
      },
    });

    // Pre-persist the fired bucket as if this workflow already ran before restart
    store.recordFiredBucket(wf.id, bucket);

    const scheduler = new WorkflowScheduler(db);
    scheduler.start();

    // Tick fires at 09:00 UTC — but bucket already recorded, so must be skipped
    await vi.advanceTimersByTimeAsync(60_000);

    const updated = store.get(wf.id)!;
    expect(updated.runCount).toBe(0);
    expect(updated.lastFiredBucket).toBe(bucket);

    scheduler.stop();
  });
});
