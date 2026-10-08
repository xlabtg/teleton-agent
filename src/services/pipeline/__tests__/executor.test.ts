import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { ensurePipelineTables, PipelineStore, type PipelineDefinition } from "../definition.js";
import { PipelineExecutor } from "../executor.js";

vi.mock("../../../utils/logger.js", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

function createStore(): PipelineStore {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  ensurePipelineTables(db);
  return new PipelineStore(db);
}

function getRun(store: PipelineStore, pipeline: PipelineDefinition) {
  const runs = store.listRuns(pipeline.id);
  expect(runs).toHaveLength(1);
  const detail = store.getRunDetail(pipeline.id, runs[0].id);
  expect(detail).not.toBeNull();
  return detail!;
}

describe("PipelineExecutor", () => {
  let store: PipelineStore;

  beforeEach(() => {
    store = createStore();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("provides primary tool context and fails internal-error output (#757)", async () => {
    const toolContext = { bridge: {}, db: {}, chatId: "pipeline", senderId: 100, isGroup: false };
    const processMessage = vi
      .fn()
      .mockResolvedValue({ content: "Internal error: Agent loop failed to produce a response." });
    const pipeline = store.create({
      name: "tools",
      steps: [{ id: "one", agent: "primary", action: "balance", output: "balance" }],
    });
    const executor = new PipelineExecutor({
      store,
      agent: { processMessage } as any,
      toolContext: toolContext as any,
    });
    const result = await executor.execute(pipeline);
    expect(processMessage.mock.calls[0][0].toolContext).toMatchObject({ senderId: 100 });
    expect(result.run.status).toBe("failed");
  });
  it("passes one step output into dependent step variables", async () => {
    const processMessage = vi
      .fn()
      .mockResolvedValueOnce({ content: "typescript pipeline notes" })
      .mockResolvedValueOnce({ content: "summary from notes" });
    const pipeline = store.create({
      name: "research",
      steps: [
        {
          id: "research",
          agent: "primary",
          action: "Research {topic}",
          output: "notes",
        },
        {
          id: "summary",
          agent: "primary",
          action: "Summarize {notes}",
          depends_on: ["research"],
          output: "report",
        },
      ],
    });

    const executor = new PipelineExecutor({
      store,
      agent: { processMessage } as unknown as ConstructorParameters<
        typeof PipelineExecutor
      >[0]["agent"],
    });

    const detail = await executor.execute(pipeline, { inputContext: { topic: "pipelines" } });

    expect(detail.run.status).toBe("completed");
    expect(detail.run.context).toMatchObject({
      topic: "pipelines",
      notes: "typescript pipeline notes",
      report: "summary from notes",
    });
    expect(processMessage.mock.calls[0][0].userMessage).toBe("Research pipelines");
    expect(processMessage.mock.calls[1][0].userMessage).toBe("Summarize typescript pipeline notes");
    expect(detail.steps.map((step) => step.status)).toEqual(["completed", "completed"]);
  });

  it("marks the run failed and skips pending steps when fail_fast step fails", async () => {
    const processMessage = vi.fn().mockRejectedValueOnce(new Error("provider down"));
    const pipeline = store.create({
      name: "failure",
      steps: [
        { id: "first", agent: "primary", action: "First", output: "first" },
        { id: "second", agent: "primary", action: "Second", depends_on: ["first"] },
      ],
    });

    const executor = new PipelineExecutor({
      store,
      agent: { processMessage } as unknown as ConstructorParameters<
        typeof PipelineExecutor
      >[0]["agent"],
    });

    const detail = await executor.execute(pipeline);

    expect(detail.run.status).toBe("failed");
    expect(detail.run.error).toContain("provider down");
    expect(detail.steps.map((step) => step.status)).toEqual(["failed", "skipped"]);
  });

  it("continues with available context when the strategy is continue", async () => {
    const processMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValueOnce({ content: "second output" });
    const pipeline = store.create({
      name: "continue",
      errorStrategy: "continue",
      steps: [
        { id: "first", agent: "primary", action: "First", output: "first" },
        { id: "second", agent: "primary", action: "Second {first}", depends_on: ["first"] },
      ],
    });

    const executor = new PipelineExecutor({
      store,
      agent: { processMessage } as unknown as ConstructorParameters<
        typeof PipelineExecutor
      >[0]["agent"],
    });

    const detail = await executor.execute(pipeline);

    expect(detail.run.status).toBe("completed");
    expect(detail.run.context.second).toBe("second output");
    expect(processMessage.mock.calls[1][0].userMessage).toBe("Second ");
    expect(detail.steps.map((step) => step.status)).toEqual(["failed", "completed"]);
  });

  it("waits for managed-agent output before running dependent pipeline steps", async () => {
    const processMessage = vi.fn().mockResolvedValueOnce({ content: "summary from notes" });
    const sendMessage = vi.fn().mockReturnValue({
      id: "message-1",
      fromId: "primary",
      toId: "researcher",
      text: "work",
      createdAt: "2026-04-24T00:00:00.000Z",
      deliveredAt: null,
    });
    const waitForMessageResult = vi.fn().mockResolvedValue({
      messageId: "message-1",
      fromId: "researcher",
      toId: "primary",
      status: "completed",
      content: "actual research notes",
      error: null,
      completedAt: "2026-04-24T00:00:01.000Z",
    });
    const pipeline = store.create({
      name: "managed",
      steps: [
        {
          id: "research",
          agent: "ResearchAgent",
          action: "Research TON",
          output: "notes",
        },
        {
          id: "summary",
          agent: "primary",
          action: "Summarize {notes}",
          depends_on: ["research"],
          output: "report",
        },
      ],
    });
    const executor = new PipelineExecutor({
      store,
      agent: { processMessage } as unknown as ConstructorParameters<
        typeof PipelineExecutor
      >[0]["agent"],
      agentManager: {
        listAgentSnapshots: () => [
          {
            id: "researcher",
            name: "Researcher",
            type: "ResearchAgent",
          },
        ],
        sendMessage,
        waitForMessageResult,
      } as unknown as ConstructorParameters<typeof PipelineExecutor>[0]["agentManager"],
    });

    const detail = await executor.execute(pipeline);

    expect(detail.run.status).toBe("completed");
    expect(detail.run.context.notes).toBe("actual research notes");
    expect(detail.run.context.report).toBe("summary from notes");
    expect(sendMessage).toHaveBeenCalledWith(
      "primary",
      "researcher",
      expect.stringContaining("[PIPELINE STEP - research]")
    );
    expect(waitForMessageResult).toHaveBeenCalledWith(
      "message-1",
      expect.objectContaining({ agentId: "researcher" })
    );
    expect(processMessage).toHaveBeenCalledWith(
      expect.objectContaining({ userMessage: "Summarize actual research notes" })
    );
    expect(detail.steps.map((step) => step.status)).toEqual(["completed", "completed"]);
  });

  it("fails a managed-agent step when the delegated result fails", async () => {
    const sendMessage = vi.fn().mockReturnValue({
      id: "message-1",
      fromId: "primary",
      toId: "researcher",
      text: "work",
      createdAt: "2026-04-24T00:00:00.000Z",
      deliveredAt: null,
    });
    const waitForMessageResult = vi.fn().mockResolvedValue({
      messageId: "message-1",
      fromId: "researcher",
      toId: "primary",
      status: "failed",
      content: null,
      error: "research failed",
      completedAt: "2026-04-24T00:00:01.000Z",
    });
    const pipeline = store.create({
      name: "managed failure",
      steps: [
        { id: "delegate", agent: "ResearchAgent", action: "work", output: "notes" },
        { id: "summary", agent: "primary", action: "Summarize {notes}", depends_on: ["delegate"] },
      ],
    });
    const executor = new PipelineExecutor({
      store,
      agent: { processMessage: vi.fn() } as unknown as ConstructorParameters<
        typeof PipelineExecutor
      >[0]["agent"],
      agentManager: {
        listAgentSnapshots: () => [
          {
            id: "researcher",
            name: "Researcher",
            type: "ResearchAgent",
          },
        ],
        sendMessage,
        waitForMessageResult,
      } as unknown as ConstructorParameters<typeof PipelineExecutor>[0]["agentManager"],
    });

    const detail = await executor.execute(pipeline);

    expect(detail.run.status).toBe("failed");
    expect(detail.run.error).toContain("research failed");
    expect(detail.steps.map((step) => step.status)).toEqual(["failed", "skipped"]);
  });

  it("fails a managed-agent step when waiting for the result times out", async () => {
    vi.useFakeTimers();
    const sendMessage = vi.fn().mockReturnValue({
      id: "message-1",
      fromId: "primary",
      toId: "researcher",
      text: "work",
      createdAt: "2026-04-24T00:00:00.000Z",
      deliveredAt: null,
    });
    const waitForMessageResult = vi.fn(() => new Promise(() => {}));
    const pipeline = store.create({
      name: "managed timeout",
      steps: [
        {
          id: "delegate",
          agent: "ResearchAgent",
          action: "work",
          output: "notes",
          timeoutSeconds: 1,
        },
      ],
    });
    const executor = new PipelineExecutor({
      store,
      agent: { processMessage: vi.fn() } as unknown as ConstructorParameters<
        typeof PipelineExecutor
      >[0]["agent"],
      agentManager: {
        listAgentSnapshots: () => [
          {
            id: "researcher",
            name: "Researcher",
            type: "ResearchAgent",
          },
        ],
        sendMessage,
        waitForMessageResult,
      } as unknown as ConstructorParameters<typeof PipelineExecutor>[0]["agentManager"],
    });

    const detailPromise = executor.execute(pipeline);
    await vi.advanceTimersByTimeAsync(1_000);
    const detail = await detailPromise;

    expect(detail.run.status).toBe("failed");
    expect(detail.steps[0].status).toBe("failed");
    expect(detail.steps[0].error).toContain('Pipeline step "delegate" timed out after 1 seconds');
  });

  it("keeps a delegated step cancelled when the run is cancelled before a late result", async () => {
    let resolveResult:
      | ((value: {
          messageId: string;
          fromId: string;
          toId: string;
          status: "completed";
          content: string;
          error: null;
          completedAt: string;
        }) => void)
      | undefined;
    const sendMessage = vi.fn().mockReturnValue({
      id: "message-1",
      fromId: "primary",
      toId: "researcher",
      text: "work",
      createdAt: "2026-04-24T00:00:00.000Z",
      deliveredAt: null,
    });
    const waitForMessageResult = vi.fn(
      () =>
        new Promise<{
          messageId: string;
          fromId: string;
          toId: string;
          status: "completed";
          content: string;
          error: null;
          completedAt: string;
        }>((resolve) => {
          resolveResult = resolve;
        })
    );
    const pipeline = store.create({
      name: "managed cancellation",
      steps: [{ id: "delegate", agent: "ResearchAgent", action: "work", output: "notes" }],
    });
    const executor = new PipelineExecutor({
      store,
      agent: { processMessage: vi.fn() } as unknown as ConstructorParameters<
        typeof PipelineExecutor
      >[0]["agent"],
      agentManager: {
        listAgentSnapshots: () => [
          {
            id: "researcher",
            name: "Researcher",
            type: "ResearchAgent",
          },
        ],
        sendMessage,
        waitForMessageResult,
      } as unknown as ConstructorParameters<typeof PipelineExecutor>[0]["agentManager"],
    });

    const run = executor.start(pipeline);
    await vi.waitFor(() => expect(waitForMessageResult).toHaveBeenCalled());
    store.cancelRun(pipeline.id, run.id);
    resolveResult?.({
      messageId: "message-1",
      fromId: "researcher",
      toId: "primary",
      status: "completed",
      content: "late notes",
      error: null,
      completedAt: "2026-04-24T00:00:01.000Z",
    });
    await vi.waitFor(() => {
      const detail = store.getRunDetail(pipeline.id, run.id);
      expect(detail?.run.status).toBe("cancelled");
      expect(detail?.steps[0].status).toBe("cancelled");
      expect(detail?.run.context.notes).toBeUndefined();
    });
  });

  it("fails a hung primary step when only the pipeline run timeout is configured", async () => {
    vi.useFakeTimers();
    const processMessage = vi.fn(() => new Promise(() => undefined));
    const pipeline = store.create({
      name: "timeout",
      timeoutSeconds: 1,
      steps: [
        { id: "slow", agent: "primary", action: "never returns", output: "out" },
        { id: "after", agent: "primary", action: "after", depends_on: ["slow"], output: "after" },
      ],
    });
    const executor = new PipelineExecutor({
      store,
      agent: { processMessage } as unknown as ConstructorParameters<
        typeof PipelineExecutor
      >[0]["agent"],
    });

    const promise = executor.execute(pipeline);
    await vi.advanceTimersByTimeAsync(1_500);
    const detail = await promise;

    expect(detail.run.status).toBe("failed");
    expect(detail.run.error).toContain("Pipeline timed out after 1 seconds");
    expect(detail.steps.map((step) => step.status)).toEqual(["failed", "skipped"]);
    expect(detail.steps[0].error).toContain("Pipeline timed out after 1 seconds");
    expect(detail.steps[1].error).toContain("Pipeline timed out after 1 seconds");
  });

  it("forwards an AbortSignal to the primary agent and aborts it on step timeout", async () => {
    vi.useFakeTimers();
    let capturedSignal: AbortSignal | undefined;
    // Simulate a slow agentic run that only stops when the signal aborts.
    const processMessage = vi.fn((opts: { signal?: AbortSignal }) => {
      capturedSignal = opts.signal;
      return new Promise(() => undefined);
    });
    const pipeline = store.create({
      name: "primary abort",
      steps: [
        {
          id: "slow",
          agent: "primary",
          action: "run several slow tool calls",
          output: "out",
          timeoutSeconds: 1,
        },
      ],
    });
    const executor = new PipelineExecutor({
      store,
      agent: { processMessage } as unknown as ConstructorParameters<
        typeof PipelineExecutor
      >[0]["agent"],
    });

    const promise = executor.execute(pipeline);
    await vi.advanceTimersByTimeAsync(1_000);
    const detail = await promise;

    expect(detail.run.status).toBe("failed");
    expect(detail.steps[0].status).toBe("failed");
    expect(detail.steps[0].error).toContain('Pipeline step "slow" timed out after 1 seconds');
    // The primary agent received a signal and it was aborted at the timeout so
    // the underlying run can stop instead of executing tools detached.
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal?.aborted).toBe(true);
  });

  it("rejects step and run writes after the run reaches a terminal status", () => {
    const pipeline = store.create({
      name: "terminal guard",
      steps: [{ id: "only", agent: "primary", action: "work", output: "out" }],
    });
    const run = store.createRun(pipeline);
    const seconds = Math.floor(Date.now() / 1000);
    store.updateRun(run.id, { status: "running", startedAt: seconds });
    store.updateRun(run.id, { status: "failed", error: "timed out", completedAt: seconds });

    // Orphaned step execution tries to flip the failed run's step to completed.
    const stepAfter = store.updateStep(run.id, "only", {
      status: "completed",
      outputValue: "late output",
      completedAt: seconds + 5,
    });
    expect(stepAfter?.status).not.toBe("completed");
    expect(stepAfter?.outputValue).not.toBe("late output");

    // Orphaned run write tries to overwrite the terminal status.
    const runAfter = store.updateRun(run.id, { status: "completed", error: null });
    expect(runAfter?.status).toBe("failed");
    expect(runAfter?.error).toBe("timed out");
  });

  it("fails a hung managed-agent step when only the pipeline run timeout is configured", async () => {
    vi.useFakeTimers();
    const waitForMessageResult = vi.fn(() => new Promise(() => undefined));
    const pipeline = store.create({
      name: "managed-timeout",
      timeoutSeconds: 1,
      steps: [
        { id: "delegate", agent: "ResearchAgent", action: "never returns", output: "dispatch" },
        {
          id: "after",
          agent: "primary",
          action: "after",
          depends_on: ["delegate"],
          output: "after",
        },
      ],
    });
    const executor = new PipelineExecutor({
      store,
      agent: {
        processMessage: vi.fn().mockResolvedValue({ content: "after" }),
      } as unknown as ConstructorParameters<typeof PipelineExecutor>[0]["agent"],
      agentManager: {
        listAgentSnapshots: () => [
          {
            id: "researcher",
            name: "Researcher",
            type: "ResearchAgent",
          },
        ],
        sendMessage: vi.fn().mockReturnValue({
          id: "message-1",
          fromId: "primary",
          toId: "researcher",
          text: "work",
          createdAt: "2026-04-24T00:00:00.000Z",
          deliveredAt: null,
        }),
        waitForMessageResult,
      } as unknown as ConstructorParameters<typeof PipelineExecutor>[0]["agentManager"],
    });

    const promise = executor.execute(pipeline);
    await vi.advanceTimersByTimeAsync(1_500);
    const detail = await promise;

    expect(detail.run.status).toBe("failed");
    expect(detail.run.error).toContain("Pipeline timed out after 1 seconds");
    expect(detail.steps.map((step) => step.status)).toEqual(["failed", "skipped"]);
    expect(detail.steps[0].error).toContain("Pipeline timed out after 1 seconds");
    expect(detail.steps[1].error).toContain("Pipeline timed out after 1 seconds");
    expect(waitForMessageResult).toHaveBeenCalledWith(
      "message-1",
      expect.objectContaining({ timeoutSeconds: expect.any(Number) })
    );
  });
});
