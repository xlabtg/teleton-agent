import { Hono } from "hono";
import type { WebUIServerDeps, APIResponse } from "../types.js";
import { getEventBus } from "../../services/event-bus.js";
import { getWebhookDispatcher } from "../../services/webhook-dispatcher.js";
import { getErrorMessage } from "../../utils/errors.js";

interface WebhookBody {
  url?: unknown;
  events?: unknown;
  secret?: unknown;
  active?: unknown;
  maxRetries?: unknown;
}

function parseEvents(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("events must be an array");
  return value.map((event) => {
    if (typeof event !== "string") throw new Error("events must contain only strings");
    return event;
  });
}

function parseMaxRetries(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error("maxRetries must be an integer");
  return parsed;
}

function safeParseJson(raw: string): Record<string, unknown> {
  const parsed = JSON.parse(raw) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("payload must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

export function createWebhooksRoutes(deps: WebUIServerDeps) {
  const app = new Hono();

  function dispatcher() {
    return getWebhookDispatcher(deps.memory.db);
  }

  app.get("/", (c) => {
    try {
      return c.json<APIResponse>({ success: true, data: dispatcher().listWebhooks() });
    } catch (error) {
      return c.json<APIResponse>({ success: false, error: getErrorMessage(error) }, 500);
    }
  });

  app.post("/", async (c) => {
    try {
      const body = await c.req.json<WebhookBody>();
      if (typeof body.url !== "string") {
        return c.json<APIResponse>({ success: false, error: "url is required" }, 400);
      }
      const webhook = dispatcher().createWebhook({
        url: body.url.trim(),
        events: parseEvents(body.events),
        secret: typeof body.secret === "string" ? body.secret : undefined,
        active: typeof body.active === "boolean" ? body.active : undefined,
        maxRetries: parseMaxRetries(body.maxRetries),
      });
      return c.json<APIResponse>({ success: true, data: webhook }, 201);
    } catch (error) {
      return c.json<APIResponse>({ success: false, error: getErrorMessage(error) }, 400);
    }
  });

  app.post("/incoming/:id", async (c) => {
    try {
      const id = c.req.param("id");
      const raw = await c.req.text();
      dispatcher().verifyIncomingSignature(
        id,
        raw,
        c.req.header("X-Webhook-Signature") ?? null,
        c.req.header("X-Webhook-Timestamp") ?? null
      );
      const payload = safeParseJson(raw);
      const eventType = "webhook.incoming";
      const event = await getEventBus(deps.memory.db).publish({
        type: eventType,
        source: `webhook:${id}`,
        payload,
      });
      return c.json<APIResponse>({ success: true, data: event }, 202);
    } catch (error) {
      const message = getErrorMessage(error);
      const status =
        message === "Webhook not found" ? 404 : message.includes("signature") ? 401 : 400;
      return c.json<APIResponse>({ success: false, error: message }, status);
    }
  });

  app.get("/:id", (c) => {
    try {
      const webhook = dispatcher().getWebhook(c.req.param("id"));
      if (!webhook) {
        return c.json<APIResponse>({ success: false, error: "Webhook not found" }, 404);
      }
      return c.json<APIResponse>({ success: true, data: webhook });
    } catch (error) {
      return c.json<APIResponse>({ success: false, error: getErrorMessage(error) }, 500);
    }
  });

  app.put("/:id", async (c) => {
    try {
      const body = await c.req.json<WebhookBody>();
      const webhook = dispatcher().updateWebhook(c.req.param("id"), {
        url: typeof body.url === "string" ? body.url.trim() : undefined,
        events: body.events !== undefined ? parseEvents(body.events) : undefined,
        secret: typeof body.secret === "string" ? body.secret : undefined,
        active: typeof body.active === "boolean" ? body.active : undefined,
        maxRetries: parseMaxRetries(body.maxRetries),
      });
      if (!webhook) {
        return c.json<APIResponse>({ success: false, error: "Webhook not found" }, 404);
      }
      return c.json<APIResponse>({ success: true, data: webhook });
    } catch (error) {
      return c.json<APIResponse>({ success: false, error: getErrorMessage(error) }, 400);
    }
  });

  app.delete("/:id", (c) => {
    try {
      const deleted = dispatcher().deleteWebhook(c.req.param("id"));
      if (!deleted) {
        return c.json<APIResponse>({ success: false, error: "Webhook not found" }, 404);
      }
      return c.json<APIResponse<null>>({ success: true, data: null });
    } catch (error) {
      return c.json<APIResponse>({ success: false, error: getErrorMessage(error) }, 500);
    }
  });

  app.post("/:id/test", async (c) => {
    try {
      const delivery = await dispatcher().testWebhook(c.req.param("id"));
      return c.json<APIResponse>({ success: true, data: delivery }, 202);
    } catch (error) {
      const message = getErrorMessage(error);
      return c.json<APIResponse>(
        { success: false, error: message },
        message === "Webhook not found" ? 404 : 500
      );
    }
  });

  app.get("/:id/deliveries", (c) => {
    try {
      const id = c.req.param("id");
      if (!dispatcher().getWebhook(id)) {
        return c.json<APIResponse>({ success: false, error: "Webhook not found" }, 404);
      }
      const limit = Number(c.req.query("limit") ?? 50);
      return c.json<APIResponse>({
        success: true,
        data: dispatcher().listDeliveries(id, Number.isInteger(limit) ? limit : 50),
      });
    } catch (error) {
      return c.json<APIResponse>({ success: false, error: getErrorMessage(error) }, 500);
    }
  });

  app.post("/:id/deliveries/:deliveryId/retry", async (c) => {
    try {
      const delivery = await dispatcher().retryDelivery(
        c.req.param("id"),
        c.req.param("deliveryId")
      );
      return c.json<APIResponse>({ success: true, data: delivery }, 202);
    } catch (error) {
      const message = getErrorMessage(error);
      return c.json<APIResponse>(
        { success: false, error: message },
        message === "Delivery not found" ? 404 : 500
      );
    }
  });

  return app;
}
