import { Command } from "commander";
import { onboardCommand } from "./commands/onboard.js";
import { doctorCommand } from "./commands/doctor.js";
import { mcpAddCommand, mcpRemoveCommand, mcpListCommand } from "./commands/mcp.js";
import { configCommand } from "./commands/config.js";
import { apiRotateKeyCommand, apiFingerprintCommand } from "./commands/api.js";
import { autonomousCommand } from "./commands/autonomous.js";
import { backupCommand, restoreCommand } from "./commands/backup.js";
import { registerGocoonCommand } from "./commands/gocoon.js";
import {
  configExists,
  getDefaultConfigPath,
  getNormalDefaultConfigPath,
} from "../config/loader.js";
import { readFileSync, existsSync } from "fs";
import { dirname, isAbsolute, join, resolve } from "path";
import { fileURLToPath } from "url";
import { getErrorMessage } from "../utils/errors.js";

function findPackageJson(): Record<string, unknown> {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      return JSON.parse(readFileSync(candidate, "utf-8"));
    }
    dir = dirname(dir);
  }
  return { version: "0.0.0" };
}
const packageJson = findPackageJson();

const program = new Command();

function printConfigNotFoundError(configPath: string): void {
  const teletonHome = process.env.TELETON_HOME;
  const envDefaultConfigPath = getDefaultConfigPath();
  const normalDefaultConfigPath = getNormalDefaultConfigPath();
  const teletonHomeChangesDefault =
    Boolean(teletonHome) &&
    configPath === envDefaultConfigPath &&
    envDefaultConfigPath !== normalDefaultConfigPath;

  console.error("❌ Configuration not found");

  if (!teletonHomeChangesDefault) {
    console.error(`   Expected file: ${configPath}`);
    console.error("\n💡 Run first: teleton setup");
    console.error("   Or use: teleton start --api (for API-only bootstrap)");
    return;
  }

  console.error(
    "   A custom TELETON_HOME override is active, so Teleton is looking for config under that directory."
  );
  console.error(`   TELETON_HOME: ${teletonHome}`);
  console.error(`   Expected file: ${configPath}`);
  console.error(`   Normal default file: ${normalDefaultConfigPath}`);

  if (configExists(normalDefaultConfigPath)) {
    console.error("\n💡 A config already exists in the normal default location.");
    console.error(
      "   If TELETON_HOME was only set as a temporary workaround for #364, unset it and retry."
    );
  } else {
    console.error("\n💡 Run first: teleton setup");
    console.error("   Or unset TELETON_HOME to use the normal default location.");
  }

  console.error("\n   To unset TELETON_HOME:");
  console.error("   Windows cmd: set TELETON_HOME=");
  console.error("   PowerShell: $env:TELETON_HOME=$null");
  console.error("   macOS/Linux: unset TELETON_HOME");
  console.error("\n   Or use: teleton start --api (for API-only bootstrap)");
}

function ensureStartConfigExists(configPath?: string): boolean {
  if (configPath) {
    const expanded = configPath.startsWith("~")
      ? join(process.env.HOME || process.env.USERPROFILE || "", configPath.slice(1))
      : configPath;
    const absolute = resolve(expanded);

    if (existsSync(absolute)) {
      return true;
    }

    console.error("❌ Configuration not found");
    console.error(`   Expected file: ${absolute}`);
    console.error("");
    console.error("   Run: teleton setup");
    return false;
  }

  const home = process.env.TELETON_HOME;
  const activeHome = home
    ? resolve(home)
    : join(process.env.HOME || process.env.USERPROFILE || "", ".teleton");

  const configPathResolved = join(activeHome, "config.yaml");

  if (existsSync(configPathResolved)) {
    return true;
  }

  console.error("❌ Configuration not found");

  if (home) {
    const normalHome = join(process.env.HOME || process.env.USERPROFILE || "", ".teleton");
    const normalConfigPath = join(normalHome, "config.yaml");

    console.error("");
    console.error(
      "   A custom TELETON_HOME override is active, so Teleton is looking for config under that directory."
    );
    console.error(`   TELETON_HOME: ${activeHome}`);
    console.error(`   Expected file: ${configPathResolved}`);
    console.error(`   Normal default file: ${normalConfigPath}`);

    if (existsSync(normalConfigPath)) {
      console.error("");
      console.error("   A config already exists in the normal default location.");
    }

    console.error("");
    console.error(
      "   If TELETON_HOME was only set as a temporary workaround for #364, unset it and retry."
    );
    console.error("");
    console.error("   To unset TELETON_HOME:");
    console.error("   Windows cmd: set TELETON_HOME=");
    console.error("   PowerShell: $env:TELETON_HOME=$null");
    console.error("   macOS/Linux: unset TELETON_HOME");
  } else {
    console.error(`   Expected file: ${configPathResolved}`);
    console.error("");
    console.error("   Run: teleton setup");
  }

  return false;
}

export function bindTeletonHomeToConfig(configPath: string, argv = process.argv): void {
  const explicitConfigArg =
    argv.includes("-c") ||
    argv.includes("--config") ||
    argv.some((arg) => arg.startsWith("--config="));

  if (!explicitConfigArg) return;

  const expandedConfigPath = configPath.startsWith("~")
    ? join(process.env.HOME || process.env.USERPROFILE || "", configPath.slice(1))
    : configPath;
  const absoluteConfigPath = isAbsolute(expandedConfigPath)
    ? expandedConfigPath
    : resolve(process.cwd(), expandedConfigPath);

  process.env.TELETON_HOME = dirname(absoluteConfigPath);
}

program
  .name("teleton")
  .description("Teleton Agent - Personal AI Agent for Telegram")
  .version(packageJson.version as string);

// ── argv redaction for setup secrets ──────────────────────────────────
// Overwrite plaintext secret values in process.argv immediately after
// Commander has parsed them so that subsequent ps/proc snapshots are clean.
function redactArgvValue(value: string | undefined): void {
  if (!value) return;
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === value) {
      process.argv[i] = "<redacted>";
    }
  }
}

// Setup command
program
  .command("setup")
  .description("Interactive wizard to set up Teleton")
  .option("--workspace <dir>", "Workspace directory")
  .option("--non-interactive", "Non-interactive mode")
  .option("--ui", "Launch web-based setup wizard")
  .option("--ui-port <port>", "Port for setup WebUI", "7777")
  .option("--api-id <id>", "Telegram API ID")
  .option("--api-hash <hash>", "Telegram API Hash")
  .option("--phone <number>", "Phone number")
  .option("--api-key <key>", "LLM provider API key")
  .option("--base-url <url>", "Base URL for local LLM server")
  .option("--user-id <id>", "Telegram User ID")
  .option("--tavily-api-key <key>", "Tavily API key for web search")
  .action(async (options) => {
    // Redact sensitive values from argv as soon as they are parsed.
    redactArgvValue(options.apiHash);
    redactArgvValue(options.apiKey);
    redactArgvValue(options.tavilyApiKey);
    try {
      await onboardCommand({
        workspace: options.workspace,
        nonInteractive: options.nonInteractive,
        ui: options.ui,
        uiPort: options.uiPort,
        apiId: options.apiId ? parseInt(options.apiId) : undefined,
        apiHash: options.apiHash,
        phone: options.phone,
        apiKey: options.apiKey,
        baseUrl: options.baseUrl,
        userId: options.userId ? parseInt(options.userId) : undefined,
        tavilyApiKey: options.tavilyApiKey,
      });
    } catch (error) {
      console.error("Error:", getErrorMessage(error));
      process.exit(1);
    }
  });

// Start command
program
  .command("start")
  .description("Start the Teleton agent")
  .option("-c, --config <path>", "Config file path", getDefaultConfigPath())
  .option("--webui", "Enable WebUI server (overrides config)")
  .option("--webui-port <port>", "WebUI server port (default: 7777)")
  .option("--api", "Enable Management API server (overrides config)")
  .option("--api-port <port>", "Management API port (default: 7778)")
  .option("--json-credentials", "Output API credentials as JSON to stdout on start")
  .action(async (options) => {
    try {
      bindTeletonHomeToConfig(options.config);

      // If --api flag and no config: start API-only bootstrap mode
      if (options.api && !configExists(options.config)) {
        if (options.apiPort) {
          process.env.TELETON_API_PORT = options.apiPort;
        }
        if (options.jsonCredentials) {
          process.env.TELETON_JSON_CREDENTIALS = "true";
        }
        const { startApiOnly } = await import("../api/bootstrap.js");
        await startApiOnly({ config: options.config, apiPort: options.apiPort });
        return;
      }

      // Normal flow: config required
      if (!configExists(options.config)) {
        printConfigNotFoundError(options.config);
        process.exit(1);
      }

      // Set environment variables for WebUI flags (will be picked up by config loader)
      if (options.webui) {
        process.env.TELETON_WEBUI_ENABLED = "true";
      }
      if (options.webuiPort) {
        process.env.TELETON_WEBUI_PORT = options.webuiPort;
      }

      // Set environment variables for API flags (will be picked up by config loader)
      if (options.api) {
        process.env.TELETON_API_ENABLED = "true";
      }
      if (options.apiPort) {
        process.env.TELETON_API_PORT = options.apiPort;
      }
      if (options.jsonCredentials) {
        process.env.TELETON_JSON_CREDENTIALS = "true";
      }

      if (!ensureStartConfigExists(options.config)) {
        process.exitCode = 1;
        return;
      }

      const { main: startApp } = await import("../index.js");
      await startApp(options.config);
    } catch (error) {
      console.error("Error:", getErrorMessage(error));
      process.exit(1);
    }
  });

program
  .command("doctor")
  .description("Run system health checks")
  .action(async () => {
    try {
      await doctorCommand();
    } catch (error) {
      console.error("Error:", getErrorMessage(error));
      process.exit(1);
    }
  });

// MCP server management
const mcp = program.command("mcp").description("Manage MCP (Model Context Protocol) servers");

mcp
  .command("add <package> [args...]")
  .description(
    "Add an MCP server (e.g. teleton mcp add @modelcontextprotocol/server-filesystem /tmp)"
  )
  .option("-n, --name <name>", "Server name (auto-derived from package if omitted)")
  .option(
    "-s, --scope <scope>",
    "Tool scope: always | open | dm-only | group-only | admin-only | allowlist | disabled",
    "always"
  )
  .option(
    "-e, --env <KEY=VALUE...>",
    "Environment variables (repeatable)",
    (v: string, prev: string[]) => [...prev, v],
    [] as string[]
  )
  .option("--url", "Treat <package> as an SSE/HTTP URL instead of an npx package")
  .option("-c, --config <path>", "Config file path")
  .action(async (pkg: string, args: string[], options) => {
    try {
      await mcpAddCommand(pkg, args, options);
    } catch (error) {
      console.error("Error:", getErrorMessage(error));
      process.exit(1);
    }
  });

mcp
  .command("remove <name>")
  .description("Remove an MCP server by name")
  .option("-c, --config <path>", "Config file path")
  .action(async (name: string, options) => {
    try {
      await mcpRemoveCommand(name, options);
    } catch (error) {
      console.error("Error:", getErrorMessage(error));
      process.exit(1);
    }
  });

mcp
  .command("list")
  .description("List configured MCP servers")
  .option("-c, --config <path>", "Config file path")
  .action(async (options) => {
    try {
      await mcpListCommand(options);
    } catch (error) {
      console.error("Error:", getErrorMessage(error));
      process.exit(1);
    }
  });

// Config management
program
  .command("config")
  .description("Manage configuration keys (set, get, list, unset)")
  .argument("<action>", "set | get | list | unset")
  .argument("[key]", "Config key (e.g., tavily_api_key, telegram.bot_token)")
  .argument(
    "[value]",
    "Value to set — AVOID for sensitive keys; use --value-file or interactive prompt instead"
  )
  .option("-c, --config <path>", "Config file path")
  .option(
    "--value-file <path>",
    "Read value from file (safe alternative to passing secrets on the command line)"
  )
  .action(async (action: string, key: string | undefined, value: string | undefined, options) => {
    try {
      await configCommand(action, key, value, options);
    } catch (error) {
      console.error("Error:", getErrorMessage(error));
      process.exit(1);
    }
  });

// Management API commands
program
  .command("api-rotate-key")
  .description("Generate a new Management API key")
  .option("-c, --config <path>", "Config file path", getDefaultConfigPath())
  .action(async (options) => {
    try {
      await apiRotateKeyCommand({ config: options.config });
    } catch (error) {
      console.error("Error:", getErrorMessage(error));
      process.exit(1);
    }
  });

program
  .command("api-fingerprint")
  .description("Show TLS certificate fingerprint")
  .action(async () => {
    try {
      await apiFingerprintCommand();
    } catch (error) {
      console.error("Error:", getErrorMessage(error));
      process.exit(1);
    }
  });

// Backup & restore commands
program
  .command("backup")
  .description("Create a compressed, integrity-verified backup of all Teleton data")
  .option("-o, --out <dir>", "Output directory for the archive (default: <data>/backups)")
  .action(async (options) => {
    try {
      await backupCommand({ out: options.out });
    } catch (error) {
      console.error("Error:", getErrorMessage(error));
      process.exit(1);
    }
  });

program
  .command("restore")
  .description("Restore Teleton data from a backup archive")
  .option("-f, --file <path>", "Backup archive to restore (default: latest in <data>/backups)")
  .option("--force", "Allow restoring a backup with a newer schema than this build")
  .option("-y, --yes", "Skip the interactive confirmation prompt")
  .action(async (options) => {
    try {
      await restoreCommand({ file: options.file, force: options.force, yes: options.yes });
    } catch (error) {
      console.error("Error:", getErrorMessage(error));
      process.exit(1);
    }
  });

// Autonomous mode commands
const autonomous = program
  .command("autonomous")
  .description("Manage autonomous tasks (Autonomous Task Engine)");

autonomous
  .command("enable")
  .description("Create and enqueue a new autonomous task")
  .requiredOption("--task <goal>", "Goal description in natural language")
  .option("--priority <level>", "Priority: low|medium|high|critical", "medium")
  .option("--strategy <s>", "Strategy: conservative|balanced|aggressive", "balanced")
  .option("--max-iterations <n>", "Maximum loop iterations")
  .option("--max-hours <n>", "Maximum duration in hours")
  .option(
    "--success-criteria <c>",
    "Success criteria (repeatable)",
    (v: string, prev: string[]) => [...prev, v],
    [] as string[]
  )
  .option("-c, --config <path>", "Config file path")
  .action(async (options) => {
    try {
      await autonomousCommand("enable", {
        task: options.task,
        priority: options.priority,
        strategy: options.strategy,
        maxIterations: options.maxIterations,
        maxHours: options.maxHours,
        successCriteria: options.successCriteria,
        config: options.config,
      });
    } catch (error) {
      console.error("Error:", getErrorMessage(error));
      process.exit(1);
    }
  });

autonomous
  .command("disable")
  .description("Stop and cancel autonomous task(s)")
  .option("--id <taskId>", "Task ID to cancel")
  .option("--force", "Cancel all active tasks")
  .option("-c, --config <path>", "Config file path")
  .action(async (options) => {
    try {
      await autonomousCommand("disable", {
        id: options.id,
        force: options.force,
        config: options.config,
      });
    } catch (error) {
      console.error("Error:", getErrorMessage(error));
      process.exit(1);
    }
  });

autonomous
  .command("pause")
  .description("Pause a running autonomous task")
  .requiredOption("--id <taskId>", "Task ID")
  .option("-c, --config <path>", "Config file path")
  .action(async (options) => {
    try {
      await autonomousCommand("pause", { id: options.id, config: options.config });
    } catch (error) {
      console.error("Error:", getErrorMessage(error));
      process.exit(1);
    }
  });

autonomous
  .command("resume")
  .description("Resume a paused autonomous task")
  .requiredOption("--id <taskId>", "Task ID")
  .option("-c, --config <path>", "Config file path")
  .action(async (options) => {
    try {
      await autonomousCommand("resume", { id: options.id, config: options.config });
    } catch (error) {
      console.error("Error:", getErrorMessage(error));
      process.exit(1);
    }
  });

autonomous
  .command("status")
  .description("Show status of autonomous task(s)")
  .option("--id <taskId>", "Task ID (omit to show all active)")
  .option("-c, --config <path>", "Config file path")
  .action(async (options) => {
    try {
      await autonomousCommand("status", { id: options.id, config: options.config });
    } catch (error) {
      console.error("Error:", getErrorMessage(error));
      process.exit(1);
    }
  });

autonomous
  .command("list")
  .description("List all autonomous tasks")
  .option("--limit <n>", "Max results to show", "20")
  .option("-c, --config <path>", "Config file path")
  .action(async (options) => {
    try {
      await autonomousCommand("list", { limit: options.limit, config: options.config });
    } catch (error) {
      console.error("Error:", getErrorMessage(error));
      process.exit(1);
    }
  });

autonomous
  .command("clean")
  .description("Clean old task checkpoints")
  .option("-c, --config <path>", "Config file path")
  .action(async (options) => {
    try {
      await autonomousCommand("clean", { config: options.config });
    } catch (error) {
      console.error("Error:", getErrorMessage(error));
      process.exit(1);
    }
  });

// gocoon — decentralized LLM on TON (install, setup, top-up, withdraw)
registerGocoonCommand(program);

program.action(() => {
  program.help();
});

if (process.env.TELETON_CLI_SKIP_PARSE !== "true") {
  program.parse(process.argv);
}
