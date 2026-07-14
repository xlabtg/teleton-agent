import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { ManagedAgentService } from "../service.js";
import { loadConfig } from "../../config/loader.js";

const PRIMARY_CONFIG = `
agent:
  api_key: sk-ant-api03-test123
  provider: anthropic
telegram:
  api_id: 12345
  api_hash: abcdef1234567890
  phone: "+1234567890"
webui:
  enabled: true
api:
  enabled: true
ton_proxy:
  enabled: true
  port: 8080
deals:
  enabled: true
`;

describe("ManagedAgentService", () => {
  let rootDir: string;
  let configPath: string;
  let service: ManagedAgentService | null = null;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "teleton-managed-agents-"));
    configPath = join(rootDir, "config.yaml");
    mkdirSync(join(rootDir, "workspace"), { recursive: true });
    mkdirSync(join(rootDir, "plugins", "example"), { recursive: true });
    writeFileSync(configPath, PRIMARY_CONFIG, "utf-8");
    writeFileSync(join(rootDir, "workspace", "SOUL.md"), "Primary soul", "utf-8");
    writeFileSync(join(rootDir, "workspace", "MEMORY.md"), "Primary memory", "utf-8");
    writeFileSync(join(rootDir, "plugins", "example", "index.js"), "export default {};\n", "utf-8");
  });

  afterEach(async () => {
    if (service) {
      await service.stopAll();
    }
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("requires explicit consent for new personal-mode managed agents", () => {
    service = new ManagedAgentService({ rootDir, primaryConfigPath: configPath });

    expect(() => service?.createAgent({ name: "Support Copy" })).toThrow(
      "Personal-mode managed agents require explicit private-account access consent"
    );
  });

  it("creates an isolated personal clone with rewritten paths and copied workspace assets", () => {
    service = new ManagedAgentService({ rootDir, primaryConfigPath: configPath });

    const snapshot = service.createAgent({
      name: "Support Copy",
      personalConnection: {
        apiId: 98765,
        apiHash: "managedhash123",
        phone: "+15551234567",
      },
      acknowledgePersonalAccountAccess: true,
    });
    const clonedConfig = loadConfig(snapshot.configPath);

    expect(snapshot.id).toBe("support-copy");
    expect(snapshot.mode).toBe("personal");
    expect(snapshot.memoryPolicy).toBe("isolated");
    expect(snapshot.hasPersonalCredentials).toBe(true);
    expect(snapshot.hasPersonalSession).toBe(false);
    expect(snapshot.personalPhoneMasked).toBe("+*********67");
    expect(snapshot.homePath).toBe(join(rootDir, "agents", "support-copy"));
    expect(existsSync(join(snapshot.workspacePath, "SOUL.md"))).toBe(true);
    expect(readFileSync(join(snapshot.workspacePath, "SOUL.md"), "utf-8")).toBe("Primary soul");
    expect(existsSync(join(snapshot.homePath, "plugins", "example", "index.js"))).toBe(true);
    expect(clonedConfig.telegram.session_path).toBe(
      join(rootDir, "agents", "support-copy", "telegram_session.txt")
    );
    expect(clonedConfig.storage.sessions_file).toBe(
      join(rootDir, "agents", "support-copy", "sessions.json")
    );
    expect(clonedConfig.storage.memory_file).toBe(
      join(rootDir, "agents", "support-copy", "memory.json")
    );
    expect(clonedConfig.telegram.api_id).toBe(98765);
    expect(clonedConfig.telegram.api_hash).toBe("managedhash123");
    expect(clonedConfig.telegram.phone).toBe("+15551234567");
    expect(clonedConfig.webui.enabled).toBe(false);
    expect(clonedConfig.api?.enabled).toBe(false);
    expect(clonedConfig.ton_proxy.enabled).toBe(false);
  });

  it("blocks personal-mode startup until the per-agent auth session is verified", () => {
    service = new ManagedAgentService({ rootDir, primaryConfigPath: configPath });

    const snapshot = service.createAgent({
      name: "Standalone Personal",
      mode: "personal",
      personalConnection: {
        apiId: 98765,
        apiHash: "managedhash123",
        phone: "+15551234567",
      },
      acknowledgePersonalAccountAccess: true,
    });

    expect(() => service?.startAgent(snapshot.id)).toThrow(
      "verified Telegram auth session before they can start"
    );
  });

  it("starts personal-mode managed agents after the isolated session exists", async () => {
    service = new ManagedAgentService({
      rootDir,
      primaryConfigPath: configPath,
      resolveCommand: () => ({
        command: process.execPath,
        args: [
          "-e",
          [
            "console.log('managed-mode=' + process.env.TELETON_MANAGED_AGENT_MODE);",
            "console.log('Teleton Agent is running!');",
            "setTimeout(() => process.exit(0), 5000);",
          ].join(" "),
        ],
      }),
    });

    const snapshot = service.createAgent({
      name: "Standalone Personal",
      mode: "personal",
      personalConnection: {
        apiId: 98765,
        apiHash: "managedhash123",
        phone: "+15551234567",
      },
      acknowledgePersonalAccountAccess: true,
    });
    const authTarget = service.resolvePersonalAuthTarget(snapshot.id);
    writeFileSync(authTarget.sessionPath, "session-string", "utf-8");
    service.recordPersonalAuth(snapshot.id);

    service.startAgent(snapshot.id);
    await new Promise((resolve) => setTimeout(resolve, 150));

    const logs = service.readLogs(snapshot.id, 20).lines.join("\n");
    expect(logs).toContain("managed-mode=personal");
    expect(service.getRuntimeStatus(snapshot.id).transport).toBe("mtproto");
  });

  it("invalidates the isolated personal session when credentials are updated", () => {
    service = new ManagedAgentService({ rootDir, primaryConfigPath: configPath });

    const snapshot = service.createAgent({
      name: "Standalone Personal",
      mode: "personal",
      personalConnection: {
        apiId: 98765,
        apiHash: "managedhash123",
        phone: "+15551234567",
      },
      acknowledgePersonalAccountAccess: true,
    });
    const authTarget = service.resolvePersonalAuthTarget(snapshot.id);
    writeFileSync(authTarget.sessionPath, "session-string", "utf-8");
    service.recordPersonalAuth(snapshot.id);

    expect(service.getAgentSnapshot(snapshot.id).hasPersonalSession).toBe(true);

    const updated = service.updateAgent(snapshot.id, {
      personalConnection: { phone: "+15557654321" },
    });
    const updatedConfig = loadConfig(updated.configPath);

    expect(updated.hasPersonalSession).toBe(false);
    expect(existsSync(authTarget.sessionPath)).toBe(false);
    expect(updatedConfig.telegram.phone).toBe("+15557654321");
    expect(updatedConfig.telegram.owner_id).toBeUndefined();
    expect(updatedConfig.telegram.admin_ids).toEqual([]);
    expect(() => service?.startAgent(snapshot.id)).toThrow(
      "verified Telegram auth session before they can start"
    );
  });

  it("invalidates the isolated personal session when auth starts with new credentials", () => {
    service = new ManagedAgentService({ rootDir, primaryConfigPath: configPath });

    const snapshot = service.createAgent({
      name: "Standalone Personal",
      mode: "personal",
      personalConnection: {
        apiId: 98765,
        apiHash: "managedhash123",
        phone: "+15551234567",
      },
      acknowledgePersonalAccountAccess: true,
    });
    const initialAuthTarget = service.resolvePersonalAuthTarget(snapshot.id);
    writeFileSync(initialAuthTarget.sessionPath, "session-string", "utf-8");
    service.recordPersonalAuth(snapshot.id);

    const nextAuthTarget = service.resolvePersonalAuthTarget(snapshot.id, {
      apiHash: "newmanagedhash456",
    });
    const updatedConfig = loadConfig(snapshot.configPath);

    expect(nextAuthTarget.apiHash).toBe("newmanagedhash456");
    expect(existsSync(initialAuthTarget.sessionPath)).toBe(false);
    expect(updatedConfig.telegram.owner_id).toBeUndefined();
    expect(service.getAgentSnapshot(snapshot.id).hasPersonalSession).toBe(false);
  });

  it("returns configured MTProto proxies for managed personal authentication", () => {
    writeFileSync(
      configPath,
      `${PRIMARY_CONFIG}
mtproto:
  enabled: true
  proxies:
    - server: proxy1.example.com
      port: 443
      secret: ${"a".repeat(32)}
`,
      "utf-8"
    );
    service = new ManagedAgentService({ rootDir, primaryConfigPath: configPath });

    const snapshot = service.createAgent({
      name: "Proxy Personal",
      mode: "personal",
      personalConnection: {
        apiId: 98765,
        apiHash: "managedhash123",
        phone: "+15551234567",
      },
      acknowledgePersonalAccountAccess: true,
    });

    const authTarget = service.resolvePersonalAuthTarget(snapshot.id);

    expect(authTarget.mtprotoProxies).toEqual([
      {
        server: "proxy1.example.com",
        port: 443,
        secret: "a".repeat(32),
      },
    ]);
  });

  it("allocates unique ids when the same name is cloned twice", () => {
    service = new ManagedAgentService({ rootDir, primaryConfigPath: configPath });

    const first = service.createAgent({
      name: "Trading Desk",
      acknowledgePersonalAccountAccess: true,
    });
    const second = service.createAgent({
      name: "Trading Desk",
      acknowledgePersonalAccountAccess: true,
    });

    expect(first.id).toBe("trading-desk");
    expect(second.id).toBe("trading-desk-2");
    expect(service.listAgentSnapshots().map((agent) => agent.id)).toEqual([
      "trading-desk",
      "trading-desk-2",
    ]);
  });

  it("persists the requested mode and inherits it on clone", () => {
    service = new ManagedAgentService({ rootDir, primaryConfigPath: configPath });

    const bot = service.createAgent({
      name: "FAQ Bot",
      mode: "bot",
      botToken: "123456:ABCDEF",
      botUsername: "faq_bot",
    });
    const clone = service.createAgent({ name: "FAQ Bot Copy", cloneFromId: bot.id });

    expect(bot.mode).toBe("bot");
    expect(bot.connection.botUsername).toBe("faq_bot");
    expect(clone.mode).toBe("bot");
  });

  it("starts bot-mode managed agents with explicit bot runtime env", async () => {
    service = new ManagedAgentService({
      rootDir,
      primaryConfigPath: configPath,
      resolveCommand: () => ({
        command: process.execPath,
        args: [
          "-e",
          [
            "console.log('managed-mode=' + process.env.TELETON_MANAGED_AGENT_MODE);",
            "console.log('bot-token-env=' + Boolean(process.env.TELETON_TG_BOT_TOKEN));",
            "console.log('Teleton Agent is running!');",
            "setTimeout(() => process.exit(0), 5000);",
          ].join(" "),
        ],
      }),
    });

    const snapshot = service.createAgent({
      name: "FAQ Bot",
      mode: "bot",
      botToken: "123456:ABCDEF",
      botUsername: "faq_bot",
    });
    const savedConfig = loadConfig(snapshot.configPath);

    expect(savedConfig.telegram.bot_token).toBeUndefined();
    expect(savedConfig.deals.enabled).toBe(false);
    expect(readFileSync(join(snapshot.homePath, "credentials.json"), "utf-8")).not.toContain(
      "123456:ABCDEF"
    );

    service.startAgent(snapshot.id);
    await new Promise((resolve) => setTimeout(resolve, 150));

    const logs = service.readLogs(snapshot.id, 20).lines.join("\n");
    expect(logs).toContain("managed-mode=bot");
    expect(logs).toContain("bot-token-env=true");
    expect(service.getRuntimeStatus(snapshot.id).transport).toBe("bot-api");
  });

  it("rejects malformed bot tokens before creating bot-mode agents", () => {
    service = new ManagedAgentService({ rootDir, primaryConfigPath: configPath });

    expect(() =>
      service?.createAgent({
        name: "FAQ Bot",
        mode: "bot",
        botToken: "not-a-token",
      })
    ).toThrow("Invalid bot token");
  });

  it("does not mark child processes running before they report readiness", async () => {
    service = new ManagedAgentService({
      rootDir,
      primaryConfigPath: configPath,
      resolveCommand: () => ({
        command: process.execPath,
        args: [
          "-e",
          [
            "console.log('spawned-without-readiness');",
            "setTimeout(() => process.exit(0), 5000);",
          ].join(" "),
        ],
      }),
    });

    const snapshot = service.createAgent({
      name: "Slow Bot",
      mode: "bot",
      botToken: "123456:ABCDEF",
    });

    service.startAgent(snapshot.id);
    await new Promise((resolve) => setTimeout(resolve, 2_200));

    expect(service.getRuntimeStatus(snapshot.id).state).toBe("starting");
  });

  it("blocks non-isolated memory policies from starting", () => {
    service = new ManagedAgentService({ rootDir, primaryConfigPath: configPath });

    const snapshot = service.createAgent({
      name: "Research Bot",
      mode: "bot",
      botToken: "123456:ABCDEF",
      memoryPolicy: "shared-read",
    });

    expect(() => service?.startAgent(snapshot.id)).toThrow('only "isolated" is startable today');
  });

  it("stores inter-agent inbox messages and enforces sender rate limits", () => {
    service = new ManagedAgentService({ rootDir, primaryConfigPath: configPath });

    const sender = service.createAgent({
      name: "Planner",
      acknowledgePersonalAccountAccess: true,
      messaging: { enabled: true, maxMessagesPerMinute: 1 },
    });
    const target = service.createAgent({
      name: "Executor",
      acknowledgePersonalAccountAccess: true,
      messaging: { enabled: true, allowlist: [sender.id] },
    });

    const first = service.sendMessage(sender.id, target.id, "First task");
    expect(first.fromId).toBe(sender.id);
    expect(service.readMessages(target.id).messages).toHaveLength(1);

    expect(() => service?.sendMessage(sender.id, target.id, "Second task")).toThrow(
      "exceeded its inter-agent message rate limit"
    );
    expect(() => service?.sendMessage("primary", target.id, "Blocked")).toThrow(
      `Managed agent "primary" is not allowed to message "${target.id}"`
    );
  });

  it("records and waits for inter-agent message results", async () => {
    service = new ManagedAgentService({ rootDir, primaryConfigPath: configPath });

    const sender = service.createAgent({
      name: "Planner",
      acknowledgePersonalAccountAccess: true,
      messaging: { enabled: true },
    });
    const target = service.createAgent({
      name: "Executor",
      acknowledgePersonalAccountAccess: true,
      messaging: { enabled: true, allowlist: [sender.id] },
    });

    const message = service.sendMessage(sender.id, target.id, "First task");
    const pendingResult = service.waitForMessageResult(message.id, {
      agentId: target.id,
      timeoutSeconds: 1,
      pollIntervalMs: 10,
    });
    const recorded = service.recordMessageResult(target.id, message.id, {
      content: "finished task",
    });

    await expect(pendingResult).resolves.toMatchObject({
      messageId: message.id,
      fromId: target.id,
      toId: sender.id,
      status: "completed",
      content: "finished task",
      error: null,
    });
    expect(service.readMessageResult(target.id, message.id)).toEqual(recorded);
  });

  it("bounds persisted inter-agent messages and results", () => {
    service = new ManagedAgentService({ rootDir, primaryConfigPath: configPath });

    const sender = service.createAgent({
      name: "Planner",
      acknowledgePersonalAccountAccess: true,
      messaging: { enabled: true, maxMessagesPerMinute: 2_000 },
    });
    const target = service.createAgent({
      name: "Executor",
      acknowledgePersonalAccountAccess: true,
      messaging: { enabled: true, allowlist: [sender.id] },
    });

    const messages = [];
    for (let index = 0; index < 1_001; index += 1) {
      const message = service.sendMessage(sender.id, target.id, `Task ${index}`);
      messages.push(message);
      service.recordMessageResult(target.id, message.id, { content: "done" });
    }

    const persistedMessages = JSON.parse(
      readFileSync(join(target.homePath, "messages", "inbox.json"), "utf-8")
    ) as Array<{ id: string }>;
    const persistedResults = JSON.parse(
      readFileSync(join(target.homePath, "messages", "results.json"), "utf-8")
    ) as Array<{ messageId: string }>;

    expect(persistedMessages).toHaveLength(1_000);
    expect(persistedResults).toHaveLength(1_000);
    expect(persistedMessages[0]?.id).toBe(messages[1]?.id);
    expect(persistedResults[0]?.messageId).toBe(messages[1]?.id);
    expect(persistedMessages.at(-1)?.id).toBe(messages.at(-1)?.id);
    expect(persistedResults.at(-1)?.messageId).toBe(messages.at(-1)?.id);
  });

  it("exposes built-in archetypes and creates registry entries from them", () => {
    service = new ManagedAgentService({ rootDir, primaryConfigPath: configPath });

    const archetypes = service.listArchetypes();
    expect(archetypes.map((archetype) => archetype.type)).toEqual([
      "ResearchAgent",
      "CodeAgent",
      "ContentAgent",
      "OrchestratorAgent",
      "MonitorAgent",
    ]);

    const snapshot = service.createAgent({
      name: "Research Desk",
      type: "ResearchAgent",
      personalConnection: {
        apiId: 98765,
        apiHash: "managedhash123",
        phone: "+15551234567",
      },
      acknowledgePersonalAccountAccess: true,
    });
    const clonedConfig = loadConfig(snapshot.configPath);
    const soul = readFileSync(join(snapshot.workspacePath, "SOUL.md"), "utf-8");

    expect(snapshot.type).toBe("ResearchAgent");
    expect(snapshot.description).toContain("Research");
    expect(snapshot.tools).toContain("web_search");
    expect(snapshot.config.maxToolCallsPerTurn).toBe(8);
    expect(clonedConfig.agent.system_prompt).toContain("research agent");
    expect(clonedConfig.agent.max_agentic_iterations).toBe(8);
    expect(soul).toContain("research agent");
  });

  it("stores custom registry config and applies LLM overrides", () => {
    service = new ManagedAgentService({ rootDir, primaryConfigPath: configPath });

    const snapshot = service.createAgent({
      name: "Briefing Writer",
      type: "CustomAgent",
      description: "Writes concise stakeholder briefings",
      tools: ["memory_search", "telegram_send_message"],
      soulTemplate: "You are a briefing agent. Keep updates concise.",
      config: {
        provider: "openai",
        model: "gpt-5",
        temperature: 0.2,
        maxTokens: 2048,
        maxToolCallsPerTurn: 3,
        hookRules: ["beforeSend:require-citations"],
      },
      personalConnection: {
        apiId: 98765,
        apiHash: "managedhash123",
        phone: "+15551234567",
      },
      acknowledgePersonalAccountAccess: true,
    });
    const clonedConfig = loadConfig(snapshot.configPath);

    expect(snapshot.description).toBe("Writes concise stakeholder briefings");
    expect(snapshot.tools).toEqual(["memory_search", "telegram_send_message"]);
    expect(snapshot.config.hookRules).toEqual(["beforeSend:require-citations"]);
    expect(clonedConfig.agent.provider).toBe("openai");
    expect(clonedConfig.agent.model).toBe("gpt-5");
    expect(clonedConfig.agent.temperature).toBe(0.2);
    expect(clonedConfig.agent.max_tokens).toBe(2048);
    expect(clonedConfig.agent.max_agentic_iterations).toBe(3);
    expect(clonedConfig.agent.system_prompt).toBe(
      "You are a briefing agent. Keep updates concise."
    );
  });
});
