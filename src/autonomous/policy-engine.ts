import type { AutonomousTask, TaskConstraints } from "../memory/agent/autonomous-tasks.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("PolicyEngine");

/**
 * Deterministic fallback iteration cap for tasks whose constraints omit an
 * explicit `maxIterations`. Without this, an unconstrained task whose
 * self-reflection never reports `goalAchieved: true` would run all the way to
 * the global safety cap (`MAX_GLOBAL_ITERATIONS = 500` in loop.ts), burning
 * ~1000 LLM calls before stopping. 50 keeps the cost ceiling well below that
 * while leaving genuine multi-step tasks room to finish (issue #534 / WORK4-012).
 */
export const DEFAULT_MAX_ITERATIONS = 50;

export interface PolicyConfig {
  tonSpending: {
    perTask: number;
    daily: number;
    requireConfirmationAbove: number;
  };
  restrictedTools: string[];
  requireHumanApproval: "any" | "above-threshold" | "never";
  uncertainty: {
    threshold: number;
    maxConsecutiveUncertain: number;
  };
  loopDetection: {
    enabled: boolean;
    maxIdenticalActions: number;
  };
  rateLimit: {
    apiCallsPerMinute: number;
    toolCallsPerHour: number;
  };
}

export const DEFAULT_POLICY_CONFIG: PolicyConfig = {
  tonSpending: {
    perTask: 0.1,
    daily: 0.5,
    requireConfirmationAbove: 0.05,
  },
  restrictedTools: [
    "ton_send",
    "jetton_send",
    "dns_start_auction",
    "dns_bid",
    "dns_link",
    "dns_unlink",
    "dns_set_site",
    "stonfi_swap",
    "dedust_swap",
    "exec",
    "exec_run",
  ],
  requireHumanApproval: "above-threshold",
  uncertainty: {
    threshold: 0.7,
    maxConsecutiveUncertain: 3,
  },
  loopDetection: {
    enabled: true,
    maxIdenticalActions: 5,
  },
  rateLimit: {
    apiCallsPerMinute: 30,
    toolCallsPerHour: 100,
  },
};

/**
 * Snapshot of the mutable rate-limit / loop / uncertainty state that must
 * survive pause/resume cycles. Persisted by the loop; hydrated into a new
 * PolicyEngine on resume so the sliding-window limits are not bypassed by
 * scripting pause/resume (see issue #256).
 */
export interface PolicyEngineState {
  toolCallTimestamps: number[];
  apiCallTimestamps: number[];
  consecutiveUncertainCount: number;
  recentActions: string[];
}

export type PolicyViolation =
  | { type: "budget_exceeded"; message: string; requiresConfirmation: boolean }
  | { type: "invalid_ton_amount"; message: string; toolName?: string }
  | { type: "restricted_tool"; message: string; toolName: string }
  | { type: "ton_confirmation"; message: string; tonAmount: number }
  | { type: "loop_detected"; message: string }
  | { type: "rate_limit"; message: string }
  | { type: "max_iterations"; message: string }
  | { type: "duration_exceeded"; message: string };

export interface PolicyCheckResult {
  allowed: boolean;
  requiresEscalation: boolean;
  violations: PolicyViolation[];
}

export interface PolicyAction {
  toolName?: string;
  params?: Record<string, unknown>;
  tonAmount?: number;
  recentActions?: string[];
}

type TonSpend =
  | { kind: "none" }
  | { kind: "amount"; amount: number }
  | { kind: "invalid"; message: string };

const NATIVE_TON_ASSET = "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c";
const PARAM_AMOUNT_TON_TOOLS = new Set(["ton_send", "dns_start_auction", "dns_bid"]);
const FIXED_TON_SPEND_BY_TOOL = new Map<string, number>([
  ["jetton_send", 0.05],
  ["dns_link", 0.05],
  ["dns_unlink", 0.05],
  ["dns_set_site", 0.05],
]);
const SWAP_TOOLS = new Set(["stonfi_swap", "dedust_swap"]);

function isFiniteNonNegativeAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isPositiveAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isNativeTonAsset(value: unknown): boolean {
  return typeof value === "string" && (value.toLowerCase() === "ton" || value === NATIVE_TON_ASSET);
}

function formatTon(amount: number): string {
  return Number(amount.toFixed(9)).toString();
}

export function extractTonSpend(action: PolicyAction): TonSpend {
  const toolName = action.toolName;
  if (!toolName) return { kind: "none" };

  if (PARAM_AMOUNT_TON_TOOLS.has(toolName)) {
    const amount = action.params?.amount;
    if (!isPositiveAmount(amount)) {
      return {
        kind: "invalid",
        message: `Tool "${toolName}" requires a positive numeric params.amount for TON policy checks`,
      };
    }
    return { kind: "amount", amount };
  }

  const fixedAmount = FIXED_TON_SPEND_BY_TOOL.get(toolName);
  if (fixedAmount !== undefined) {
    return { kind: "amount", amount: fixedAmount };
  }

  if (SWAP_TOOLS.has(toolName)) {
    if (!isNativeTonAsset(action.params?.from_asset)) return { kind: "none" };

    const amount = action.params?.amount;
    if (!isPositiveAmount(amount)) {
      return {
        kind: "invalid",
        message: `Tool "${toolName}" requires a positive numeric params.amount when swapping from TON`,
      };
    }
    return { kind: "amount", amount };
  }

  if (action.tonAmount !== undefined && action.tonAmount > 0) {
    return { kind: "amount", amount: action.tonAmount };
  }

  return { kind: "none" };
}

export class PolicyEngine {
  private toolCallTimestamps: number[] = [];
  private apiCallTimestamps: number[] = [];
  private consecutiveUncertainCount = 0;
  private recentActions: string[] = [];
  private dailySpend = 0;
  private onStateChange?: (state: PolicyEngineState) => void;

  constructor(private config: PolicyConfig = DEFAULT_POLICY_CONFIG) {}

  /**
   * Register a callback invoked after any mutation to the engine's runtime
   * state. The loop uses this to persist state so that pause/resume cannot
   * bypass rate-limit and loop-detection windows (issue #256).
   */
  setOnStateChange(cb: ((state: PolicyEngineState) => void) | undefined): void {
    this.onStateChange = cb;
  }

  /** Dump mutable runtime state for persistence. */
  serialize(): PolicyEngineState {
    return {
      toolCallTimestamps: [...this.toolCallTimestamps],
      apiCallTimestamps: [...this.apiCallTimestamps],
      consecutiveUncertainCount: this.consecutiveUncertainCount,
      recentActions: [...this.recentActions],
    };
  }

  /**
   * Restore state produced by a previous `serialize()` call. Unknown fields
   * are ignored so the engine stays forward-compatible with older snapshots.
   */
  hydrate(state: Partial<PolicyEngineState> | undefined | null): void {
    if (!state) return;
    this.toolCallTimestamps = Array.isArray(state.toolCallTimestamps)
      ? [...state.toolCallTimestamps]
      : [];
    this.apiCallTimestamps = Array.isArray(state.apiCallTimestamps)
      ? [...state.apiCallTimestamps]
      : [];
    this.consecutiveUncertainCount =
      typeof state.consecutiveUncertainCount === "number" ? state.consecutiveUncertainCount : 0;
    this.recentActions = Array.isArray(state.recentActions) ? [...state.recentActions] : [];
  }

  private notifyChange(): void {
    if (this.onStateChange) this.onStateChange(this.serialize());
  }

  /** Set the persisted amount already spent during the current UTC day. */
  setDailySpend(amount: number): void {
    this.dailySpend = isFiniteNonNegativeAmount(amount) ? amount : 0;
  }

  checkAction(task: AutonomousTask, action: PolicyAction): PolicyCheckResult {
    const violations: PolicyViolation[] = [];
    let requiresEscalation = false;
    let blockingViolationCount = 0;

    const constraints = task.constraints as TaskConstraints;

    // Check max iterations. Fall back to DEFAULT_MAX_ITERATIONS when the task
    // omits an explicit bound so unconstrained tasks still have a deterministic
    // ceiling well below the global safety cap (issue #534 / WORK4-012).
    const effectiveMaxIterations = constraints.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    if (task.currentStep >= effectiveMaxIterations) {
      violations.push({
        type: "max_iterations",
        message: `Task has reached maximum iterations (${effectiveMaxIterations})`,
      });
      blockingViolationCount++;
    }

    // Check duration limit
    if (constraints.maxDurationHours !== undefined && task.startedAt) {
      const elapsedHours = (Date.now() - task.startedAt.getTime()) / 3600000;
      if (elapsedHours >= constraints.maxDurationHours) {
        violations.push({
          type: "duration_exceeded",
          message: `Task has exceeded maximum duration of ${constraints.maxDurationHours}h`,
        });
        blockingViolationCount++;
      }
    }

    // Check tool whitelist / blacklist
    if (action.toolName) {
      if (
        constraints.allowedTools &&
        constraints.allowedTools.length > 0 &&
        !constraints.allowedTools.includes(action.toolName)
      ) {
        violations.push({
          type: "restricted_tool",
          message: `Tool "${action.toolName}" is not in the allowed tools list`,
          toolName: action.toolName,
        });
        blockingViolationCount++;
      }

      if (
        this.config.restrictedTools.includes(action.toolName) ||
        (constraints.restrictedTools && constraints.restrictedTools.includes(action.toolName))
      ) {
        violations.push({
          type: "restricted_tool",
          message: `Tool "${action.toolName}" is restricted and requires user confirmation`,
          toolName: action.toolName,
        });
        requiresEscalation = true;
        log.warn({ tool: action.toolName }, "Restricted tool requires escalation");
      }
    }

    if (action.tonAmount !== undefined && !isFiniteNonNegativeAmount(action.tonAmount)) {
      violations.push({
        type: "invalid_ton_amount",
        message: `Declared tonAmount must be a finite non-negative number, got ${String(action.tonAmount)}`,
        toolName: action.toolName,
      });
      blockingViolationCount++;
    }

    // Check TON budget against the amount derived from the real tool params.
    const tonSpend = extractTonSpend(action);
    if (tonSpend.kind === "invalid") {
      violations.push({
        type: "invalid_ton_amount",
        message: tonSpend.message,
        toolName: action.toolName,
      });
      blockingViolationCount++;
    } else if (tonSpend.kind === "amount" && tonSpend.amount > 0) {
      const budgetTON = constraints.budgetTON ?? this.config.tonSpending.perTask;
      if (tonSpend.amount > budgetTON) {
        violations.push({
          type: "budget_exceeded",
          message: `TON amount ${tonSpend.amount} exceeds budget ${budgetTON} (per-task)`,
          requiresConfirmation: true,
        });
        blockingViolationCount++;
      }
      const projectedDailySpend = this.dailySpend + tonSpend.amount;
      if (projectedDailySpend > this.config.tonSpending.daily) {
        violations.push({
          type: "budget_exceeded",
          message: `TON daily budget exceeded: ${formatTon(this.dailySpend)} already spent + ${formatTon(tonSpend.amount)} requested = ${formatTon(projectedDailySpend)} (daily limit: ${formatTon(this.config.tonSpending.daily)})`,
          requiresConfirmation: true,
        });
        blockingViolationCount++;
      }
      // ton_confirmation is independent of the budget check: any amount
      // above the confirmation threshold should surface a dedicated
      // violation so the escalation message names TON explicitly, even
      // when the action is also blocked by the budget.
      if (tonSpend.amount > this.config.tonSpending.requireConfirmationAbove) {
        violations.push({
          type: "ton_confirmation",
          message: `TON amount ${tonSpend.amount} requires user confirmation (threshold: ${this.config.tonSpending.requireConfirmationAbove})`,
          tonAmount: tonSpend.amount,
        });
        requiresEscalation = true;
      }
    }

    // Check rate limits
    const now = Date.now();
    this.toolCallTimestamps = this.toolCallTimestamps.filter((t) => now - t < 3600000);
    if (this.toolCallTimestamps.length >= this.config.rateLimit.toolCallsPerHour) {
      violations.push({
        type: "rate_limit",
        message: `Tool call rate limit exceeded (${this.config.rateLimit.toolCallsPerHour}/hour)`,
      });
      blockingViolationCount++;
    }

    this.apiCallTimestamps = this.apiCallTimestamps.filter((t) => now - t < 60000);
    if (this.apiCallTimestamps.length >= this.config.rateLimit.apiCallsPerMinute) {
      violations.push({
        type: "rate_limit",
        message: `API call rate limit exceeded (${this.config.rateLimit.apiCallsPerMinute}/min)`,
      });
      blockingViolationCount++;
    }

    // Check loop detection
    if (
      this.config.loopDetection.enabled &&
      action.recentActions &&
      action.recentActions.length >= this.config.loopDetection.maxIdenticalActions
    ) {
      const lastN = action.recentActions.slice(-this.config.loopDetection.maxIdenticalActions);
      if (lastN.every((a) => a === lastN[0])) {
        violations.push({
          type: "loop_detected",
          message: `Loop detected: same action repeated ${this.config.loopDetection.maxIdenticalActions} times`,
        });
        requiresEscalation = true;
      }
    }

    const allowed = blockingViolationCount === 0;

    return { allowed, requiresEscalation, violations };
  }

  recordToolCall(): void {
    const now = Date.now();
    this.toolCallTimestamps.push(now);
    this.toolCallTimestamps = this.toolCallTimestamps
      .filter((t) => now - t < 3600000)
      .slice(-this.config.rateLimit.toolCallsPerHour);
    this.notifyChange();
  }

  recordApiCall(): void {
    const now = Date.now();
    this.apiCallTimestamps.push(now);
    this.apiCallTimestamps = this.apiCallTimestamps
      .filter((t) => now - t < 60000)
      .slice(-this.config.rateLimit.apiCallsPerMinute);
    this.notifyChange();
  }

  recordUncertain(): boolean {
    this.consecutiveUncertainCount++;
    this.notifyChange();
    return this.consecutiveUncertainCount >= this.config.uncertainty.maxConsecutiveUncertain;
  }

  resetUncertainCount(): void {
    if (this.consecutiveUncertainCount === 0) return;
    this.consecutiveUncertainCount = 0;
    this.notifyChange();
  }

  /**
   * Record a tool name the loop just executed. The engine stores a bounded
   * window (length 20) used for loop detection.
   */
  recordAction(toolName: string): void {
    this.recentActions.push(toolName);
    if (this.recentActions.length > 20) this.recentActions.shift();
    this.notifyChange();
  }

  getRecentActions(): readonly string[] {
    return this.recentActions;
  }

  satisfiesPolicies(task: AutonomousTask, action: PolicyAction): PolicyCheckResult {
    return this.checkAction(task, action);
  }
}
