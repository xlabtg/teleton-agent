import { Type } from "@sinclair/typebox";
import type { Tool, ToolExecutor, ToolResult } from "../types.js";
import type { ExecConfig } from "../../../config/schema.js";
import { runCommand } from "./runner.js";
import { isCommandAllowed } from "./allowlist.js";
import { isSafeArgToken } from "./validate.js";
import { insertAuditEntry, updateAuditEntry } from "./audit.js";
import type Database from "better-sqlite3";

interface ExecServiceParams {
  action: "start" | "stop" | "restart" | "status" | "enable" | "disable";
  name: string;
}

export const execServiceTool: Tool = {
  name: "exec_service",
  description:
    "Manage systemd services. Supports start, stop, restart, status, enable, and disable actions.",
  parameters: Type.Object({
    action: Type.Union(
      [
        Type.Literal("start"),
        Type.Literal("stop"),
        Type.Literal("restart"),
        Type.Literal("status"),
        Type.Literal("enable"),
        Type.Literal("disable"),
      ],
      { description: "Systemd action to perform" }
    ),
    name: Type.String({
      description: "Service name (e.g. 'nginx', 'docker', 'postgresql')",
    }),
  }),
};

export function createExecServiceExecutor(
  db: Database.Database,
  execConfig: ExecConfig
): ToolExecutor<ExecServiceParams> {
  return async (params, context): Promise<ToolResult> => {
    const { action, name } = params;
    const { timeout, max_output } = execConfig.limits;

    // In allowlist mode the systemctl binary itself must be permitted.
    if (
      execConfig.mode === "allowlist" &&
      !isCommandAllowed("systemctl", execConfig.command_allowlist)
    ) {
      return {
        success: false,
        error: `Command not permitted. Allowed commands: ${execConfig.command_allowlist.length > 0 ? execConfig.command_allowlist.join(", ") : "(none configured)"}.`,
      };
    }

    // Validate the service name and execute without a shell to prevent injection
    // through metacharacters in the model-controlled service name.
    if (!isSafeArgToken(name)) {
      return {
        success: false,
        error: `Invalid service name: ${JSON.stringify(name)}. Service names may only contain letters, digits, and ._@/:=+- characters.`,
      };
    }

    const argv = ["systemctl", action, name];
    const command = argv.join(" ");

    let auditId: number | undefined;
    if (execConfig.audit.log_commands) {
      auditId = insertAuditEntry(db, {
        userId: context.senderId,
        username: undefined,
        tool: "exec_service",
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
        service: name,
        action,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        duration: result.duration,
        dryRun: result.dryRun ?? false,
        sandboxMode: result.sandboxMode ?? execConfig.sandbox_mode,
      },
      ...(result.timedOut
        ? { error: `Service command timed out after ${timeout}s` }
        : result.exitCode !== 0
          ? { error: `systemctl ${action} ${name} failed (exit code ${result.exitCode})` }
          : {}),
    };
  };
}
