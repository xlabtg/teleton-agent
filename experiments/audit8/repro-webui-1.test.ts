import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { createSetupRoutes } from "../../src/webui/routes/setup.js";

describe("audit8 webui-1: setup server accepts cross-site simple POST", () => {
  it("runs handler for text/plain POST from foreign origin", async () => {
    const app = new Hono();
    app.use("*", cors({ origin: ["http://localhost:7777"], credentials: true }));
    app.route("/api/setup", createSetupRoutes());
    const res = await app.request("/api/setup/validate/api-key", {
      method: "POST",
      headers: { Origin: "https://evil.example", "Content-Type": "text/plain" },
      body: JSON.stringify({ provider: "anthropic", apiKey: "x" }),
    });
    const json = (await res.json()) as { success: boolean };
    expect(res.status).toBe(200);
    expect(json.success).toBe(true); // handler executed => state-changing routes reachable too
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});
