import { describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { ensurePipelineTables, PipelineStore } from "../../src/services/pipeline/definition.js";
import { PipelineExecutor } from "../../src/services/pipeline/executor.js";

describe("audit8: pipeline primary step has no toolContext", () => {
  it("dispatches without toolContext and records runtime's internal-error text as success", async () => {
    const db = new Database(":memory:");
    ensurePipelineTables(db);
    const store = new PipelineStore(db);
    // AgentRuntime returns this exact string when the LLM emits a tool call and toolContext is missing
    const processMessage = vi.fn().mockResolvedValue({
      content: "Internal error: Agent loop failed to produce a response.",
      toolCalls: [],
    });
    const p = store.create({ name: "p", steps: [{ id: "s", agent: "primary", action: "check balance", output: "o" }] });
    const ex = new PipelineExecutor({ store, agent: { processMessage } as any });
    const d = await ex.execute(p);
    expect(processMessage.mock.calls[0][0].toolContext).toBeUndefined();
    expect(d.run.status).toBe("completed");
    expect(d.run.context.o).toContain("Internal error");
  });
});
