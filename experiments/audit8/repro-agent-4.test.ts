import { describe, expect, it, vi } from "vitest";
import { Type } from "@sinclair/typebox";
import { ToolRegistry } from "../../src/agent/tools/registry.js";

describe("audit8: registry 90s cap vs exec timeout", () => {
  it("abandons a still-running executor at 90s, below exec default 120s", async () => {
    vi.useFakeTimers();
    const reg = new ToolRegistry();
    let finished = false;
    reg.register(
      { name: "exec_run", description: "x", parameters: Type.Object({}) } as any,
      async () => {
        await new Promise((r) => setTimeout(r, 100_000));
        finished = true;
        return { success: true, data: "done" };
      }
    );
    const p = reg.execute({ type: "toolCall", id: "1", name: "exec_run", arguments: {} } as any, {
      senderId: 1, chatId: "c", isGroup: false, config: { telegram: { admin_ids: [1] } },
    } as any);
    await vi.advanceTimersByTimeAsync(90_001);
    const res = await p;
    console.log(JSON.stringify(res));
    expect(res.success).toBe(false);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(finished).toBe(true); // side effect completed after the agent was told it failed
    vi.useRealTimers();
  });
});
