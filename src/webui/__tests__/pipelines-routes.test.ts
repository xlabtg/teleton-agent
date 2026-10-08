import { describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { createPipelinesRoutes } from "../routes/pipelines.js";
import { ensurePipelineTables } from "../../services/pipeline/index.js";
import type { WebUIServerDeps } from "../types.js";

vi.mock("../../utils/logger.js", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

function makeDeps() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  ensurePipelineTables(db);
  return {
    memory: { db },
    bridge: {},
    agent: {
      getConfig: vi.fn(() => ({ telegram: { admin_ids: [123] } })),
      processMessage: vi.fn().mockResolvedValue({ content: "done" }),
    },
  } as unknown as WebUIServerDeps;
}

describe("pipeline routes", () => {
  it("creates a pipeline and lists it", async () => {
    const deps = makeDeps();
    const app = createPipelinesRoutes(deps);

    const createRes = await app.request("/", {
      method: "POST",
      body: JSON.stringify({
        name: "Research pipeline",
        steps: [{ id: "search", agent: "primary", action: "Search", output: "results" }],
      }),
      headers: { "content-type": "application/json" },
    });

    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    expect(created.data.name).toBe("Research pipeline");

    const listRes = await app.request("/");
    const listed = await listRes.json();
    expect(listed.data).toHaveLength(1);
    expect(listed.data[0].steps[0].id).toBe("search");
  });

  it("rejects cyclic pipeline definitions", async () => {
    const app = createPipelinesRoutes(makeDeps());

    const res = await app.request("/", {
      method: "POST",
      body: JSON.stringify({
        name: "Bad pipeline",
        steps: [
          { id: "a", agent: "primary", action: "A", dependsOn: ["b"] },
          { id: "b", agent: "primary", action: "B", dependsOn: ["a"] },
        ],
      }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("cycle");
  });

  it("starts a durable run", async () => {
    const deps = makeDeps();
    const app = createPipelinesRoutes(deps);
    const createRes = await app.request("/", {
      method: "POST",
      body: JSON.stringify({
        name: "Runnable",
        steps: [{ id: "only", agent: "primary", action: "Run {topic}", output: "result" }],
      }),
      headers: { "content-type": "application/json" },
    });
    const pipeline = (await createRes.json()).data;

    const runRes = await app.request(`/${pipeline.id}/run`, {
      method: "POST",
      body: JSON.stringify({ inputContext: { topic: "pipelines" } }),
      headers: { "content-type": "application/json" },
    });

    expect(runRes.status).toBe(202);
    const run = (await runRes.json()).data;
    expect(run.pipelineId).toBe(pipeline.id);

    await vi.waitFor(async () => {
      const detailRes = await app.request(`/${pipeline.id}/runs/${run.id}`);
      const detail = await detailRes.json();
      expect(detail.data.run.status).toBe("completed");
      expect(detail.data.steps[0].status).toBe("completed");
    });
  });
});
