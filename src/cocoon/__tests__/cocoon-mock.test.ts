import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "http";
import { registerCocoonModels } from "../../agent/client.js";

// ── Mock Cocoon Proxy ────────────────────────────────────────────────

const MOCK_MODELS = [
  { id: "Qwen/Qwen3-32B", object: "model" },
  { id: "Qwen/Qwen3-8B", object: "model" },
];

let server: Server;
let port: number;
let socketAvailable = true;

function createMockCocoonProxy(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const srv = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        res.setHeader("Content-Type", "application/json");

        if (req.url === "/v1/models" && req.method === "GET") {
          res.end(JSON.stringify({ object: "list", data: MOCK_MODELS }));
          return;
        }

        if (req.url === "/v1/chat/completions" && req.method === "POST") {
          const payload = JSON.parse(body);

          const violations: string[] = [];
          if (payload.tools) violations.push("tools should be stripped");
          if (payload.tool_choice) violations.push("tool_choice should be stripped");
          if (payload.store) violations.push("store should be stripped");

          if (violations.length > 0) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: { message: violations.join(", ") } }));
            return;
          }

          const systemMsg = payload.messages?.find((m: { role: string }) => m.role === "system");
          const hasToolsInPrompt = systemMsg?.content?.includes("<tools>");

          if (hasToolsInPrompt) {
            res.end(
              JSON.stringify({
                id: "mock-1",
                object: "chat.completion",
                choices: [
                  {
                    index: 0,
                    message: {
                      role: "assistant",
                      content: `I'll search for that information.\n<tool_call>\n{"name": "web_search", "arguments": {"query": "test query"}}\n</tool_call>`,
                    },
                    finish_reason: "stop",
                  },
                ],
                usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
              })
            );
          } else {
            res.end(
              JSON.stringify({
                id: "mock-2",
                object: "chat.completion",
                choices: [
                  {
                    index: 0,
                    message: { role: "assistant", content: "Hello! How can I help you?" },
                    finish_reason: "stop",
                  },
                ],
                usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
              })
            );
          }
          return;
        }

        res.statusCode = 404;
        res.end(JSON.stringify({ error: { message: "Not found" } }));
      });
    });

    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const p = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server: srv, port: p });
    });
    srv.once("error", reject);
  });
}

// ── Tests ────────────────────────────────────────────────────────────

describe("Cocoon Mock Server", () => {
  beforeAll(async () => {
    try {
      const mock = await createMockCocoonProxy();
      server = mock.server;
      port = mock.port;
    } catch {
      socketAvailable = false;
    }
  });

  afterAll(
    () =>
      new Promise<void>((resolve) => {
        if (!server) {
          resolve();
          return;
        }
        server.close(() => resolve());
      })
  );

  // ── registerCocoonModels ─────────────────────────────────────────

  it("should discover models from /v1/models", async () => {
    if (!socketAvailable) return;
    const ids = await registerCocoonModels(port);
    expect(ids).toHaveLength(2);
    expect(ids).toContain("Qwen/Qwen3-32B");
    expect(ids).toContain("Qwen/Qwen3-8B");
  });

  it("should return empty array if proxy is down", async () => {
    const ids = await registerCocoonModels(59999);
    expect(ids).toEqual([]);
  });

  it("should return empty array if response has no models", async () => {
    if (!socketAvailable) return;
    const emptySrv = createServer((_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ object: "list", data: [] }));
    });
    await new Promise<void>((resolve, reject) => {
      emptySrv.once("error", reject);
      emptySrv.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = emptySrv.address();
    const emptyPort = typeof addr === "object" && addr ? addr.port : 0;

    const ids = await registerCocoonModels(emptyPort);
    expect(ids).toEqual([]);

    await new Promise<void>((resolve) => emptySrv.close(() => resolve()));
  });

  // ── Payload validation ───────────────────────────────────────────

  it("should reject requests with unsupported fields", async () => {
    if (!socketAvailable) return;
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "Qwen/Qwen3-32B",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ name: "bad" }],
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("tools should be stripped");
  });

  it("should accept clean cocoon payload", async () => {
    if (!socketAvailable) return;
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "Qwen/Qwen3-32B",
        messages: [{ role: "user", content: "hi" }],
        presence_penalty: 1.5,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { choices: { message: { content: string } }[] };
    expect(body.choices[0].message.content).toContain("Hello");
  });

  it("should return tool_call in response when tools in system prompt", async () => {
    if (!socketAvailable) return;
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "Qwen/Qwen3-32B",
        messages: [
          { role: "system", content: "You are helpful.\n<tools>\n[...]</tools>" },
          { role: "user", content: "search for cats" },
        ],
        presence_penalty: 1.5,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { choices: { message: { content: string } }[] };
    expect(body.choices[0].message.content).toContain("<tool_call>");
    expect(body.choices[0].message.content).toContain("web_search");
  });
});
