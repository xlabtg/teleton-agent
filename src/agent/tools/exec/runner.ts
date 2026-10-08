import { spawn, type SpawnOptions } from "child_process";
import type { ExecResult, RunOptions } from "./types.js";
import { createLogger } from "../../../utils/logger.js";
import { tokenizeCommand } from "./allowlist.js";
import { createSandboxProfile } from "../../../services/sandbox.js";

const log = createLogger("Exec");

const KILL_GRACE_MS = 5000;

export function runCommand(command: string, options: RunOptions): Promise<ExecResult> {
  const { timeout, maxOutput, useShell = true, argv, sandboxMode = "unrestricted" } = options;
  const startTime = Date.now();
  options.signal?.throwIfAborted();

  return new Promise((resolve) => {
    if (sandboxMode === "dry-run") {
      resolve({
        stdout: "",
        stderr: "",
        exitCode: 0,
        signal: null,
        duration: Date.now() - startTime,
        truncated: false,
        timedOut: false,
        dryRun: true,
        sandboxMode,
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let resolved = false;
    const sandbox = createSandboxProfile(sandboxMode);

    // In no-shell mode, exec directly so the OS never sees a shell. Callers may
    // pass an explicit, pre-validated argv; otherwise the command is tokenized.
    const [spawnCmd, spawnArgs] = useShell
      ? (["bash", ["-c", command]] as [string, string[]])
      : (() => {
          const tokens = argv ?? tokenizeCommand(command) ?? [];
          return [tokens[0] ?? command, tokens.slice(1)] as [string, string[]];
        })();

    const child = spawn(spawnCmd, spawnArgs, {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      ...sandbox.spawnOptions,
    } as SpawnOptions & { encoding: string });

    const finish = (exitCode: number | null, signal: string | null) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      // The shell may close while detached descendants still ignore SIGTERM.
      if (timedOut && child.pid) killProcessGroup(child.pid, "SIGKILL");
      options.signal?.removeEventListener("abort", abort);
      sandbox.cleanup();
      resolve({
        stdout,
        stderr,
        exitCode,
        signal,
        duration: Date.now() - startTime,
        truncated,
        timedOut,
        sandboxMode,
      });
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < maxOutput) {
        stdout += chunk;
        if (stdout.length > maxOutput) {
          stdout = stdout.slice(0, maxOutput);
          truncated = true;
        }
      }
    });

    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < maxOutput) {
        stderr += chunk;
        if (stderr.length > maxOutput) {
          stderr = stderr.slice(0, maxOutput);
          truncated = true;
        }
      }
    });

    child.on("close", (code, sig) => {
      finish(code, sig);
    });

    child.on("error", (err) => {
      log.error({ err }, "Spawn error");
      stderr += err.message;
      finish(1, null);
    });

    // Timeout handling: SIGTERM then SIGKILL
    let killTimer: ReturnType<typeof setTimeout>;
    const abort = () => {
      if (timedOut || resolved) return;
      timedOut = true;
      log.warn({ command, timeout }, "Command timed out, sending SIGTERM");
      if (child.pid) killProcessGroup(child.pid, "SIGTERM");

      killTimer = setTimeout(() => {
        log.warn({ command }, "Grace period expired, sending SIGKILL");
        if (child.pid) killProcessGroup(child.pid, "SIGKILL");
      }, KILL_GRACE_MS);
    };
    const timeoutTimer = setTimeout(abort, timeout);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}

function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // Process already dead — expected
  }
}
