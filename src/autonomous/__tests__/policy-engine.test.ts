import { describe, it, expect, beforeEach } from "vitest";
import { PolicyEngine, DEFAULT_POLICY_CONFIG, DEFAULT_MAX_ITERATIONS } from "../policy-engine.js";
import { MAX_GLOBAL_ITERATIONS } from "../loop.js";
import type { AutonomousTask } from "../../memory/agent/autonomous-tasks.js";

function makeTask(overrides: Partial<AutonomousTask> = {}): AutonomousTask {
  return {
    id: "test-task-id",
    goal: "Test goal",
    successCriteria: [],
    failureConditions: [],
    constraints: {},
    strategy: "balanced",
    retryPolicy: { maxRetries: 3, backoff: "exponential" },
    context: {},
    priority: "medium",
    status: "running",
    currentStep: 0,
    createdAt: new Date(),
    ...overrides,
  };
}

describe("PolicyEngine", () => {
  let engine: PolicyEngine;

  beforeEach(() => {
    engine = new PolicyEngine(DEFAULT_POLICY_CONFIG);
  });

  // ─── Basic allowed actions ─────────────────────────────────────────────────

  it("allows a safe action with no violations", () => {
    const task = makeTask();
    const result = engine.checkAction(task, { toolName: "web_fetch" });

    expect(result.allowed).toBe(true);
    expect(result.requiresEscalation).toBe(false);
    expect(result.violations).toHaveLength(0);
  });

  // ─── Max iterations ────────────────────────────────────────────────────────

  it("blocks when max iterations is reached", () => {
    const task = makeTask({
      constraints: { maxIterations: 5 },
      currentStep: 5,
    });
    const result = engine.checkAction(task, { toolName: "web_fetch" });

    expect(result.allowed).toBe(false);
    expect(result.violations.some((v) => v.type === "max_iterations")).toBe(true);
  });

  it("allows action when current step is below max iterations", () => {
    const task = makeTask({
      constraints: { maxIterations: 10 },
      currentStep: 5,
    });
    const result = engine.checkAction(task, { toolName: "web_fetch" });

    expect(result.allowed).toBe(true);
  });

  // ─── Default iteration cap (issue #534 / WORK4-012) ──────────────────────────

  it("applies a default iteration cap when constraints omit maxIterations", () => {
    expect(DEFAULT_MAX_ITERATIONS).toBeGreaterThan(0);
    expect(DEFAULT_MAX_ITERATIONS).toBeLessThan(MAX_GLOBAL_ITERATIONS);
  });

  it("blocks an unconstrained task once it reaches the default iteration cap", () => {
    const task = makeTask({
      constraints: {},
      currentStep: DEFAULT_MAX_ITERATIONS,
    });
    const result = engine.checkAction(task, { toolName: "web_fetch" });

    expect(result.allowed).toBe(false);
    expect(result.violations.some((v) => v.type === "max_iterations")).toBe(true);
  });

  it("allows an unconstrained task while it is below the default iteration cap", () => {
    const task = makeTask({
      constraints: {},
      currentStep: DEFAULT_MAX_ITERATIONS - 1,
    });
    const result = engine.checkAction(task, { toolName: "web_fetch" });

    expect(result.allowed).toBe(true);
  });

  it("lets an explicit maxIterations override the default cap", () => {
    // A task that explicitly raises the bound above the default keeps running
    // past DEFAULT_MAX_ITERATIONS — the fallback only applies when omitted.
    const task = makeTask({
      constraints: { maxIterations: DEFAULT_MAX_ITERATIONS + 10 },
      currentStep: DEFAULT_MAX_ITERATIONS + 5,
    });
    const result = engine.checkAction(task, { toolName: "web_fetch" });

    expect(result.allowed).toBe(true);
  });

  // ─── Duration limit ────────────────────────────────────────────────────────

  it("blocks when duration limit is exceeded", () => {
    const startedAt = new Date(Date.now() - 3 * 3600 * 1000); // 3 hours ago
    const task = makeTask({
      constraints: { maxDurationHours: 2 },
      startedAt,
    });
    const result = engine.checkAction(task, { toolName: "web_fetch" });

    expect(result.allowed).toBe(false);
    expect(result.violations.some((v) => v.type === "duration_exceeded")).toBe(true);
  });

  // ─── Tool whitelist / blacklist ────────────────────────────────────────────

  it("blocks a tool not in allowedTools whitelist", () => {
    const task = makeTask({
      constraints: { allowedTools: ["web_fetch", "telegram_send_message"] },
    });
    const result = engine.checkAction(task, { toolName: "exec_run" });

    expect(result.allowed).toBe(false);
    expect(result.violations.some((v) => v.type === "restricted_tool")).toBe(true);
  });

  it("allows a tool in allowedTools whitelist", () => {
    const task = makeTask({
      constraints: { allowedTools: ["web_fetch"] },
    });
    const result = engine.checkAction(task, { toolName: "web_fetch" });

    expect(result.allowed).toBe(true);
  });

  it("requires escalation for globally restricted tools", () => {
    const task = makeTask();
    const result = engine.checkAction(task, { toolName: "ton_send" });

    expect(result.requiresEscalation).toBe(true);
  });

  it("requires escalation for every real TON wallet tool in the default config", () => {
    const task = makeTask();

    for (const toolName of ["ton_send", "jetton_send", "exec", "exec_run"]) {
      const result = engine.checkAction(task, { toolName });
      expect(result.requiresEscalation, `expected ${toolName} to escalate`).toBe(true);
    }
  });

  it("requires escalation for mutating on-chain tools in the default config", () => {
    expect(DEFAULT_POLICY_CONFIG.restrictedTools).toEqual(
      expect.arrayContaining([
        "ton_send",
        "jetton_send",
        "dns_start_auction",
        "dns_bid",
        "dns_link",
        "dns_unlink",
        "dns_set_site",
        "stonfi_swap",
        "dedust_swap",
      ])
    );
  });

  it("uses real tool names in DEFAULT_POLICY_CONFIG.restrictedTools (no placeholder names)", () => {
    // Regression test for AUDIT-C1: placeholder names like "wallet:send"
    // would silently bypass the escalation gate because no registered tool
    // uses those names.
    expect(DEFAULT_POLICY_CONFIG.restrictedTools).toEqual(
      expect.arrayContaining(["ton_send", "jetton_send"])
    );
    expect(DEFAULT_POLICY_CONFIG.restrictedTools).not.toContain("wallet:send");
    expect(DEFAULT_POLICY_CONFIG.restrictedTools).not.toContain("contract:deploy");
    expect(DEFAULT_POLICY_CONFIG.restrictedTools).not.toContain("system:exec");
  });

  it("requires escalation for task-level restricted tools", () => {
    const task = makeTask({
      constraints: { restrictedTools: ["custom_tool"] },
    });
    const result = engine.checkAction(task, { toolName: "custom_tool" });

    expect(result.requiresEscalation).toBe(true);
  });

  it("includes tool name in violation message when globally restricted tool escalates", () => {
    const task = makeTask();
    const result = engine.checkAction(task, { toolName: "ton_send" });

    expect(result.requiresEscalation).toBe(true);
    const violation = result.violations.find(
      (v) => v.type === "restricted_tool" && v.toolName === "ton_send"
    );
    expect(violation).toBeDefined();
    expect(violation?.message).toContain("ton_send");
  });

  it("includes tool name in violation message when task-level restricted tool escalates", () => {
    const task = makeTask({
      constraints: { restrictedTools: ["custom_tool"] },
    });
    const result = engine.checkAction(task, { toolName: "custom_tool" });

    expect(result.requiresEscalation).toBe(true);
    const violation = result.violations.find(
      (v) => v.type === "restricted_tool" && v.toolName === "custom_tool"
    );
    expect(violation).toBeDefined();
    expect(violation?.message).toContain("custom_tool");
  });

  // ─── Default tonSpending values (AUDIT-M3) ────────────────────────────────

  it("DEFAULT_POLICY_CONFIG.tonSpending uses safe conservative defaults", () => {
    expect(DEFAULT_POLICY_CONFIG.tonSpending.perTask).toBe(0.1);
    expect(DEFAULT_POLICY_CONFIG.tonSpending.daily).toBe(0.5);
    expect(DEFAULT_POLICY_CONFIG.tonSpending.requireConfirmationAbove).toBe(0.05);
  });

  // ─── TON budget ────────────────────────────────────────────────────────────

  it("blocks when TON amount exceeds task budget", () => {
    const task = makeTask({
      constraints: { budgetTON: 0.5 },
    });
    const result = engine.checkAction(task, {
      toolName: "ton_send",
      params: { amount: 1.0 },
      tonAmount: 1.0,
    });

    expect(result.violations.some((v) => v.type === "budget_exceeded")).toBe(true);
  });

  it("blocks a TON-spending tool whose declared tonAmount is omitted", () => {
    const task = makeTask({
      constraints: { budgetTON: 0.5 },
    });
    const action = {
      toolName: "ton_send",
      params: { amount: 5 },
    };

    const result = engine.checkAction(task, action);

    expect(result.allowed).toBe(false);
    expect(result.violations.some((v) => v.type === "budget_exceeded")).toBe(true);
  });

  it("uses params.amount instead of an understated declared tonAmount", () => {
    const task = makeTask({
      constraints: { budgetTON: 0.5 },
    });
    const result = engine.checkAction(task, {
      toolName: "ton_send",
      params: { amount: 5 },
      tonAmount: 0,
    });

    expect(result.allowed).toBe(false);
    expect(result.violations.some((v) => v.type === "budget_exceeded")).toBe(true);
  });

  it("blocks invalid declared tonAmount values", () => {
    const task = makeTask();

    const result = engine.checkAction(task, { toolName: "safe_tool", tonAmount: Number.NaN });

    expect(result.allowed).toBe(false);
    expect(result.violations.some((v) => v.type === "invalid_ton_amount")).toBe(true);
  });

  it("requires escalation for TON above confirmation threshold", () => {
    const task = makeTask();
    const result = engine.checkAction(task, {
      toolName: "ton_send",
      params: { amount: 0.6 },
      tonAmount: 0.6,
    });

    expect(result.requiresEscalation).toBe(true);
  });

  it("includes TON amount in violation message when amount exceeds confirmation threshold", () => {
    const task = makeTask();
    const result = engine.checkAction(task, {
      toolName: "ton_send",
      params: { amount: 0.6 },
      tonAmount: 0.6,
    });

    expect(result.requiresEscalation).toBe(true);
    const violation = result.violations.find((v) => v.type === "ton_confirmation");
    expect(violation).toBeDefined();
    expect(violation?.message).toContain("0.6");
  });

  it("allows small TON amount within budget", () => {
    const task = makeTask({
      constraints: { budgetTON: 5 },
    });
    const result = engine.checkAction(task, { toolName: "safe_tool", tonAmount: 0.1 });

    expect(result.violations.filter((v) => v.type === "budget_exceeded")).toHaveLength(0);
  });

  it("blocks when cumulative daily TON spend would exceed the daily cap", () => {
    const dailyEngine = new PolicyEngine({
      ...DEFAULT_POLICY_CONFIG,
      tonSpending: { perTask: 1, daily: 0.25, requireConfirmationAbove: 1 },
      restrictedTools: [],
    });
    const task = makeTask({ constraints: { budgetTON: 1 } });

    dailyEngine.setDailySpend(0.2);
    const result = dailyEngine.checkAction(task, {
      toolName: "ton_send",
      params: { amount: 0.1 },
    });

    expect(result.allowed).toBe(false);
    const violation = result.violations.find((v) => v.type === "budget_exceeded");
    expect(violation?.message).toContain("daily");
    expect(violation?.message).toContain("0.25");
  });

  it("distinguishes per-task and daily budget rejections", () => {
    const dailyEngine = new PolicyEngine({
      ...DEFAULT_POLICY_CONFIG,
      tonSpending: { perTask: 0.1, daily: 0.5, requireConfirmationAbove: 1 },
      restrictedTools: [],
    });
    const task = makeTask();

    const perTaskResult = dailyEngine.checkAction(task, {
      toolName: "ton_send",
      params: { amount: 0.2 },
    });
    dailyEngine.setDailySpend(0.45);
    const dailyResult = dailyEngine.checkAction(task, {
      toolName: "ton_send",
      params: { amount: 0.1 },
    });

    expect(perTaskResult.violations.find((v) => v.type === "budget_exceeded")?.message).toContain(
      "per-task"
    );
    expect(dailyResult.violations.find((v) => v.type === "budget_exceeded")?.message).toContain(
      "daily"
    );
  });

  // ─── Loop detection ────────────────────────────────────────────────────────

  it("detects loops when same action is repeated maxIdenticalActions times", () => {
    const task = makeTask();
    const recentActions = Array(5).fill("web_fetch");

    const result = engine.checkAction(task, {
      toolName: "web_fetch",
      recentActions,
    });

    expect(result.violations.some((v) => v.type === "loop_detected")).toBe(true);
    expect(result.requiresEscalation).toBe(true);
  });

  it("does not detect loop with varied actions", () => {
    const task = makeTask();
    const recentActions = ["web_fetch", "exec_run", "telegram_send", "web_fetch", "exec_run"];

    const result = engine.checkAction(task, {
      toolName: "web_fetch",
      recentActions,
    });

    expect(result.violations.some((v) => v.type === "loop_detected")).toBe(false);
  });

  // ─── Uncertainty tracking ──────────────────────────────────────────────────

  it("recordUncertain returns true after reaching threshold", () => {
    expect(engine.recordUncertain()).toBe(false);
    expect(engine.recordUncertain()).toBe(false);
    expect(engine.recordUncertain()).toBe(true); // threshold is 3
  });

  it("resetUncertainCount resets the counter", () => {
    engine.recordUncertain();
    engine.recordUncertain();
    engine.resetUncertainCount();

    expect(engine.recordUncertain()).toBe(false);
  });

  // ─── Rate limits ───────────────────────────────────────────────────────────

  it("blocks when tool call rate limit is exceeded", () => {
    const strictEngine = new PolicyEngine({
      ...DEFAULT_POLICY_CONFIG,
      rateLimit: { apiCallsPerMinute: 30, toolCallsPerHour: 2 },
    });
    const task = makeTask();

    strictEngine.recordToolCall();
    strictEngine.recordToolCall();

    const result = strictEngine.checkAction(task, { toolName: "web_fetch" });
    expect(result.violations.some((v) => v.type === "rate_limit")).toBe(true);
  });

  // ─── AUDIT-M2: Unbounded timestamp arrays ─────────────────────────────────

  it("toolCallTimestamps stays bounded after many recordToolCall calls without checkAction", () => {
    // The cap should be at most toolCallsPerHour (100 by default) since calls
    // older than 1 hour are irrelevant and fresh calls within the window cannot
    // exceed the rate-limit cap before being pruned.
    const cap = DEFAULT_POLICY_CONFIG.rateLimit.toolCallsPerHour;

    for (let i = 0; i < 10_000; i++) {
      engine.recordToolCall();
    }

    const state = engine.serialize();
    expect(state.toolCallTimestamps.length).toBeLessThanOrEqual(cap);
  });

  it("apiCallTimestamps stays bounded after many recordApiCall calls without checkAction", () => {
    const cap = DEFAULT_POLICY_CONFIG.rateLimit.apiCallsPerMinute;

    for (let i = 0; i < 10_000; i++) {
      engine.recordApiCall();
    }

    const state = engine.serialize();
    expect(state.apiCallTimestamps.length).toBeLessThanOrEqual(cap);
  });
});
