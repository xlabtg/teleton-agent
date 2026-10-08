import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ChildProcess } from "child_process";
import { EventEmitter } from "events";
import { Readable } from "stream";

// Mock child_process
vi.mock("child_process", () => ({
  spawn: vi.fn(),
}));

// Must import AFTER mock
import { spawn } from "child_process";
import { runCommand } from "../runner.js";

const mockSpawn = vi.mocked(spawn);

function createMockProcess(): ChildProcess & EventEmitter {
  const proc = new EventEmitter() as ChildProcess & EventEmitter;
  proc.stdout = new Readable({ read() {} }) as any;
  proc.stderr = new Readable({ read() {} }) as any;
  proc.stdout!.setEncoding = vi.fn().mockReturnThis();
  proc.stderr!.setEncoding = vi.fn().mockReturnThis();
  proc.pid = 12345;
  proc.kill = vi.fn();
  return proc;
}

describe("runner", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("executes command and returns stdout/stderr/exitCode", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = runCommand("echo hello", { timeout: 5000, maxOutput: 50000 });

    proc.stdout!.emit("data", "hello\n");
    proc.stderr!.emit("data", "warn\n");
    proc.emit("close", 0, null);

    const result = await promise;
    expect(result.stdout).toBe("hello\n");
    expect(result.stderr).toBe("warn\n");
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.truncated).toBe(false);
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });

  it("truncates stdout at maxOutput chars", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = runCommand("cat bigfile", { timeout: 5000, maxOutput: 10 });

    proc.stdout!.emit("data", "abcdefghijklmnop");
    proc.emit("close", 0, null);

    const result = await promise;
    expect(result.stdout).toBe("abcdefghij");
    expect(result.truncated).toBe(true);
  });

  it("truncates stderr at maxOutput chars", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = runCommand("failing", { timeout: 5000, maxOutput: 5 });

    proc.stderr!.emit("data", "error: something long");
    proc.emit("close", 1, null);

    const result = await promise;
    expect(result.stderr).toBe("error");
    expect(result.truncated).toBe(true);
  });

  it("handles non-zero exit code", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = runCommand("exit 42", { timeout: 5000, maxOutput: 50000 });
    proc.emit("close", 42, null);

    const result = await promise;
    expect(result.exitCode).toBe(42);
  });

  it("handles spawn error (command not found)", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = runCommand("nonexistent", { timeout: 5000, maxOutput: 50000 });
    proc.emit("error", new Error("spawn ENOENT"));

    const result = await promise;
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("ENOENT");
  });

  it("waits for process termination after cancellation (#758)", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    const controller = new AbortController();
    let settled = false;
    const promise = runCommand("long job", {
      timeout: 120_000,
      maxOutput: 5000,
      signal: controller.signal,
    }).then((result) => {
      settled = true;
      return result;
    });
    controller.abort();
    await vi.advanceTimersByTimeAsync(5000);
    expect(kill).toHaveBeenCalledWith(-12345, "SIGTERM");
    expect(kill).toHaveBeenCalledWith(-12345, "SIGKILL");
    expect(settled).toBe(false);
    proc.emit("close", null, "SIGKILL");
    expect(await promise).toMatchObject({ timedOut: true, signal: "SIGKILL" });
  });

  it("kills remaining children before reporting timeout even if the parent closes first", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const controller = new AbortController();
    const promise = runCommand("long job", {
      timeout: 100,
      maxOutput: 5000,
      signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    proc.emit("close", null, "SIGTERM");
    await promise;
    expect(kill.mock.calls).toEqual([
      [-12345, "SIGTERM"],
      [-12345, "SIGKILL"],
    ]);
    await vi.advanceTimersByTimeAsync(6000);
    expect(kill).toHaveBeenCalledTimes(2);
  });

  it("kills process tree on timeout", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const promise = runCommand("sleep 999", { timeout: 100, maxOutput: 50000 });

    vi.advanceTimersByTime(150);

    // Process gets killed, simulate close
    proc.emit("close", null, "SIGTERM");

    const result = await promise;
    expect(result.timedOut).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(-12345, "SIGTERM");

    killSpy.mockRestore();
  });

  it("spawns explicit argv without a shell when argv is provided", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = runCommand("apt install -y nginx curl", {
      timeout: 5000,
      maxOutput: 50000,
      useShell: false,
      argv: ["apt", "install", "-y", "nginx", "curl"],
    });
    proc.emit("close", 0, null);
    await promise;

    expect(mockSpawn).toHaveBeenCalledWith(
      "apt",
      ["install", "-y", "nginx", "curl"],
      expect.any(Object)
    );
  });

  it("never spawns a shell with injected metacharacters via argv", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    // Even if a metacharacter-laden token slips into argv, it is passed as a
    // single literal argument — the OS never sees a shell.
    const promise = runCommand("systemctl status x; touch /tmp/PWNED", {
      timeout: 5000,
      maxOutput: 50000,
      useShell: false,
      argv: ["systemctl", "status", "x; touch /tmp/PWNED"],
    });
    proc.emit("close", 0, null);
    await promise;

    // Crucially, the OS sees "systemctl" with the metacharacter token as a
    // single literal argument — no "bash -c" wrapping that would interpret it.
    expect(mockSpawn).toHaveBeenCalledWith(
      "systemctl",
      ["status", "x; touch /tmp/PWNED"],
      expect.any(Object)
    );
    const lastCall = mockSpawn.mock.calls[mockSpawn.mock.calls.length - 1];
    expect(lastCall[0]).not.toBe("bash");
  });

  it("returns duration in ms", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc);

    const promise = runCommand("sleep 0.1", { timeout: 5000, maxOutput: 50000 });

    vi.advanceTimersByTime(50);
    proc.emit("close", 0, null);

    const result = await promise;
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });
});
