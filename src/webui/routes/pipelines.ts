import { Hono } from "hono";
import type { WebUIServerDeps, APIResponse } from "../types.js";
import {
  getPipelineStore,
  PIPELINE_ERROR_STRATEGIES,
  PipelineExecutor,
  type PipelineContext,
  type PipelineDefinition,
  type PipelineErrorStrategy,
  type PipelineRun,
  type PipelineRunDetail,
} from "../../services/pipeline/index.js";
import { getErrorMessage } from "../../utils/errors.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("pipelines-routes");

const MAX_PIPELINES = 100;
const MAX_NAME_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 500;

function isErrorStrategy(value: unknown): value is PipelineErrorStrategy {
  return PIPELINE_ERROR_STRATEGIES.includes(value as PipelineErrorStrategy);
}

function sanitizeName(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, MAX_NAME_LENGTH) : "";
}

function sanitizeDescription(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return typeof value === "string" ? value.trim().slice(0, MAX_DESCRIPTION_LENGTH) : undefined;
}

function parseNonNegativeInt(value: unknown, field: string, max: number): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > max) {
    throw new Error(`${field} must be an integer between 0 and ${max}`);
  }
  return parsed;
}

function parsePositiveIntOrNull(
  value: unknown,
  field: string,
  max: number
): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`${field} must be an integer between 1 and ${max}`);
  }
  return parsed;
}

function parseContext(value: unknown): PipelineContext {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("inputContext must be an object");
  }
  return value as PipelineContext;
}

export function createPipelinesRoutes(deps: WebUIServerDeps) {
  const app = new Hono();

  function store() {
    return getPipelineStore(deps.memory.db);
  }

  function executor() {
    return new PipelineExecutor({
      store: store(),
      agent: deps.agent,
      agentManager: deps.agentManager,
      toolContext: {
        bridge: deps.bridge,
        db: deps.memory.db,
        chatId: "pipeline",
        senderId: deps.agent.getConfig().telegram.admin_ids[0] ?? 0,
        isGroup: false,
        config: deps.agent.getConfig(),
        semanticMemory: {
          embedder: deps.memory.embedder,
          vectorEnabled: deps.memory.vectorEnabled ?? false,
          vectorStore: deps.memory.vectorStore,
        },
      },
    });
  }

  app.get("/", (c) => {
    try {
      const pipelines = store().list();
      return c.json<APIResponse<PipelineDefinition[]>>({ success: true, data: pipelines });
    } catch (error) {
      return c.json<APIResponse>({ success: false, error: getErrorMessage(error) }, 500);
    }
  });

  app.get("/:id", (c) => {
    try {
      const pipeline = store().get(c.req.param("id"));
      if (!pipeline) {
        return c.json<APIResponse>({ success: false, error: "Pipeline not found" }, 404);
      }
      return c.json<APIResponse<PipelineDefinition>>({ success: true, data: pipeline });
    } catch (error) {
      return c.json<APIResponse>({ success: false, error: getErrorMessage(error) }, 500);
    }
  });

  app.post("/", async (c) => {
    try {
      const body = await c.req.json<{
        name?: unknown;
        description?: unknown;
        enabled?: unknown;
        steps?: unknown;
        errorStrategy?: unknown;
        maxRetries?: unknown;
        timeoutSeconds?: unknown;
      }>();

      const name = sanitizeName(body.name);
      if (!name) {
        return c.json<APIResponse>({ success: false, error: "name is required" }, 400);
      }
      if (store().list().length >= MAX_PIPELINES) {
        return c.json<APIResponse>(
          { success: false, error: `Maximum ${MAX_PIPELINES} pipelines allowed` },
          400
        );
      }

      const errorStrategy = body.errorStrategy ?? "fail_fast";
      if (!isErrorStrategy(errorStrategy)) {
        return c.json<APIResponse>(
          {
            success: false,
            error: `errorStrategy must be one of: ${PIPELINE_ERROR_STRATEGIES.join(", ")}`,
          },
          400
        );
      }

      const pipeline = store().create({
        name,
        description: sanitizeDescription(body.description),
        enabled: typeof body.enabled === "boolean" ? body.enabled : true,
        steps: body.steps,
        errorStrategy,
        maxRetries: parseNonNegativeInt(body.maxRetries, "maxRetries", 10) ?? 0,
        timeoutSeconds:
          parsePositiveIntOrNull(body.timeoutSeconds, "timeoutSeconds", 86_400) ?? null,
      });

      return c.json<APIResponse<PipelineDefinition>>({ success: true, data: pipeline }, 201);
    } catch (error) {
      return c.json<APIResponse>({ success: false, error: getErrorMessage(error) }, 400);
    }
  });

  app.put("/:id", async (c) => {
    try {
      const id = c.req.param("id");
      const existing = store().get(id);
      if (!existing) {
        return c.json<APIResponse>({ success: false, error: "Pipeline not found" }, 404);
      }

      const body = await c.req.json<{
        name?: unknown;
        description?: unknown;
        enabled?: unknown;
        steps?: unknown;
        errorStrategy?: unknown;
        maxRetries?: unknown;
        timeoutSeconds?: unknown;
      }>();

      const updates: Parameters<ReturnType<typeof store>["update"]>[1] = {};

      if (body.name !== undefined) {
        const name = sanitizeName(body.name);
        if (!name) {
          return c.json<APIResponse>({ success: false, error: "name cannot be empty" }, 400);
        }
        updates.name = name;
      }
      if (body.description !== undefined) {
        updates.description = sanitizeDescription(body.description) ?? null;
      }
      if (typeof body.enabled === "boolean") updates.enabled = body.enabled;
      if (body.steps !== undefined) updates.steps = body.steps;
      if (body.errorStrategy !== undefined) {
        if (!isErrorStrategy(body.errorStrategy)) {
          return c.json<APIResponse>(
            {
              success: false,
              error: `errorStrategy must be one of: ${PIPELINE_ERROR_STRATEGIES.join(", ")}`,
            },
            400
          );
        }
        updates.errorStrategy = body.errorStrategy;
      }
      const maxRetries = parseNonNegativeInt(body.maxRetries, "maxRetries", 10);
      if (maxRetries !== undefined) updates.maxRetries = maxRetries;
      const timeoutSeconds = parsePositiveIntOrNull(body.timeoutSeconds, "timeoutSeconds", 86_400);
      if (timeoutSeconds !== undefined) updates.timeoutSeconds = timeoutSeconds;

      const updated = store().update(id, updates);
      if (!updated) {
        return c.json<APIResponse>({ success: false, error: "Pipeline not found" }, 404);
      }
      return c.json<APIResponse<PipelineDefinition>>({ success: true, data: updated });
    } catch (error) {
      return c.json<APIResponse>({ success: false, error: getErrorMessage(error) }, 400);
    }
  });

  app.delete("/:id", (c) => {
    try {
      const deleted = store().delete(c.req.param("id"));
      if (!deleted) {
        return c.json<APIResponse>({ success: false, error: "Pipeline not found" }, 404);
      }
      return c.json<APIResponse<null>>({ success: true, data: null });
    } catch (error) {
      return c.json<APIResponse>({ success: false, error: getErrorMessage(error) }, 500);
    }
  });

  app.post("/:id/run", async (c) => {
    try {
      const pipeline = store().get(c.req.param("id"));
      if (!pipeline) {
        return c.json<APIResponse>({ success: false, error: "Pipeline not found" }, 404);
      }
      if (!pipeline.enabled) {
        return c.json<APIResponse>({ success: false, error: "Pipeline is disabled" }, 400);
      }
      type RunRequestBody = {
        inputContext?: unknown;
        context?: unknown;
        errorStrategy?: unknown;
      };
      const body = await c.req.json<RunRequestBody>().catch((): RunRequestBody => ({}));
      const errorStrategy = body.errorStrategy;
      if (errorStrategy !== undefined && !isErrorStrategy(errorStrategy)) {
        return c.json<APIResponse>(
          {
            success: false,
            error: `errorStrategy must be one of: ${PIPELINE_ERROR_STRATEGIES.join(", ")}`,
          },
          400
        );
      }
      const run = executor().start(pipeline, {
        inputContext: parseContext(body.inputContext ?? body.context),
        ...(errorStrategy !== undefined ? { errorStrategy } : {}),
      });
      return c.json<APIResponse<PipelineRun>>({ success: true, data: run }, 202);
    } catch (error) {
      log.warn({ err: error }, "Pipeline run request failed");
      return c.json<APIResponse>({ success: false, error: getErrorMessage(error) }, 400);
    }
  });

  app.get("/:id/runs", (c) => {
    try {
      if (!store().get(c.req.param("id"))) {
        return c.json<APIResponse>({ success: false, error: "Pipeline not found" }, 404);
      }
      const limit = Number(c.req.query("limit") ?? "50");
      const runs = store().listRuns(c.req.param("id"), Number.isFinite(limit) ? limit : 50);
      return c.json<APIResponse<PipelineRun[]>>({ success: true, data: runs });
    } catch (error) {
      return c.json<APIResponse>({ success: false, error: getErrorMessage(error) }, 500);
    }
  });

  app.get("/:id/runs/:runId", (c) => {
    try {
      const detail = store().getRunDetail(c.req.param("id"), c.req.param("runId"));
      if (!detail) {
        return c.json<APIResponse>({ success: false, error: "Pipeline run not found" }, 404);
      }
      return c.json<APIResponse<PipelineRunDetail>>({ success: true, data: detail });
    } catch (error) {
      return c.json<APIResponse>({ success: false, error: getErrorMessage(error) }, 500);
    }
  });

  app.post("/:id/runs/:runId/cancel", (c) => {
    try {
      const run = store().cancelRun(c.req.param("id"), c.req.param("runId"));
      if (!run) {
        return c.json<APIResponse>({ success: false, error: "Pipeline run not found" }, 404);
      }
      return c.json<APIResponse<PipelineRun>>({ success: true, data: run });
    } catch (error) {
      return c.json<APIResponse>({ success: false, error: getErrorMessage(error) }, 500);
    }
  });

  return app;
}
