/**
 * CLI commands for managing MCP servers.
 *
 *   teleton mcp add <package> [args...]   — add an MCP server
 *   teleton mcp remove <name>             — remove an MCP server
 *   teleton mcp list                      — list configured MCP servers
 */

import { getDefaultConfigPath } from "../../config/loader.js";
import { readRawConfig, writeRawConfig } from "../../config/configurable-keys.js";

function ensureMcpSection(raw: Record<string, unknown>): Record<string, Record<string, unknown>> {
  if (!raw.mcp || typeof raw.mcp !== "object") {
    raw.mcp = { servers: {} };
  }
  const mcp = raw.mcp as Record<string, unknown>;
  if (!mcp.servers || typeof mcp.servers !== "object") {
    mcp.servers = {};
  }
  return mcp.servers as Record<string, Record<string, unknown>>;
}

/**
 * Derive a short server name from a package specifier.
 * "@modelcontextprotocol/server-filesystem" → "filesystem"
 * "@anthropic/mcp-server-brave-search" → "brave-search"
 * "some-mcp-server" → "some-mcp-server"
 */
function deriveServerName(pkg: string): string {
  // Strip leading scope
  const unscoped = pkg.includes("/") ? (pkg.split("/").pop() ?? pkg) : pkg;
  // Strip common prefixes
  return unscoped
    .replace(/^server-/, "")
    .replace(/^mcp-server-/, "")
    .replace(/^mcp-/, "");
}

export async function mcpAddCommand(
  pkg: string,
  extraArgs: string[],
  options: { name?: string; scope?: string; env?: string[]; url?: boolean; config?: string }
): Promise<void> {
  const configPath = options.config || getDefaultConfigPath();
  const raw = readRawConfig(configPath);
  const servers = ensureMcpSection(raw);

  const serverName = options.name || deriveServerName(pkg);

  if (servers[serverName]) {
    console.error(`❌ MCP server "${serverName}" already exists. Remove it first or use --name.`);
    process.exit(1);
  }

  const entry: Record<string, unknown> = {};

  if (options.url) {
    // Treat pkg as a URL
    entry.url = pkg;
  } else {
    // Store command and args separately to preserve arguments with spaces
    entry.command = "npx";
    entry.args = ["-y", pkg, ...extraArgs];
  }

  if (options.scope && options.scope !== "always") {
    entry.scope = options.scope;
  }

  // Parse --env KEY=VALUE pairs
  if (options.env && options.env.length > 0) {
    const envMap: Record<string, string> = {};
    for (const pair of options.env) {
      const eq = pair.indexOf("=");
      if (eq === -1) {
        console.error(`❌ Invalid --env format: "${pair}" (expected KEY=VALUE)`);
        process.exit(1);
      }
      envMap[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    entry.env = envMap;
  }

  servers[serverName] = entry;
  writeRawConfig(raw, configPath);

  console.log(`✅ Added MCP server "${serverName}"`);
  if (entry.command) {
    console.log(`   Command: ${entry.command}`);
  } else {
    console.log(`   URL: ${entry.url}`);
  }
  console.log(`\n   Restart teleton to connect: teleton start`);
}

export async function mcpRemoveCommand(name: string, options: { config?: string }): Promise<void> {
  const configPath = options.config || getDefaultConfigPath();
  const raw = readRawConfig(configPath);
  const servers = ensureMcpSection(raw);

  if (!servers[name]) {
    console.error(`❌ MCP server "${name}" not found.`);
    const names = Object.keys(servers);
    if (names.length > 0) {
      console.error(`   Available: ${names.join(", ")}`);
    }
    process.exit(1);
  }

  delete servers[name];
  writeRawConfig(raw, configPath);
  console.log(`✅ Removed MCP server "${name}"`);
}

export async function mcpListCommand(options: { config?: string }): Promise<void> {
  const configPath = options.config || getDefaultConfigPath();
  const raw = readRawConfig(configPath);
  const servers = ensureMcpSection(raw);

  const entries = Object.entries(servers);
  if (entries.length === 0) {
    console.log("No MCP servers configured.");
    console.log("\n  Add one: teleton mcp add @modelcontextprotocol/server-filesystem /tmp");
    return;
  }

  console.log(`MCP servers (${entries.length}):\n`);
  for (const [name, cfg] of entries) {
    const type = cfg.command ? "stdio" : "sse";
    const target = (cfg.command as string) || (cfg.url as string) || "?";
    const scope = (cfg.scope as string) || "always";
    const enabled = cfg.enabled !== false ? "✓" : "✗";
    console.log(`  ${enabled} ${name} (${type}, ${scope})`);
    console.log(`    ${target}`);
    if (cfg.env && typeof cfg.env === "object") {
      const keys = Object.keys(cfg.env as object);
      console.log(`    env: ${keys.join(", ")}`);
    }
  }
}
