import { Type } from "@sinclair/typebox";
import type { Tool, ToolExecutor, ToolResult } from "../types.js";
import type { ExecConfig } from "../../../config/schema.js";
import { runCommand } from "./runner.js";
import { isCommandAllowed } from "./allowlist.js";
import { parseSafeTokenList } from "./validate.js";
import { insertAuditEntry, updateAuditEntry } from "./audit.js";
import type Database from "better-sqlite3";

interface ExecInstallParams {
  manager: "apt" | "pip" | "npm" | "docker";
  packages: string;
}

// Each entry is the fixed argv prefix the package list is appended to. The
// command is always spawned without a shell (argv array) so interpolated
// package names can never be interpreted as shell syntax.
const INSTALL_ARGV: Record<string, string[]> = {
  apt: ["apt", "install", "-y"],
  pip: ["pip", "install"],
  npm: ["npm", "install", "-g"],
  docker: ["docker", "pull"],
};

export const execInstallTool: Tool = {
  name: "exec_install",
  description:
    "Install packages using a specified package manager (apt, pip, npm, or docker pull). Constructs the correct install command automatically.",
  parameters: Type.Object({
    manager: Type.Union(
      [Type.Literal("apt"), Type.Literal("pip"), Type.Literal("npm"), Type.Literal("docker")],
      { description: "Package manager to use" }
    ),
    packages: Type.String({
      description: "Space-separated package names to install (e.g. 'nginx curl')",
    }),
  }),
};

export function createExecInstallExecutor(
  db: Database.Database,
  execConfig: ExecConfig
): ToolExecutor<ExecInstallParams> {
  return async (params, context): Promise<ToolResult> => {
    const { manager, packages } = params;
    const { timeout, max_output } = execConfig.limits;

    const baseArgv = INSTALL_ARGV[manager];
    if (!baseArgv) {
      return {
        success: false,
        error: `Unsupported package manager: ${manager}. Use apt, pip, npm, or docker.`,
      };
    }

    // In allowlist mode the package manager binary itself must be permitted.
    if (
      execConfig.mode === "allowlist" &&
      !isCommandAllowed(baseArgv[0], execConfig.command_allowlist)
    ) {
      return {
        success: false,
        error: `Command not permitted. Allowed commands: ${execConfig.command_allowlist.length > 0 ? execConfig.command_allowlist.join(", ") : "(none configured)"}.`,
      };
    }

    // Validate each package token and execute without a shell to prevent
    // injection through metacharacters in the model-controlled package list.
    const parsed = parseSafeTokenList(packages);
    if ("invalid" in parsed) {
      return {
        success: false,
        error:
          parsed.invalid === ""
            ? "No packages specified."
            : `Invalid package name: ${JSON.stringify(parsed.invalid)}. Package names may only contain letters, digits, and ._@/:=+- characters.`,
      };
    }

    const argv = [...baseArgv, ...parsed.tokens];
    const command = argv.join(" ");

    let auditId: number | undefined;
    if (execConfig.audit.log_commands) {
      auditId = insertAuditEntry(db, {
        userId: context.senderId,
        username: undefined,
        tool: "exec_install",
        command,
        status: "running",
        truncated: false,
      });
    }

    const result = await runCommand(command, {
      timeout: timeout * 1000,
      signal: context.signal,
      maxOutput: max_output,
      useShell: false,
      argv,
      sandboxMode: execConfig.sandbox_mode,
    });

    const status = result.timedOut ? "timeout" : result.exitCode === 0 ? "success" : "failed";

    if (auditId !== undefined) {
      updateAuditEntry(db, auditId, {
        status,
        exitCode: result.exitCode ?? undefined,
        signal: result.signal ?? undefined,
        duration: result.duration,
        stdout: result.stdout,
        stderr: result.stderr,
        truncated: result.truncated,
      });
    }

    return {
      success: result.exitCode === 0 && !result.timedOut,
      data: {
        manager,
        packages,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        duration: result.duration,
        truncated: result.truncated,
        timedOut: result.timedOut,
        dryRun: result.dryRun ?? false,
        sandboxMode: result.sandboxMode ?? execConfig.sandbox_mode,
      },
      ...(result.timedOut
        ? { error: `Install timed out after ${timeout}s` }
        : result.exitCode !== 0
          ? { error: `Install failed with exit code ${result.exitCode}` }
          : {}),
    };
  };
}
