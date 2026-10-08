import { Type } from "@sinclair/typebox";
import type { Tool, ToolExecutor, ToolResult } from "../types.js";
import type { ExecConfig } from "../../../config/schema.js";
import { runCommand } from "./runner.js";
import { insertAuditEntry, updateAuditEntry } from "./audit.js";
import { isCommandAllowed } from "./allowlist.js";
import type Database from "better-sqlite3";

export { tokenizeCommand, isCommandAllowed } from "./allowlist.js";

interface ExecRunParams {
  command: string;
}

export const execRunTool: Tool = {
  name: "exec_run",
  description:
    "Execute a shell command on the host system. In allowlist mode, only simple commands without pipes or redirects are supported. Returns stdout, stderr, and exit code.",
  parameters: Type.Object({
    command: Type.String({
      description:
        "The command to execute. In allowlist mode: simple commands only (no pipes, &&, redirects). In yolo mode: full bash syntax supported.",
    }),
  }),
};

export function createExecRunExecutor(
  db: Database.Database,
  execConfig: ExecConfig
): ToolExecutor<ExecRunParams> {
  return async (params, context): Promise<ToolResult> => {
    const { command } = params;
    const { timeout, max_output } = execConfig.limits;

    if (execConfig.mode === "allowlist") {
      if (!isCommandAllowed(command, execConfig.command_allowlist)) {
        return {
          success: false,
          error: `Command not permitted. Allowed commands: ${execConfig.command_allowlist.length > 0 ? execConfig.command_allowlist.join(", ") : "(none configured)"}. Note: pipes, redirects, and shell operators are not supported in allowlist mode.`,
        };
      }
    }

    let auditId: number | undefined;
    if (execConfig.audit.log_commands) {
      auditId = insertAuditEntry(db, {
        userId: context.senderId,
        username: undefined,
        tool: "exec_run",
        command,
        status: "running",
        truncated: false,
      });
    }

    // In allowlist mode execute without a shell to prevent injection.
    // tokenizeCommand is guaranteed to succeed here because isCommandAllowed already checked.
    const useShell = execConfig.mode !== "allowlist";
    const result = await runCommand(command, {
      timeout: timeout * 1000,
      signal: context.signal,
      maxOutput: max_output,
      useShell,
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
        ? { error: `Command timed out after ${timeout}s` }
        : result.exitCode !== 0
          ? { error: `Command exited with code ${result.exitCode}` }
          : {}),
    };
  };
}
