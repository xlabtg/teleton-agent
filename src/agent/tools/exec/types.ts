import type { SandboxMode } from "../../../services/sandbox.js";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  duration: number; // ms
  truncated: boolean;
  timedOut: boolean;
  dryRun?: boolean;
  sandboxMode?: SandboxMode;
}

export interface ExecAuditEntry {
  userId: number;
  username?: string;
  tool: "exec_run" | "exec_install" | "exec_service" | "exec_status";
  command: string;
  status: "running" | "success" | "failed" | "timeout" | "killed";
  exitCode?: number;
  signal?: string;
  duration?: number;
  stdout?: string;
  stderr?: string;
  truncated: boolean;
}

export interface RunOptions {
  timeout: number; // ms
  signal?: AbortSignal;
  maxOutput: number; // chars
  /** When false, execute via spawn(argv[0], argv.slice(1)) without a shell. Default: true. */
  useShell?: boolean;
  /**
   * Explicit argv to spawn when useShell is false. When provided, the command
   * string is used only for audit/logging and is NOT tokenized or interpreted
   * by a shell. This lets callers build a strictly validated argv themselves.
   */
  argv?: string[];
  sandboxMode?: SandboxMode;
}
