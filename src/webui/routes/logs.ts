import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { WebUIServerDeps } from "../types.js";
import { logInterceptor } from "../log-interceptor.js";

export function createLogsRoutes(_deps: WebUIServerDeps) {
  const app = new Hono();

  app.get("/stream", (c) => {
    return streamSSE(c, async (stream) => {
      let aborted = false;

      stream.onAbort(() => {
        aborted = true;
        if (cleanup) cleanup();
      });

      // Add listener for new log entries
      const cleanup = logInterceptor.addListener((entry) => {
        if (!aborted) {
          void stream.writeSSE({
            data: JSON.stringify(entry),
            event: "log",
          });
        }
      });

      // Send initial connection message
      await stream.writeSSE({
        data: JSON.stringify({
          level: "log",
          message: "🌐 WebUI log stream connected",
          timestamp: Date.now(),
        }),
        event: "log",
      });

      // Keep connection alive until client disconnects
      // Use a promise that only resolves on abort (no timer overflow)
      await new Promise<void>((resolve) => {
        if (aborted) return resolve();
        stream.onAbort(() => resolve());
      });

      if (cleanup) cleanup();
    });
  });

  return app;
}
