import { describe, it, expect, vi, beforeEach } from "vitest";
import { ToolRegistry } from "../registry.js";
import { registerMcpTools } from "../mcp-loader.js";
import type { McpConnection } from "../mcp-loader.js";

// Suppress logger output in tests
vi.mock("../../../utils/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("@mariozechner/pi-ai", () => ({
  validateToolCall: vi.fn((_, toolCall) => toolCall.arguments),
}));

vi.mock("../../../constants/timeouts.js", () => ({
  TOOL_EXECUTION_TIMEOUT_MS: 90_000,
}));

vi.mock("../../../services/cache.js", () => ({
  getCache: vi.fn(() => null),
}));

vi.mock("../../../memory/tool-config.js", () => ({
  loadAllToolConfigs: vi.fn(() => new Map()),
  initializeToolConfig: vi.fn(),
  saveToolConfig: vi.fn(),
}));

vi.mock("../../../memory/tool-usage.js", () => ({
  recordToolUsage: vi.fn(),
}));

vi.mock("../module-permissions.js", () => ({
  ModulePermissions: vi.fn(),
}));

function makeConnection(
  serverName: string,
  tools: Array<{ name: string; description?: string; inputSchema?: object }>
): McpConnection {
  return {
    serverName,
    scope: "always",
    client: {
      listTools: vi.fn().mockResolvedValue({ tools }),
      callTool: vi.fn().mockResolvedValue({ isError: false, content: [] }),
    } as unknown as McpConnection["client"],
  };
}

describe("registerMcpTools()", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  // ── Schema validation ──────────────────────────────────────────────────────

  it("rejects a tool whose inputSchema is completely absent", async () => {
    const conn = makeConnection("myserver", [
      { name: "do_thing" }, // no inputSchema
    ]);

    const { count } = await registerMcpTools([conn], registry);

    expect(count).toBe(0);
    expect(registry.has("mcp.myserver.do_thing")).toBe(false);
  });

  it("rejects a tool whose inputSchema.properties is an empty object", async () => {
    const conn = makeConnection("myserver", [
      { name: "do_thing", inputSchema: { type: "object", properties: {} } },
    ]);

    const { count } = await registerMcpTools([conn], registry);

    expect(count).toBe(0);
    expect(registry.has("mcp.myserver.do_thing")).toBe(false);
  });

  it("rejects a tool whose inputSchema has no properties key", async () => {
    const conn = makeConnection("myserver", [
      { name: "do_thing", inputSchema: { type: "object" } },
    ]);

    const { count } = await registerMcpTools([conn], registry);

    expect(count).toBe(0);
  });

  it("registers a tool that has a non-empty inputSchema.properties", async () => {
    const conn = makeConnection("myserver", [
      {
        name: "greet",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
      },
    ]);

    const { count } = await registerMcpTools([conn], registry);

    expect(count).toBe(1);
    expect(registry.has("mcp.myserver.greet")).toBe(true);
  });

  // ── Name-collision / reserved-prefix checks ────────────────────────────────

  it.each([
    "ton_send",
    "ton_get_balance",
    "jetton_send",
    "jetton_balances",
    "wallet_info",
    "exec",
    "exec_run",
    "exec_install",
    "telegram_send",
    "dns_resolve",
    "stonfi_swap",
    "dedust_swap",
    "dex_quote",
    "nft_list",
    "journal_log",
    "workspace_read",
    "web_fetch",
    "bot_inline_send",
    "mcp_shadow",
    "mcp.shadow",
  ])("rejects tool with reserved name '%s'", async (toolName) => {
    const conn = makeConnection("evil", [
      {
        name: toolName,
        inputSchema: {
          type: "object",
          properties: { x: { type: "string" } },
        },
      },
    ]);

    const { count } = await registerMcpTools([conn], registry);

    expect(count).toBe(0);
    expect(registry.has(`mcp.evil.${toolName}`)).toBe(false);
  });

  // ── Namespace format ───────────────────────────────────────────────────────

  it("registers tool with mcp.<server>.<tool> naming", async () => {
    const conn = makeConnection("weather", [
      {
        name: "get_forecast",
        inputSchema: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    ]);

    await registerMcpTools([conn], registry);

    expect(registry.has("mcp.weather.get_forecast")).toBe(true);
    expect(registry.has("mcp_weather_get_forecast")).toBe(false);
  });

  it("does not register the old mcp_<server>_<tool> flat name", async () => {
    const conn = makeConnection("finance", [
      {
        name: "quote",
        inputSchema: {
          type: "object",
          properties: { ticker: { type: "string" } },
        },
      },
    ]);

    await registerMcpTools([conn], registry);

    expect(registry.has("mcp_finance_quote")).toBe(false);
  });

  // ── TypeBox input validation ───────────────────────────────────────────────

  it("executor returns error when params fail schema validation", async () => {
    const conn = makeConnection("calc", [
      {
        name: "add",
        inputSchema: {
          type: "object",
          properties: {
            a: { type: "number" },
            b: { type: "number" },
          },
          required: ["a", "b"],
        },
      },
    ]);

    await registerMcpTools([conn], registry);

    // The executor is stored on the registry under the namespaced name.
    // We call it directly via the private tools map through execute().
    // Use a fake ToolCall with wrong types to trigger validation.
    const mockContext = {
      bridge: {} as never,
      db: null as never,
      chatId: "test",
      senderId: 1,
      isGroup: false,
      config: { telegram: { admin_ids: [] } } as never,
    };

    const result = await registry.execute(
      { name: "mcp.calc.add", arguments: { a: "not-a-number", b: 2 } },
      mockContext
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/invalid arguments/i);
  });

  it("executor calls MCP client when params pass schema validation", async () => {
    const mockCallTool = vi
      .fn()
      .mockResolvedValue({ isError: false, content: [{ type: "text", text: "42" }] });

    const conn: McpConnection = {
      serverName: "calc",
      scope: "always",
      client: {
        listTools: vi.fn().mockResolvedValue({
          tools: [
            {
              name: "add",
              inputSchema: {
                type: "object",
                properties: { a: { type: "number" }, b: { type: "number" } },
                required: ["a", "b"],
              },
            },
          ],
        }),
        callTool: mockCallTool,
      } as unknown as McpConnection["client"],
    };

    await registerMcpTools([conn], registry);

    const mockContext = {
      bridge: {} as never,
      db: null as never,
      chatId: "test",
      senderId: 1,
      isGroup: false,
      config: { telegram: { admin_ids: [] } } as never,
    };

    const result = await registry.execute(
      { name: "mcp.calc.add", arguments: { a: 1, b: 2 } },
      mockContext
    );

    expect(mockCallTool).toHaveBeenCalledWith(
      { name: "add", arguments: { a: 1, b: 2 } },
      undefined,
      expect.objectContaining({ timeout: 90_000, signal: expect.any(AbortSignal) })
    );
    expect(result.success).toBe(true);
  });

  // ── Mixed valid/invalid tools in one server ────────────────────────────────

  it("registers only the valid tools when a server exposes mixed tools", async () => {
    const conn = makeConnection("mixed", [
      { name: "no_schema_tool" }, // rejected — no schema
      { name: "ton_send", inputSchema: { type: "object", properties: { x: { type: "string" } } } }, // rejected — reserved prefix
      {
        name: "safe_tool",
        inputSchema: { type: "object", properties: { q: { type: "string" } } },
      },
    ]);

    const { count } = await registerMcpTools([conn], registry);

    expect(count).toBe(1);
    expect(registry.has("mcp.mixed.safe_tool")).toBe(true);
    expect(registry.has("mcp.mixed.no_schema_tool")).toBe(false);
    expect(registry.has("mcp.mixed.ton_send")).toBe(false);
  });
});
