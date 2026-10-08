import type { ToolContext } from "../../agent/tools/types.js";
import type { AgentRuntime } from "../../agent/runtime.js";
import type { ManagedAgentService } from "../../agents/service.js";
import type { ManagedAgentSnapshot } from "../../agents/types.js";
import { getErrorMessage } from "../../utils/errors.js";
import { createLogger } from "../../utils/logger.js";
import {
  type PipelineContext,
  type PipelineDefinition,
  type PipelineErrorStrategy,
  type PipelineRun,
  type PipelineRunDetail,
  type PipelineStep,
  type PipelineStore,
} from "./definition.js";
import { resolvePipelineSteps } from "./resolver.js";

const log = createLogger("PipelineExecutor");
const STEP_CANCELLATION_POLL_MS = 100;

export interface PipelineExecutorDeps {
  store: PipelineStore;
  agent: AgentRuntime;
  agentManager?: ManagedAgentService;
  toolContext?: ToolContext;
}

export interface ExecutePipelineOptions {
  inputContext?: PipelineContext;
  errorStrategy?: PipelineErrorStrategy;
}

interface StepExecutionResult {
  step: PipelineStep;
  outputName: string;
  outputValue: unknown;
  failed: boolean;
  cancelled: boolean;
  error: string | null;
  strategy: PipelineErrorStrategy;
}

interface DispatchStepOptions {
  signal: AbortSignal;
  timeoutSeconds?: number;
}

type RunInterruption = "cancelled" | { status: "timeout"; message: string } | null;

class PipelineRunCancelledError extends Error {
  constructor() {
    super("Pipeline run cancelled");
    this.name = "PipelineRunCancelledError";
  }
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function stringifyContextValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function interpolateAction(action: string, context: PipelineContext): string {
  return action.replace(/\{([A-Za-z_][A-Za-z0-9_.-]*)\}/g, (_, name: string) =>
    stringifyContextValue(context[name])
  );
}

function findManagedAgent(
  agentManager: ManagedAgentService,
  requestedAgent: string
): ManagedAgentSnapshot | null {
  const lookup = requestedAgent.trim().toLowerCase();
  return (
    agentManager
      .listAgentSnapshots()
      .find(
        (agent) =>
          agent.id.toLowerCase() === lookup ||
          agent.name.toLowerCase() === lookup ||
          agent.type.toLowerCase() === lookup
      ) ?? null
  );
}

export class PipelineExecutor {
  constructor(private deps: PipelineExecutorDeps) {}

  start(pipeline: PipelineDefinition, options: ExecutePipelineOptions = {}): PipelineRun {
    const run = this.deps.store.createRun(pipeline, {
      inputContext: options.inputContext,
      errorStrategy: options.errorStrategy,
    });
    void this.executeRun(pipeline, run.id).catch((error) => {
      if (this.isRunCancelled(run.id)) return;
      log.error({ err: error, pipelineId: pipeline.id, runId: run.id }, "Pipeline run failed");
      this.deps.store.updateRun(run.id, {
        status: "failed",
        error: getErrorMessage(error),
        completedAt: nowSeconds(),
      });
    });
    return run;
  }

  async execute(
    pipeline: PipelineDefinition,
    options: ExecutePipelineOptions = {}
  ): Promise<PipelineRunDetail> {
    const run = this.deps.store.createRun(pipeline, {
      inputContext: options.inputContext,
      errorStrategy: options.errorStrategy,
    });
    await this.executeRun(pipeline, run.id);
    const detail = this.deps.store.getRunDetail(pipeline.id, run.id);
    if (!detail) {
      throw new Error(`Pipeline run ${run.id} not found after execution`);
    }
    return detail;
  }

  async executeRun(pipeline: PipelineDefinition, runId: string): Promise<void> {
    const resolution = resolvePipelineSteps(pipeline.steps);
    const initialRun = this.deps.store.getRun(runId);
    if (!initialRun) throw new Error(`Pipeline run not found: ${runId}`);
    if (initialRun.status === "cancelled") return;

    const startedAt = nowSeconds();
    this.deps.store.updateRun(runId, { status: "running", startedAt });
    let context: PipelineContext = { ...initialRun.context };
    const deadline =
      pipeline.timeoutSeconds && pipeline.timeoutSeconds > 0
        ? Date.now() + pipeline.timeoutSeconds * 1000
        : null;

    for (const level of resolution.levels) {
      const interruption = this.getRunInterruption(runId, pipeline, deadline);
      if (interruption === "cancelled") return;
      if (interruption?.status === "timeout") {
        this.failRunForTimeout(runId, interruption.message);
        return;
      }

      const results = await this.withOptionalTimeout(
        Promise.all(
          level.map((step) => this.executeStep(runId, pipeline, step, context, deadline))
        ),
        this.pipelineRemainingTimeout(deadline),
        this.pipelineTimeoutMessage(pipeline)
      ).catch((error) => {
        const interruption = this.getRunInterruption(runId, pipeline, deadline);
        if (interruption === "cancelled") return null;
        if (interruption?.status === "timeout") {
          this.failRunForTimeout(runId, interruption.message);
          return null;
        }
        throw error;
      });
      if (!results) return;

      const afterLevelInterruption = this.getRunInterruption(runId, pipeline, deadline);
      if (afterLevelInterruption === "cancelled") return;
      if (afterLevelInterruption?.status === "timeout") {
        this.failRunForTimeout(runId, afterLevelInterruption.message);
        return;
      }

      if (this.isRunCancelled(runId) || results.some((result) => result.cancelled)) {
        return;
      }

      for (const result of results) {
        if (!result.failed) {
          context = {
            ...context,
            [result.outputName]: result.outputValue,
          };
        }
      }
      this.deps.store.updateRun(runId, { context });

      const blockingFailure = results.find(
        (result) => result.failed && result.strategy !== "continue"
      );
      if (blockingFailure) {
        this.deps.store.markPendingStepsSkipped(runId, "Skipped after pipeline failure");
        this.deps.store.updateRun(runId, {
          status: "failed",
          error: blockingFailure.error,
          completedAt: nowSeconds(),
        });
        return;
      }
    }

    const finalInterruption = this.getRunInterruption(runId, pipeline, deadline);
    if (finalInterruption === "cancelled") return;
    if (finalInterruption?.status === "timeout") {
      this.failRunForTimeout(runId, finalInterruption.message);
      return;
    }

    this.deps.store.updateRun(runId, {
      status: "completed",
      context,
      error: null,
      completedAt: nowSeconds(),
    });
  }

  private async executeStep(
    runId: string,
    pipeline: PipelineDefinition,
    step: PipelineStep,
    context: PipelineContext,
    pipelineDeadline: number | null
  ): Promise<StepExecutionResult> {
    const strategy = step.errorStrategy ?? pipeline.errorStrategy;
    const retries =
      strategy === "retry" ? Math.max(0, step.retryCount ?? pipeline.maxRetries ?? 0) : 0;
    const maxAttempts = retries + 1;
    let lastError: string | null = null;
    const startedAt = nowSeconds();

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      this.deps.store.updateStep(runId, step.id, {
        status: "running",
        inputContext: context,
        attempts: attempt,
        startedAt,
        error: lastError,
      });

      try {
        const action = interpolateAction(step.action, context);
        const timeoutSeconds = this.resolveStepTimeoutSeconds(step, pipelineDeadline);
        const controller = new AbortController();
        const outputValue = await this.withStepControls(
          this.dispatchStep(runId, step, action, context, {
            signal: controller.signal,
            ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
          }),
          {
            runId,
            label: `Pipeline step "${step.id}"`,
            controller,
            ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
          }
        );
        if (this.isRunCancelled(runId)) {
          return this.cancelledResult(step, strategy);
        }
        this.deps.store.updateStep(runId, step.id, {
          status: "completed",
          outputValue,
          error: null,
          attempts: attempt,
          completedAt: nowSeconds(),
        });
        return {
          step,
          outputName: step.output,
          outputValue,
          failed: false,
          cancelled: false,
          error: null,
          strategy,
        };
      } catch (error) {
        if (error instanceof PipelineRunCancelledError || this.isRunCancelled(runId)) {
          return this.cancelledResult(step, strategy);
        }
        lastError = getErrorMessage(error);
        const timeout = this.getRunInterruption(runId, pipeline, pipelineDeadline);
        if (timeout !== "cancelled" && timeout?.status === "timeout") {
          lastError = timeout.message;
          break;
        }
        if (attempt < maxAttempts) {
          log.warn({ pipelineId: pipeline.id, runId, stepId: step.id, error }, "Retrying step");
          continue;
        }
      }
    }

    if (this.isRunCancelled(runId)) {
      return this.cancelledResult(step, strategy);
    }
    this.deps.store.updateStep(runId, step.id, {
      status: "failed",
      error: lastError,
      attempts: maxAttempts,
      completedAt: nowSeconds(),
    });
    return {
      step,
      outputName: step.output,
      outputValue: null,
      failed: true,
      cancelled: false,
      error: lastError,
      strategy,
    };
  }

  private async dispatchStep(
    runId: string,
    step: PipelineStep,
    action: string,
    context: PipelineContext,
    options: DispatchStepOptions
  ): Promise<unknown> {
    const requestedAgent = step.agent.trim();
    if (!requestedAgent || requestedAgent.toLowerCase() === "primary") {
      const response = await this.deps.agent.processMessage({
        chatId: `pipeline:${runId}`,
        userName: "Pipeline",
        userMessage: action,
        timestamp: Date.now(),
        isGroup: false,
        pendingContext: JSON.stringify(context),
        signal: options.signal,
        toolContext: this.deps.toolContext
          ? { ...this.deps.toolContext, signal: options.signal }
          : undefined,
      });
      if (response.error) throw new Error(response.error);
      if (response.content === "Internal error: Agent loop failed to produce a response.") {
        throw new Error(response.content);
      }
      return response.content;
    }

    if (!this.deps.agentManager) {
      throw new Error(`Managed agent service unavailable for "${requestedAgent}"`);
    }
    const agent = findManagedAgent(this.deps.agentManager, requestedAgent);
    if (!agent) {
      throw new Error(`Managed agent not found: ${requestedAgent}`);
    }
    if (typeof this.deps.agentManager.waitForMessageResult !== "function") {
      throw new Error(
        `Managed agent result correlation unavailable for pipeline step "${step.id}"`
      );
    }
    const message = this.deps.agentManager.sendMessage(
      "primary",
      agent.id,
      [`[PIPELINE STEP - ${step.id}]`, action].join("\n")
    );
    const messageId = message.id;
    const targetAgentId = agent.id;
    const pendingOutput = {
      messageId,
      toAgentId: targetAgentId,
      toAgentName: agent.name,
      createdAt: message.createdAt,
      pending: true,
      action,
    };
    this.deps.store.updateStep(runId, step.id, {
      outputValue: pendingOutput,
    });

    const result = await this.deps.agentManager.waitForMessageResult(messageId, {
      agentId: targetAgentId,
      signal: options.signal,
      ...(options.timeoutSeconds !== undefined ? { timeoutSeconds: options.timeoutSeconds } : {}),
    });
    const status = result.status ?? "completed";
    if (status === "completed") {
      return result.content ?? null;
    }

    const reason =
      result.error ??
      (status === "cancelled" ? "managed agent cancelled the message" : "managed agent failed");
    throw new Error(
      `Managed agent "${agent.name}" ${status} pipeline step "${step.id}": ${reason}`
    );
  }

  private resolveStepTimeoutSeconds(
    step: PipelineStep,
    pipelineDeadline: number | null
  ): number | undefined {
    const candidates: number[] = [];
    if (step.timeoutSeconds && step.timeoutSeconds > 0) {
      candidates.push(step.timeoutSeconds);
    }
    if (pipelineDeadline) {
      candidates.push(Math.max(0, (pipelineDeadline - Date.now()) / 1000));
    }
    return candidates.length > 0 ? Math.min(...candidates) : undefined;
  }

  private getRunInterruption(
    runId: string,
    pipeline: PipelineDefinition,
    deadline: number | null
  ): RunInterruption {
    const currentRun = this.deps.store.getRun(runId);
    if (!currentRun || currentRun.status === "cancelled") return "cancelled";
    if (deadline && Date.now() >= deadline) {
      return { status: "timeout", message: this.pipelineTimeoutMessage(pipeline) };
    }
    return null;
  }

  private failRunForTimeout(runId: string, message: string): void {
    const currentRun = this.deps.store.getRun(runId);
    if (!currentRun || currentRun.status === "cancelled") return;
    this.deps.store.markTimedOutSteps(runId, message);
    this.deps.store.updateRun(runId, {
      status: "failed",
      error: message,
      completedAt: nowSeconds(),
    });
  }

  private pipelineRemainingTimeout(deadline: number | null): number | undefined {
    if (!deadline) return undefined;
    return Math.max(0, deadline - Date.now());
  }

  private pipelineTimeoutMessage(pipeline: PipelineDefinition): string {
    return `Pipeline timed out after ${pipeline.timeoutSeconds} seconds`;
  }

  private withOptionalTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number | undefined,
    errorMessage = "Operation timed out"
  ): Promise<T> {
    if (timeoutMs === undefined) return promise;
    if (timeoutMs <= 0) return Promise.reject(new Error(errorMessage));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(errorMessage));
      }, timeoutMs);
      timer.unref?.();
    });
    return Promise.race([promise, timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  private withStepControls<T>(
    promise: Promise<T>,
    options: {
      runId: string;
      label: string;
      controller: AbortController;
      timeoutSeconds?: number;
    }
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancellationPoll: ReturnType<typeof setInterval> | undefined;
    const races: Array<Promise<T> | Promise<never>> = [promise];

    if (options.timeoutSeconds !== undefined) {
      const timeoutSeconds = options.timeoutSeconds;
      const timeoutError = new Error(
        `${options.label} timed out after ${this.formatSeconds(timeoutSeconds)} seconds`
      );
      if (timeoutSeconds <= 0) {
        options.controller.abort(timeoutError);
        return Promise.reject(timeoutError);
      }
      races.push(
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            options.controller.abort(timeoutError);
            reject(timeoutError);
          }, timeoutSeconds * 1000);
          timer.unref?.();
        })
      );
    }

    races.push(
      new Promise<never>((_, reject) => {
        const rejectIfCancelled = () => {
          if (!this.isRunCancelled(options.runId)) return;
          const error = new PipelineRunCancelledError();
          options.controller.abort(error);
          reject(error);
        };
        rejectIfCancelled();
        cancellationPoll = setInterval(rejectIfCancelled, STEP_CANCELLATION_POLL_MS);
        cancellationPoll.unref?.();
      })
    );

    return Promise.race(races).finally(() => {
      if (timer) clearTimeout(timer);
      if (cancellationPoll) clearInterval(cancellationPoll);
    });
  }

  private isRunCancelled(runId: string): boolean {
    return this.deps.store.getRun(runId)?.status === "cancelled";
  }

  private cancelledResult(
    step: PipelineStep,
    strategy: PipelineErrorStrategy
  ): StepExecutionResult {
    return {
      step,
      outputName: step.output,
      outputValue: null,
      failed: true,
      cancelled: true,
      error: "Pipeline run cancelled",
      strategy,
    };
  }

  private formatSeconds(seconds: number): string {
    if (Number.isInteger(seconds)) return String(seconds);
    return seconds.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  }
}
