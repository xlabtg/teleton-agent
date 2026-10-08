/**
 * MCP (Model Context Protocol) client loader.
 *
 * Connects to external MCP servers (stdio or SSE) declared in config.yaml,
 * discovers their tools, and registers them in the ToolRegistry.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Ajv, type ErrorObject } from "ajv";
import { TOOL_EXECUTION_TIMEOUT_MS } from "../../constants/timeouts.js";
import { sanitizeForContext } from "../../utils/sanitize.js";
import type { Tool, ToolExecutor, ToolResult, ToolScope } from "./types.js";
import type { ToolRegistry } from "./registry.js";
import type { McpConfig, McpServerConfig } from "../../config/schema.js";
import { getErrorMessage } from "../../utils/errors.js";
import { createLogger } from "../../utils/logger.js";
import { BLOCKED_MCP_ENV_KEYS, createPinnedMcpServerFetch } from "../../config/mcp-security.js";

/**
 * Built-in tool name prefixes that MCP tools must not shadow.
 * An MCP tool whose original name starts with any of these is rejected.
 */
const RESERVED_TOOL_PREFIXES = [
  "ton_",
  "jetton_",
  "wallet_",
  "exec",
  "exec_",
  "telegram_",
  "dns_",
  "stonfi_",
  "dedust_",
  "dex_",
  "nft_",
  "journal_",
  "workspace_",
  "web_",
  "bot_",
  "mcp_",
  "mcp.",
] as const;

const log = createLogger("MCP");

const ajv = new Ajv({ allErrors: true, strict: false });

export interface McpConnection {
  serverName: string;
  client: Client;
  scope: ToolScope;
}

const MCP_CONNECT_TIMEOUT_MS = 30_000;

/**
 * Parse a command string into command + args.
 * If explicit args are provided in config, uses those instead.
 */
function parseCommand(config: McpServerConfig): { command: string; args: string[] } {
  if (!config.command) throw new Error("No command specified");

  if (config.args) {
    return { command: config.command, args: config.args };
  }

  const parts = config.command.split(/\s+/);
  return { command: parts[0], args: parts.slice(1) };
}

/**
 * Extract text content from MCP tool result content array.
 */
function extractText(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text ?? "")
    .join("\n");
}

/**
 * Connect to all configured MCP servers in parallel.
 * Failed connections are logged and skipped.
 */
export async function loadMcpServers(config: McpConfig): Promise<McpConnection[]> {
  const entries = Object.entries(config.servers).filter(([, cfg]) => cfg.enabled !== false);

  if (entries.length === 0) return [];

  const results = await Promise.allSettled(
    entries.map(async ([name, serverConfig]): Promise<McpConnection> => {
      let transport;

      if (serverConfig.command) {
        const { command, args } = parseCommand(serverConfig);
        // Only forward essential environment vars to child processes
        const safeEnv: Record<string, string> = {};
        for (const key of ["PATH", "HOME", "NODE_PATH", "LANG", "TERM"]) {
          if (process.env[key]) safeEnv[key] = process.env[key] ?? "";
        }

        const filteredEnv: Record<string, string> = {};
        for (const [k, v] of Object.entries(serverConfig.env ?? {})) {
          if (BLOCKED_MCP_ENV_KEYS.has(k.toUpperCase())) {
            log.warn({ key: k, server: name }, "Blocked dangerous env var for MCP server");
          } else {
            filteredEnv[k] = v;
          }
        }

        transport = new StdioClientTransport({
          command,
          args,
          env: { ...safeEnv, ...filteredEnv },
          stderr: "pipe",
        });
      } else if (serverConfig.url) {
        transport = await createStreamableHttpTransport(serverConfig.url);
      } else {
        throw new Error(`MCP server "${name}": needs 'command' or 'url'`);
      }

      const client = new Client({ name: `teleton-${name}`, version: "1.0.0" });

      // Connect with timeout; for URL servers, try Streamable HTTP then fall back to SSE
      let timeoutHandle: ReturnType<typeof setTimeout>;
      try {
        await Promise.race([
          client.connect(transport),
          new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(
              () =>
                reject(new Error(`Connection timed out after ${MCP_CONNECT_TIMEOUT_MS / 1000}s`)),
              MCP_CONNECT_TIMEOUT_MS
            );
          }),
        ]).finally(() => clearTimeout(timeoutHandle));
      } catch (error: unknown) {
        // If Streamable HTTP failed on a URL server, retry with SSE
        if (serverConfig.url && transport instanceof StreamableHTTPClientTransport) {
          await client.close().catch(() => {});
          log.info({ server: name }, "Streamable HTTP failed, falling back to SSE");
          transport = await createSseTransport(serverConfig.url);
          const fallbackClient = new Client({ name: `teleton-${name}`, version: "1.0.0" });
          await Promise.race([
            fallbackClient.connect(transport),
            new Promise<never>((_, reject) => {
              timeoutHandle = setTimeout(
                () =>
                  reject(
                    new Error(`SSE fallback timed out after ${MCP_CONNECT_TIMEOUT_MS / 1000}s`)
                  ),
                MCP_CONNECT_TIMEOUT_MS
              );
            }),
          ]).finally(() => clearTimeout(timeoutHandle));
          return {
            serverName: name,
            client: fallbackClient,
            scope: serverConfig.scope ?? "always",
          };
        }
        throw error;
      }

      return { serverName: name, client, scope: serverConfig.scope ?? "always" };
    })
  );

  const connections: McpConnection[] = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const [name] = entries[i];
    if (result.status === "fulfilled") {
      connections.push(result.value);
    } else {
      const reason =
        result.reason instanceof Error
          ? (result.reason.stack ?? result.reason.message)
          : result.reason;
      log.warn({ server: name, reason }, `MCP server "${name}" failed to connect`);
    }
  }

  return connections;
}

async function createStreamableHttpTransport(
  rawUrl: string
): Promise<StreamableHTTPClientTransport> {
  const target = await createPinnedMcpServerFetch(rawUrl);
  return withPinnedFetchCleanup(
    new StreamableHTTPClientTransport(target.url, { fetch: target.fetch }),
    target.close
  );
}

async function createSseTransport(rawUrl: string): Promise<SSEClientTransport> {
  const target = await createPinnedMcpServerFetch(rawUrl);
  return withPinnedFetchCleanup(
    new SSEClientTransport(target.url, { fetch: target.fetch }),
    target.close
  );
}

function withPinnedFetchCleanup<TTransport extends Transport>(
  transport: TTransport,
  cleanup: () => Promise<void>
): TTransport {
  const closeTransport = transport.close.bind(transport);
  let closed = false;

  transport.close = async () => {
    if (closed) return;
    closed = true;
    try {
      await closeTransport();
    } finally {
      await cleanup();
    }
  };

  return transport;
}

/**
 * Discover tools from connected MCP servers and register them in the ToolRegistry.
 * Tool names are namespaced as mcp.<server>.<tool_name>.
 *
 * Registration is rejected when:
 *   - inputSchema.properties is absent or empty (no-op validation would be unsafe)
 *   - the tool's original name starts with a reserved built-in prefix
 */
export async function registerMcpTools(
  connections: McpConnection[],
  registry: ToolRegistry
): Promise<{ count: number; names: string[] }> {
  let totalCount = 0;
  const serverNames: string[] = [];

  for (const conn of connections) {
    try {
      const { tools: mcpTools } = await conn.client.listTools();

      if (!mcpTools || mcpTools.length === 0) continue;

      const registryTools: Array<{ tool: Tool; executor: ToolExecutor; scope?: ToolScope }> = [];

      for (const mcpTool of mcpTools) {
        // Reject tools with no parameter schema — passing raw LLM args without validation is unsafe.
        const schema = mcpTool.inputSchema ?? { type: "object", properties: {} };
        if (
          !schema.properties ||
          Object.keys(schema.properties as Record<string, unknown>).length === 0
        ) {
          log.error(
            { tool: mcpTool.name, server: conn.serverName },
            "MCP tool rejected: missing or empty inputSchema.properties — registration skipped to prevent unvalidated input"
          );
          continue;
        }

        // Reject tools whose name could shadow built-in tools.
        const hasReservedPrefix = RESERVED_TOOL_PREFIXES.some((prefix) =>
          mcpTool.name.startsWith(prefix)
        );
        if (hasReservedPrefix) {
          log.error(
            { tool: mcpTool.name, server: conn.serverName },
            "MCP tool rejected: name starts with a reserved built-in prefix — registration skipped to prevent name collision"
          );
          continue;
        }

        const namespacedName = `mcp.${conn.serverName}.${mcpTool.name}`;
        const validate = ajv.compile(schema);

        const executor: ToolExecutor = async (params, context): Promise<ToolResult> => {
          // Validate params against the advertised JSON Schema before calling the MCP server.
          if (!validate(params)) {
            const detail = (validate.errors ?? [])
              .map((e: ErrorObject) => `${e.instancePath || "/"}: ${e.message}`)
              .join("; ");
            return {
              success: false,
              error: `MCP tool "${mcpTool.name}" received invalid arguments: ${detail}`,
            };
          }

          try {
            const result = await conn.client.callTool(
              {
                name: mcpTool.name,
                arguments: params as Record<string, unknown>,
              },
              undefined,
              { timeout: TOOL_EXECUTION_TIMEOUT_MS, signal: context.signal }
            );

            if (result.isError) {
              const errorText = extractText(
                result.content as Array<{ type: string; text?: string }>
              );
              return {
                success: false,
                error: sanitizeForContext(errorText) || "MCP tool returned error",
              };
            }

            const text = extractText(result.content as Array<{ type: string; text?: string }>);
            return { success: true, data: sanitizeForContext(text) };
          } catch (innerError: unknown) {
            return {
              success: false,
              error: `MCP tool "${mcpTool.name}" failed: ${getErrorMessage(innerError)}`,
            };
          }
        };

        registryTools.push({
          tool: {
            name: namespacedName,
            description: mcpTool.description || `MCP tool from ${conn.serverName}`,
            parameters: schema as unknown as Tool["parameters"],
          },
          executor,
          scope: conn.scope,
        });
      }

      const pluginKey = `mcp.${conn.serverName}`;
      const count = registry.registerPluginTools(pluginKey, registryTools);
      if (count > 0) {
        totalCount += count;
        serverNames.push(conn.serverName);
      }
    } catch (error: unknown) {
      log.warn(`MCP server "${conn.serverName}" tool discovery failed: ${getErrorMessage(error)}`);
    }
  }

  return { count: totalCount, names: serverNames };
}

/**
 * Gracefully close all MCP connections (kills stdio child processes).
 */
export async function closeMcpServers(connections: McpConnection[]): Promise<void> {
  await Promise.allSettled(
    connections.map(async (conn) => {
      try {
        await conn.client.close();
      } catch (error: unknown) {
        log.warn(`MCP server "${conn.serverName}" close failed: ${getErrorMessage(error)}`);
      }
    })
  );
}
