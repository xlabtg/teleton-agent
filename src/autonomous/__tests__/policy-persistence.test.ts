import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { ensureSchema } from "../../memory/schema.js";
import {
  getAutonomousTaskStore,
  type AutonomousTaskStore,
  type AutonomousTask,
} from "../../memory/agent/autonomous-tasks.js";
import { AutonomousLoop } from "../loop.js";
import type { LoopDependencies, PlannedAction, ToolExecutionResult, Reflection } from "../loop.js";
import { DEFAULT_POLICY_CONFIG, PolicyEngine } from "../policy-engine.js";
import type { PolicyConfig, PolicyEngineState } from "../policy-engine.js";

function makeDeps(overrides: Partial<LoopDependencies> = {}): LoopDependencies {
  return {
    planNextAction: vi.fn().mockResolvedValue({
      toolName: "web_fetch",
      params: { url: "https://example.com" },
      reasoning: "Fetch data",
      confidence: 0.9,
    } satisfies PlannedAction),

    executeTool: vi.fn().mockResolvedValue({
      success: true,
      data: { result: "fetched" },
      durationMs: 1,
    } satisfies ToolExecutionResult),

    // Never succeed — we want to count iterations, not complete.
    evaluateSuccess: vi.fn().mockResolvedValue(false),

    selfReflect: vi.fn().mockResolvedValue({
      progressSummary: "Making progress",
      isStuck: false,
    } satisfies Reflection),

    escalate: vi.fn().mockResolvedValue(undefined),

    ...overrides,
  };
}

/**
 * Regression tests for issue #256 (AUDIT-C3):
 * Pause/resume must not reset PolicyEngine's sliding-window state.
 *
 * Each test simulates the exact bypass pattern described in the audit:
 *   pauseTask() → resumeTask() → pauseTask() → resumeTask() → …
 * and asserts the counters are hydrated from persistent storage instead of
 * being re-initialised to zero.
 */
describe("PolicyEngine state persistence across pause/resume (issue #256)", () => {
  let db: InstanceType<typeof Database>;
  let store: AutonomousTaskStore;
  let task: AutonomousTask;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    ensureSchema(db);
    store = getAutonomousTaskStore(db);
    task = store.createTask({
      goal: "Persistence test",
      constraints: { maxIterations: 100000 },
    });
  });

  afterEach(() => {
    db.close();
  });

  it("serialize/hydrate roundtrips all mutable fields", () => {
    const a = new PolicyEngine(DEFAULT_POLICY_CONFIG);
    a.recordToolCall();
    a.recordToolCall();
    a.recordApiCall();
    a.recordUncertain();
    a.recordAction("web_fetch");
    a.recordAction("web_fetch");

    const snapshot = a.serialize();
    expect(snapshot.toolCallTimestamps).toHaveLength(2);
    expect(snapshot.apiCallTimestamps).toHaveLength(1);
    expect(snapshot.consecutiveUncertainCount).toBe(1);
    expect(snapshot.recentActions).toEqual(["web_fetch", "web_fetch"]);

    const b = new PolicyEngine(DEFAULT_POLICY_CONFIG);
    b.hydrate(snapshot);
    const roundtrip = b.serialize();
    expect(roundtrip).toEqual(snapshot);
  });

  it("hydrate() ignores unknown / missing fields safely", () => {
    const engine = new PolicyEngine(DEFAULT_POLICY_CONFIG);
    engine.hydrate(undefined);
    engine.hydrate({});
    // Should not throw, should be blank state.
    const s = engine.serialize();
    expect(s.toolCallTimestamps).toEqual([]);
    expect(s.apiCallTimestamps).toEqual([]);
    expect(s.consecutiveUncertainCount).toBe(0);
    expect(s.recentActions).toEqual([]);
  });

  it("onStateChange fires on every mutation so storage is always current", () => {
    const engine = new PolicyEngine(DEFAULT_POLICY_CONFIG);
    const states: PolicyEngineState[] = [];
    engine.setOnStateChange((s) => states.push(s));

    engine.recordApiCall();
    engine.recordToolCall();
    engine.recordUncertain();
    engine.recordAction("x");
    engine.resetUncertainCount();

    expect(states.length).toBe(5);
    expect(states[4].consecutiveUncertainCount).toBe(0);
  });

  it("resetUncertainCount() does NOT fire onStateChange when already zero", () => {
    // Avoid needless DB writes during the common non-stuck path.
    const engine = new PolicyEngine(DEFAULT_POLICY_CONFIG);
    const cb = vi.fn();
    engine.setOnStateChange(cb);

    engine.resetUncertainCount();
    expect(cb).not.toHaveBeenCalled();

    engine.recordUncertain();
    cb.mockClear();
    engine.resetUncertainCount();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("writes policy_state to the store on each tool call", async () => {
    // Bound to two iterations by having evaluateSuccess return true on the
    // 2nd step. That makes this test deterministic (no timing-based stop).
    // The assertion after run() inspects the last on-disk snapshot before
    // terminal cleanup fires, so we peek inside the callback instead.
    const policy: PolicyConfig = {
      ...DEFAULT_POLICY_CONFIG,
      rateLimit: { apiCallsPerMinute: 100000, toolCallsPerHour: 100000 },
      loopDetection: { enabled: false, maxIdenticalActions: 999 },
    };

    let midRunSnapshot: Partial<PolicyEngineState> | undefined;
    const deps = makeDeps();
    // Capture a snapshot of what's been persisted right before we let the
    // loop finish. Completion clears policy_state, but mid-run it should
    // contain at least one recorded tool call.
    (deps.evaluateSuccess as ReturnType<typeof vi.fn>).mockImplementation(() => {
      midRunSnapshot = store.getPolicyState(task.id) as Partial<PolicyEngineState> | undefined;
      return Promise.resolve(true);
    });

    const loop = new AutonomousLoop(store, deps, policy);
    const result = await loop.run(task);

    expect(result.status).toBe("completed");
    expect(midRunSnapshot).toBeDefined();
    expect(Array.isArray(midRunSnapshot?.toolCallTimestamps)).toBe(true);
    expect((midRunSnapshot?.toolCallTimestamps ?? []).length).toBeGreaterThan(0);
  });

  it("tool-call rate limit still fires after 10 pause/resume cycles", async () => {
    // Tight limit so the bypass shows up quickly.
    const policy: PolicyConfig = {
      ...DEFAULT_POLICY_CONFIG,
      rateLimit: { apiCallsPerMinute: 10000, toolCallsPerHour: 5 },
    };

    // Simulate exactly the bypass pattern: record 5 tool calls spread
    // across 10 pause/resume cycles, then ensure the next policy check
    // triggers the limit.
    for (let cycle = 0; cycle < 10; cycle++) {
      const engine = new PolicyEngine(policy);
      const existing = store.getPolicyState(task.id) as Partial<PolicyEngineState> | undefined;
      engine.hydrate(existing);
      engine.setOnStateChange((s) => store.savePolicyState(task.id, s));
      // Each "session" records half a tool call worth of work; after 10
      // cycles we'll have hit the limit.
      if (cycle < 5) engine.recordToolCall();
    }

    const finalEngine = new PolicyEngine(policy);
    finalEngine.hydrate(store.getPolicyState(task.id));
    const check = finalEngine.checkAction({ ...task, currentStep: 0 }, { toolName: "web_fetch" });

    expect(check.violations.some((v) => v.type === "rate_limit")).toBe(true);
  });

  it("identical-action loop detection persists across pause/resume", async () => {
    const policy: PolicyConfig = {
      ...DEFAULT_POLICY_CONFIG,
      loopDetection: { enabled: true, maxIdenticalActions: 5 },
    };

    // Accumulate recentActions across 5 pause/resume cycles (1 action each).
    for (let cycle = 0; cycle < 5; cycle++) {
      const engine = new PolicyEngine(policy);
      engine.hydrate(store.getPolicyState(task.id));
      engine.setOnStateChange((s) => store.savePolicyState(task.id, s));
      engine.recordAction("web_fetch");
    }

    const finalEngine = new PolicyEngine(policy);
    finalEngine.hydrate(store.getPolicyState(task.id));
    const recent = [...finalEngine.getRecentActions()];
    expect(recent).toHaveLength(5);

    const check = finalEngine.checkAction(
      { ...task, currentStep: 0 },
      { toolName: "web_fetch", recentActions: recent }
    );
    expect(check.violations.some((v) => v.type === "loop_detected")).toBe(true);
    expect(check.requiresEscalation).toBe(true);
  });

  it("consecutiveUncertainCount is not reset by pause/resume", async () => {
    const policy = DEFAULT_POLICY_CONFIG;

    // Two uncertain markers, one pause/resume in the middle.
    let engine = new PolicyEngine(policy);
    engine.hydrate(store.getPolicyState(task.id));
    engine.setOnStateChange((s) => store.savePolicyState(task.id, s));
    expect(engine.recordUncertain()).toBe(false); // count=1

    // Resume: new PolicyEngine, hydrate from DB.
    engine = new PolicyEngine(policy);
    engine.hydrate(store.getPolicyState(task.id));
    engine.setOnStateChange((s) => store.savePolicyState(task.id, s));
    expect(engine.recordUncertain()).toBe(false); // count=2

    // One more resume.
    engine = new PolicyEngine(policy);
    engine.hydrate(store.getPolicyState(task.id));
    engine.setOnStateChange((s) => store.savePolicyState(task.id, s));
    // Reaching the threshold (3) should fire even though each session
    // only recorded a single uncertain event.
    expect(engine.recordUncertain()).toBe(true); // count=3
  });

  it("AutonomousLoop hydrates persisted state on resume (end-to-end)", async () => {
    // Pre-seed policy_state so a resume starts with a nearly-full rate-limit
    // window. Without hydration the loop would blow past this limit; with
    // hydration the first tool call tips it over and the loop fails.
    const now = Date.now();
    const preState: PolicyEngineState = {
      toolCallTimestamps: [now, now, now, now, now],
      apiCallTimestamps: [],
      consecutiveUncertainCount: 0,
      recentActions: [],
    };
    store.savePolicyState(task.id, preState as unknown as Record<string, unknown>);

    const policy: PolicyConfig = {
      ...DEFAULT_POLICY_CONFIG,
      rateLimit: { apiCallsPerMinute: 100000, toolCallsPerHour: 5 },
      loopDetection: { enabled: false, maxIdenticalActions: 999 },
    };
    const deps = makeDeps();
    const loop = new AutonomousLoop(store, deps, policy);

    const result = await loop.run(task);

    // With hydration, the very first policy check trips the rate limit
    // because the pre-seeded window already contains 5 timestamps.
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/rate limit/i);
  });

  it("terminal success clears policy_state", async () => {
    store.savePolicyState(task.id, {
      toolCallTimestamps: [Date.now()],
      apiCallTimestamps: [],
      consecutiveUncertainCount: 0,
      recentActions: [],
    });
    expect(store.getPolicyState(task.id)).toBeDefined();

    const deps = makeDeps({
      evaluateSuccess: vi.fn().mockResolvedValue(true),
    });
    const loop = new AutonomousLoop(store, deps, DEFAULT_POLICY_CONFIG);
    const result = await loop.run(task);

    expect(result.status).toBe("completed");
    expect(store.getPolicyState(task.id)).toBeUndefined();
  });

  it("records successful TON spend and blocks a later task at the shared daily cap", async () => {
    const policy: PolicyConfig = {
      ...DEFAULT_POLICY_CONFIG,
      tonSpending: { perTask: 1, daily: 0.25, requireConfirmationAbove: 1 },
      restrictedTools: [],
      rateLimit: { apiCallsPerMinute: 100000, toolCallsPerHour: 100000 },
      loopDetection: { enabled: false, maxIdenticalActions: 999 },
    };
    const tonAction = {
      toolName: "ton_send",
      params: { amount: 0.2 },
      reasoning: "Send TON",
      confidence: 0.9,
    } satisfies PlannedAction;
    const firstDeps = makeDeps({
      planNextAction: vi.fn().mockResolvedValue(tonAction),
      executeTool: vi.fn().mockResolvedValue({
        success: true,
        data: { amount: 0.2, from: "EQ-wallet", txHash: "tx-1" },
      }),
      evaluateSuccess: vi.fn().mockResolvedValue(true),
    });

    const first = await new AutonomousLoop(store, firstDeps, policy).run(task);
    expect(first.status).toBe("completed");
    expect(store.getDailyTonSpend("EQ-wallet")).toBe(0.2);

    const secondTask = store.createTask({
      goal: "Second spend",
      constraints: { maxIterations: 10 },
    });
    const executeSecondTool = vi.fn().mockResolvedValue({ success: true });
    const secondDeps = makeDeps({
      planNextAction: vi.fn().mockResolvedValue({
        ...tonAction,
        params: { amount: 0.1 },
      }),
      executeTool: executeSecondTool,
    });
    const second = await new AutonomousLoop(store, secondDeps, policy).run(secondTask);

    expect(second.status).toBe("failed");
    expect(second.error).toMatch(/daily/i);
    expect(executeSecondTool).not.toHaveBeenCalled();
  });

  it("does not record failed TON executions in daily spend", async () => {
    const policy: PolicyConfig = {
      ...DEFAULT_POLICY_CONFIG,
      tonSpending: { perTask: 1, daily: 1, requireConfirmationAbove: 1 },
      restrictedTools: [],
      rateLimit: { apiCallsPerMinute: 100000, toolCallsPerHour: 100000 },
      loopDetection: { enabled: false, maxIdenticalActions: 999 },
    };
    const deps = makeDeps({
      planNextAction: vi.fn().mockResolvedValue({
        toolName: "ton_send",
        params: { amount: 0.2 },
      }),
      executeTool: vi.fn().mockResolvedValue({ success: false, error: "not settled" }),
      evaluateSuccess: vi.fn().mockResolvedValue(true),
    });

    await new AutonomousLoop(store, deps, policy).run(task);

    expect(store.getDailyTonSpend("default")).toBe(0);
  });

  it("resets the accumulated budget on the next UTC day", () => {
    store.recordDailyTonSpend("EQ-wallet", 0.2, new Date("2026-07-14T23:59:59Z"));

    expect(store.getTotalDailyTonSpend(new Date("2026-07-14T23:59:59Z"))).toBe(0.2);
    expect(store.getTotalDailyTonSpend(new Date("2026-07-15T00:00:00Z"))).toBe(0);
  });

  it("pause preserves policy_state for the next resume", async () => {
    // Race-free pause: transition the task to 'paused' from inside the
    // evaluateSuccess hook. On the next iteration the loop sees the
    // paused status and returns status='paused' without clearing
    // policy_state.
    const policy: PolicyConfig = {
      ...DEFAULT_POLICY_CONFIG,
      rateLimit: { apiCallsPerMinute: 100000, toolCallsPerHour: 100000 },
      loopDetection: { enabled: false, maxIdenticalActions: 999 },
    };
    const deps = makeDeps();
    (deps.evaluateSuccess as ReturnType<typeof vi.fn>).mockImplementation(() => {
      store.updateTaskStatus(task.id, "paused");
      return Promise.resolve(false);
    });

    const loop = new AutonomousLoop(store, deps, policy);
    const result = await loop.run(task);

    expect(result.status).toBe("paused");
    const persisted = store.getPolicyState(task.id);
    expect(persisted).toBeDefined();
  });
});
