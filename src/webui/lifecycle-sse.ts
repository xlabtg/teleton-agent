import { streamSSE } from "hono/streaming";
import type { Context } from "hono";
import type { AgentLifecycle, StateChangeEvent } from "../agent/lifecycle.js";

/**
 * SSE stream of agent lifecycle state changes. Shared by the WebUI and API
 * servers (each keeps its own 503 guard for the missing-lifecycle case, with its
 * own error envelope, before calling this).
 */
export function createLifecycleSSE(c: Context, lifecycle: AgentLifecycle) {
  return streamSSE(c, async (stream) => {
    let aborted = false;
    let listening = false;

    const onStateChange = (event: StateChangeEvent) => {
      if (aborted) return;
      void stream
        .writeSSE({
          event: "status",
          id: String(event.timestamp),
          data: JSON.stringify({
            state: event.state,
            error: event.error ?? null,
            timestamp: event.timestamp,
          }),
        })
        .catch(() => {
          aborted = true;
          cleanup();
        });
    };

    function cleanup() {
      if (!listening) return;
      listening = false;
      lifecycle.off("stateChange", onStateChange);
    }

    stream.onAbort(() => {
      aborted = true;
      cleanup();
    });

    try {
      // Push current state immediately on connection
      const now = Date.now();
      await stream.writeSSE({
        event: "status",
        id: String(now),
        data: JSON.stringify({
          state: lifecycle.getState(),
          error: lifecycle.getError() ?? null,
          timestamp: now,
        }),
        retry: 3000,
      });

      if (aborted) return;

      lifecycle.on("stateChange", onStateChange);
      listening = true;

      // Heartbeat loop + keep connection alive
      while (!aborted) {
        await stream.sleep(30_000);
        if (aborted) break;
        await stream.writeSSE({
          event: "ping",
          data: "",
        });
      }
    } finally {
      cleanup();
    }
  });
}
