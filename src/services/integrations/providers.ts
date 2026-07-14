import type { McpServerInfo } from "../../webui/types.js";
import type { TelegramBridge } from "../../telegram/bridge.js";
import {
  type Integration,
  type IntegrationAuthConfig,
  type IntegrationEntity,
  type IntegrationHealth,
  type IntegrationHttpActionConfig,
  type IntegrationResult,
} from "./base.js";
import type { IntegrationAuthManager } from "./auth.js";
import { createPinnedOutboundFetch } from "../outbound-url-guard.js";

export interface IntegrationProviderDeps {
  auth: IntegrationAuthManager;
  bridge?: Pick<TelegramBridge, "isAvailable" | "sendMessage"> | null;
  mcpServers?: McpServerInfo[] | (() => McpServerInfo[]) | null;
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const INTEGRATION_URL_GUARD = {
  allowedProtocols: ["http:", "https:"] as const,
  label: "Integration HTTP URL",
};

abstract class BaseIntegrationProvider implements Integration {
  readonly id: string;
  readonly name: string;
  readonly type: IntegrationEntity["type"];
  readonly auth: IntegrationAuthConfig;

  constructor(protected readonly entity: IntegrationEntity) {
    this.id = entity.id;
    this.name = entity.name;
    this.type = entity.type;
    this.auth = entity.auth;
  }

  abstract healthCheck(): Promise<IntegrationHealth>;
  abstract execute(action: string, params: Record<string, unknown>): Promise<IntegrationResult>;
}

export class HttpIntegrationProvider extends BaseIntegrationProvider {
  private readonly authManager: IntegrationAuthManager;
  private readonly fetchImpl: typeof fetch;

  constructor(entity: IntegrationEntity, deps: IntegrationProviderDeps) {
    super(entity);
    this.authManager = deps.auth;
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  async healthCheck(): Promise<IntegrationHealth> {
    const url = this.entity.healthCheckUrl || stringValue(this.entity.config.healthCheckUrl);
    if (!url) {
      return {
        status: "unconfigured",
        checkedAt: new Date().toISOString(),
        message: "No health check URL configured",
      };
    }
    const started = Date.now();
    try {
      const headers = await this.authManager.resolveHeaders(this.entity.authId, this.entity.auth);
      const response = await this.fetchWithTimeout(url, { method: "GET", headers });
      return {
        status: response.ok ? "healthy" : "degraded",
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - started,
        message: response.ok ? "Health check succeeded" : `HTTP ${response.status}`,
        details: { status: response.status },
      };
    } catch (error) {
      return {
        status: "unhealthy",
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - started,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async execute(action: string, params: Record<string, unknown>): Promise<IntegrationResult> {
    const started = Date.now();
    try {
      const actionConfig = this.resolveAction(action);
      const url = this.resolveUrl(actionConfig, params);
      const authHeaders = await this.authManager.resolveHeaders(
        this.entity.authId,
        this.entity.auth
      );
      const headers: Record<string, string> = {
        ...stringRecord(this.entity.config.headers),
        ...stringRecord(actionConfig.headers),
        ...stringRecord(params.headers),
        ...authHeaders,
      };
      const body = params.body ?? actionConfig.body;
      const init: RequestInit = {
        method: actionConfig.method ?? stringValue(params.method) ?? "GET",
        headers,
      };

      if (body !== undefined && init.method !== "GET" && init.method !== "DELETE") {
        if (typeof body === "string") {
          init.body = body;
        } else {
          init.body = JSON.stringify(body);
          if (!headers["Content-Type"] && !headers["content-type"]) {
            headers["Content-Type"] = "application/json";
          }
        }
      }

      const response = await this.fetchWithTimeout(url.toString(), init);
      const data = await readResponse(response);
      return {
        success: response.ok,
        status: response.status,
        data,
        error: response.ok ? undefined : `HTTP ${response.status}`,
        headers: Object.fromEntries(response.headers.entries()),
        latencyMs: Date.now() - started,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        latencyMs: Date.now() - started,
      };
    }
  }

  private resolveAction(action: string): IntegrationHttpActionConfig {
    const actions = this.entity.config.actions ?? {};
    if (actions[action]) return actions[action];
    if (action === "request") return { method: "GET", path: "/" };
    throw new Error(`Unknown integration action: ${action}`);
  }

  private resolveUrl(
    actionConfig: IntegrationHttpActionConfig,
    params: Record<string, unknown>
  ): URL {
    const baseUrl = stringValue(this.entity.config.baseUrl);
    const target =
      stringValue(params.url) || actionConfig.url || stringValue(params.path) || actionConfig.path;
    if (!target && !baseUrl) throw new Error("Integration baseUrl or action URL is required");

    const interpolated = interpolatePath(target || "/", params);
    const url = baseUrl ? new URL(interpolated, baseUrl) : new URL(interpolated);
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error("Integration HTTP actions only support http and https URLs");
    }

    if (baseUrl) {
      const base = new URL(baseUrl);
      if (url.origin !== base.origin && this.entity.config.allowCrossOrigin !== true) {
        throw new Error("Integration action URL must stay within the configured baseUrl origin");
      }
    }

    const query = {
      ...queryRecord(actionConfig.query),
      ...queryRecord(params.query),
    };
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, String(value));
    }
    return url;
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const timeoutMs = numberValue(this.entity.config.timeoutMs) ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let target: Awaited<ReturnType<typeof createPinnedOutboundFetch>> | undefined;
    try {
      target = await createPinnedOutboundFetch(url, {
        ...INTEGRATION_URL_GUARD,
        fetchImpl: this.fetchImpl,
      });
      return await target.fetch(target.url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
      await target?.close();
    }
  }
}

export class TelegramIntegrationProvider extends BaseIntegrationProvider {
  constructor(
    entity: IntegrationEntity,
    private readonly bridge?: Pick<TelegramBridge, "isAvailable" | "sendMessage"> | null
  ) {
    super(entity);
  }

  async healthCheck(): Promise<IntegrationHealth> {
    if (!this.bridge) {
      return {
        status: "unconfigured",
        checkedAt: new Date().toISOString(),
        message: "Telegram bridge is not initialized",
      };
    }
    const available = this.bridge.isAvailable();
    return {
      status: available ? "healthy" : "degraded",
      checkedAt: new Date().toISOString(),
      message: available ? "Telegram bridge is available" : "Telegram bridge is disconnected",
    };
  }

  async execute(action: string, params: Record<string, unknown>): Promise<IntegrationResult> {
    if (action !== "send_message") {
      return { success: false, error: `Unknown Telegram integration action: ${action}` };
    }
    if (!this.bridge?.isAvailable()) {
      return { success: false, error: "Telegram bridge unavailable" };
    }
    const chatId = stringValue(params.chatId);
    const text = stringValue(params.text);
    if (!chatId || !text) {
      return { success: false, error: "chatId and text are required" };
    }
    await this.bridge.sendMessage({ chatId, text });
    return { success: true, data: { sent: true } };
  }
}

export class McpIntegrationProvider extends BaseIntegrationProvider {
  constructor(
    entity: IntegrationEntity,
    private readonly mcpServers?: McpServerInfo[] | (() => McpServerInfo[]) | null
  ) {
    super(entity);
  }

  async healthCheck(): Promise<IntegrationHealth> {
    const servers = typeof this.mcpServers === "function" ? this.mcpServers() : this.mcpServers;
    const configured = servers?.find((server) => server.name === this.entity.id);
    if (!configured) {
      return {
        status: "unconfigured",
        checkedAt: new Date().toISOString(),
        message: "MCP server is not configured",
      };
    }
    return {
      status: configured.connected ? "healthy" : "unhealthy",
      checkedAt: new Date().toISOString(),
      details: {
        toolCount: configured.toolCount,
        enabled: configured.enabled,
        target: configured.target,
      },
      message: configured.connected ? "MCP server connected" : "MCP server disconnected",
    };
  }

  async execute(): Promise<IntegrationResult> {
    return {
      success: false,
      error: "MCP actions are exposed as agent tools and cannot be executed directly here",
    };
  }
}

export function createIntegrationProvider(
  entity: IntegrationEntity,
  deps: IntegrationProviderDeps
): Integration {
  if (entity.provider === "telegram") return new TelegramIntegrationProvider(entity, deps.bridge);
  if (entity.provider === "mcp" || entity.type === "mcp") {
    return new McpIntegrationProvider(entity, deps.mcpServers);
  }
  return new HttpIntegrationProvider(entity, deps);
}

async function readResponse(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json();
  }
  return response.text();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const record: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") record[key] = entry;
  }
  return record;
}

function queryRecord(value: unknown): Record<string, string | number | boolean> {
  if (!isRecord(value)) return {};
  const record: Record<string, string | number | boolean> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") {
      record[key] = entry;
    }
  }
  return record;
}

function interpolatePath(path: string, params: Record<string, unknown>): string {
  return path.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key: string) => {
    const value = params[key];
    return typeof value === "string" || typeof value === "number"
      ? encodeURIComponent(String(value))
      : match;
  });
}
