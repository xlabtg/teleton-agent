import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withTxLock } from "../tx-lock.js";

// ─── Tests ────────────────────────────────────────────────────────

describe("TxLock", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("withTxLock()", () => {
    it("should serialize concurrent calls (T2)", async () => {
      vi.useRealTimers(); // Need real timers for actual concurrency

      const executionLog: Array<{ id: number; phase: "start" | "end"; time: number }> = [];
      const DELAY_MS = 50;

      const makeTask = (id: number) => () =>
        withTxLock(async () => {
          executionLog.push({ id, phase: "start", time: Date.now() });
          await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
          executionLog.push({ id, phase: "end", time: Date.now() });
          return id;
        });

      // Launch 3 tasks concurrently
      const [r1, r2, r3] = await Promise.all([makeTask(1)(), makeTask(2)(), makeTask(3)()]);

      expect(r1).toBe(1);
      expect(r2).toBe(2);
      expect(r3).toBe(3);

      // Verify sequential execution: each task's start is after previous task's end
      const starts = executionLog
        .filter((e) => e.phase === "start")
        .sort((a, b) => a.time - b.time);
      const ends = executionLog.filter((e) => e.phase === "end").sort((a, b) => a.time - b.time);

      expect(starts).toHaveLength(3);
      expect(ends).toHaveLength(3);

      // Task 2 should start after task 1 ends
      expect(starts[1].time).toBeGreaterThanOrEqual(ends[0].time);
      // Task 3 should start after task 2 ends
      expect(starts[2].time).toBeGreaterThanOrEqual(ends[1].time);
    });

    it("should release lock on error so next call proceeds", async () => {
      vi.useRealTimers();

      const results: number[] = [];

      const failingTask = withTxLock(async () => {
        throw new Error("boom");
      });

      const succeedingTask = withTxLock(async () => {
        results.push(42);
        return 42;
      });

      await expect(failingTask).rejects.toThrow("boom");
      const value = await succeedingTask;

      expect(value).toBe(42);
      expect(results).toEqual([42]);
    });

    it("should return the value from the wrapped function", async () => {
      vi.useRealTimers();

      const result = await withTxLock(async () => "hello");
      expect(result).toBe("hello");
    });

    it("should propagate errors from the wrapped function", async () => {
      vi.useRealTimers();

      await expect(
        withTxLock(async () => {
          throw new Error("inner error");
        })
      ).rejects.toThrow("inner error");
    });

    it("should timeout after 60 seconds", async () => {
      // Use fake timers for timeout test
      let finish: (() => void) | undefined;
      const neverResolves = withTxLock(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          })
      );
      const rejection = expect(neverResolves).rejects.toThrow("TON tx-lock timeout (60s)");

      // Advance past the 60s timeout — async version resolves microtasks
      await vi.advanceTimersByTimeAsync(61_000);

      await rejection;
      finish?.();
    });

    it("should keep the lock until the timed-out function settles", async () => {
      let finishFirst: (() => void) | undefined;
      let secondStarted = false;

      const first = withTxLock(
        () =>
          new Promise<void>((resolve) => {
            finishFirst = resolve;
          })
      );
      const second = withTxLock(async () => {
        secondStarted = true;
      });
      const rejection = expect(first).rejects.toThrow("TON tx-lock timeout (60s)");

      await vi.advanceTimersByTimeAsync(60_000);

      await rejection;
      expect(secondStarted).toBe(false);

      finishFirst?.();
      await second;

      expect(secondStarted).toBe(true);
    });

    it("should release the lock when a timed-out function later rejects", async () => {
      let failFirst: ((error: Error) => void) | undefined;

      const first = withTxLock(
        () =>
          new Promise<void>((_, reject) => {
            failFirst = reject;
          })
      );
      const second = withTxLock(async () => "next");
      const timeout = expect(first).rejects.toThrow("TON tx-lock timeout (60s)");

      await vi.advanceTimersByTimeAsync(60_000);
      await timeout;

      failFirst?.(new Error("late failure"));

      await expect(second).resolves.toBe("next");
    });
  });
});
