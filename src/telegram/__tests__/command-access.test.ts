import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TelegramConfig } from "../../config/schema.js";
import type { AgentRuntime } from "../../agent/runtime.js";
import type { TelegramBridge } from "../bridge.js";
import { AdminHandler } from "../admin.js";

vi.mock("../../utils/logger.js", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
  isVerbose: vi.fn(() => false),
  setVerbose: vi.fn(),
}));

vi.mock("../../ton/wallet-service.js", () => ({
  getWalletAddress: vi.fn(() => null),
  getWalletBalance: vi.fn(() => null),
}));

vi.mock("../../workspace/manager.js", () => ({
  loadTemplate: vi.fn(() => "bootstrap content"),
}));

vi.mock("../../sdk/secrets.js", () => ({
  writePluginSecret: vi.fn(),
  deletePluginSecret: vi.fn(() => false),
  listPluginSecretKeys: vi.fn(() => []),
}));

vi.mock("../../deals/config.js", () => ({
  DEALS_CONFIG: {
    strategy: { buyMaxMultiplier: 0.95, sellMinMultiplier: 1.05 },
  },
}));

function makeConfig(overrides: Partial<TelegramConfig["command_access"]> = {}): TelegramConfig {
  return {
    api_id: 123,
    api_hash: "hash",
    phone: "+1234567890",
    session_name: "test",
    session_path: "~/.teleton",
    dm_policy: "allowlist",
    allow_from: [],
    group_policy: "open",
    group_allow_from: [],
    require_mention: false,
    max_message_length: 4096,
    typing_simulation: false,
    rate_limit_messages_per_second: 1,
    rate_limit_groups_per_minute: 20,
    admin_ids: [100],
    agent_channel: null,
    debounce_ms: 0,
    command_access: {
      commands_enabled: true,
      admin_only_commands: false,
      allowed_user_ids: [],
      allowed_chat_ids: [],
      unknown_command_reply: true,
      ...overrides,
    },
  } as TelegramConfig;
}

function makeHandler(
  configOverrides: Partial<TelegramConfig["command_access"]> = {}
): AdminHandler {
  const config = makeConfig(configOverrides);
  const bridge = {} as TelegramBridge;
  const agent = {
    getActiveChatIds: vi.fn(() => []),
    getConfig: vi.fn(() => ({
      agent: { provider: "anthropic", model: "claude-opus-4-6", max_agentic_iterations: 5 },
      tool_rag: { enabled: true, top_k: 25, always_include: [] },
    })),
    clearHistory: vi.fn(),
  } as unknown as AgentRuntime;
  return new AdminHandler(bridge, config, agent);
}

describe("privileged prompt access (#750)", () => {
  it.each(["boot", "task"])(
    "does not expose %s prompt to users allowed ordinary commands",
    (command) => {
      const handler = makeHandler({ admin_only_commands: false });
      expect(handler.isCommandAllowed(200, "42")).toBe(true);
      expect(handler.isPrivilegedCommandAllowed(command, 200)).toBe(false);
      expect(handler.isPrivilegedCommandAllowed(command, 100)).toBe(true);
    }
  );
});

// ── isCommandAllowed tests ─────────────────────────────────────────────

describe("AdminHandler.isCommandAllowed", () => {
  describe("admin always has access", () => {
    it("admin bypasses commands_enabled=false", () => {
      const h = makeHandler({ commands_enabled: false });
      expect(h.isCommandAllowed(100, "42")).toBe(true);
    });

    it("admin bypasses admin_only_commands=true", () => {
      const h = makeHandler({ admin_only_commands: true });
      expect(h.isCommandAllowed(100, "42")).toBe(true);
    });

    it("admin bypasses allowed_user_ids restriction", () => {
      const h = makeHandler({ allowed_user_ids: [999] });
      expect(h.isCommandAllowed(100, "42")).toBe(true);
    });

    it("admin bypasses allowed_chat_ids restriction", () => {
      const h = makeHandler({ allowed_chat_ids: [777] });
      expect(h.isCommandAllowed(100, "999")).toBe(true);
    });
  });

  describe("commands_enabled=false blocks non-admins", () => {
    it("blocks non-admin when commands disabled", () => {
      const h = makeHandler({ commands_enabled: false });
      expect(h.isCommandAllowed(200, "42")).toBe(false);
    });

    it("allows non-admin when commands enabled", () => {
      const h = makeHandler({ commands_enabled: true });
      expect(h.isCommandAllowed(200, "42")).toBe(true);
    });
  });

  describe("admin_only_commands blocks non-admins", () => {
    it("blocks non-admin when admin_only_commands=true", () => {
      const h = makeHandler({ admin_only_commands: true });
      expect(h.isCommandAllowed(200, "42")).toBe(false);
    });

    it("allows non-admin when admin_only_commands=false", () => {
      const h = makeHandler({ admin_only_commands: false });
      expect(h.isCommandAllowed(200, "42")).toBe(true);
    });
  });

  describe("allowed_user_ids restriction", () => {
    it("allows user in allowed_user_ids", () => {
      const h = makeHandler({ allowed_user_ids: [200, 300] });
      expect(h.isCommandAllowed(200, "42")).toBe(true);
    });

    it("blocks user not in allowed_user_ids when list is non-empty", () => {
      const h = makeHandler({ allowed_user_ids: [300] });
      expect(h.isCommandAllowed(200, "42")).toBe(false);
    });

    it("allows any user when allowed_user_ids is empty", () => {
      const h = makeHandler({ allowed_user_ids: [] });
      expect(h.isCommandAllowed(200, "42")).toBe(true);
    });
  });

  describe("allowed_chat_ids restriction", () => {
    it("allows chat in allowed_chat_ids", () => {
      const h = makeHandler({ allowed_chat_ids: [42, 99] });
      expect(h.isCommandAllowed(200, "42")).toBe(true);
    });

    it("blocks chat not in allowed_chat_ids when list is non-empty", () => {
      const h = makeHandler({ allowed_chat_ids: [99] });
      expect(h.isCommandAllowed(200, "42")).toBe(false);
    });

    it("allows any chat when allowed_chat_ids is empty", () => {
      const h = makeHandler({ allowed_chat_ids: [] });
      expect(h.isCommandAllowed(200, "42")).toBe(true);
    });
  });
});

// ── unknown_command_reply tests ────────────────────────────────────────

describe("AdminHandler.handleCommand — unknown_command_reply", () => {
  it("returns non-empty reply for unknown command when unknown_command_reply=true", async () => {
    const h = makeHandler({ unknown_command_reply: true });
    const result = await h.handleCommand(
      { command: "nonexistent", args: [], chatId: "1", senderId: 100 },
      "1",
      100
    );
    expect(result).toContain("Unknown command");
    expect(result).toContain("/help");
  });

  it("returns empty string for unknown command when unknown_command_reply=false", async () => {
    const h = makeHandler({ unknown_command_reply: false });
    const result = await h.handleCommand(
      { command: "nonexistent", args: [], chatId: "1", senderId: 100 },
      "1",
      100
    );
    expect(result).toBe("");
  });

  it("still returns response for known commands regardless of unknown_command_reply", async () => {
    const h = makeHandler({ unknown_command_reply: false });
    const result = await h.handleCommand(
      { command: "ping", args: [], chatId: "1", senderId: 100 },
      "1",
      100
    );
    expect(result).toBe("🏓 Pong!");
  });
});

// ── negative chat IDs (Telegram groups/channels) ───────────────────────

describe("AdminHandler.isCommandAllowed — negative chat IDs", () => {
  it("allows message from a negative chat ID when it is in allowed_chat_ids", () => {
    const h = makeHandler({ allowed_chat_ids: [-100123456] });
    expect(h.isCommandAllowed(200, "-100123456")).toBe(true);
  });

  it("blocks message from a negative chat ID not in allowed_chat_ids", () => {
    const h = makeHandler({ allowed_chat_ids: [-100999888] });
    expect(h.isCommandAllowed(200, "-100123456")).toBe(false);
  });
});

// ── hybrid mode (Mode 5): both lists non-empty → AND logic ────────────

describe("AdminHandler.isCommandAllowed — hybrid mode", () => {
  it("allows when user AND chat both match", () => {
    const h = makeHandler({ allowed_user_ids: [200], allowed_chat_ids: [42] });
    expect(h.isCommandAllowed(200, "42")).toBe(true);
  });

  it("blocks when user matches but chat does not", () => {
    const h = makeHandler({ allowed_user_ids: [200], allowed_chat_ids: [99] });
    expect(h.isCommandAllowed(200, "42")).toBe(false);
  });

  it("blocks when chat matches but user does not", () => {
    const h = makeHandler({ allowed_user_ids: [300], allowed_chat_ids: [42] });
    expect(h.isCommandAllowed(200, "42")).toBe(false);
  });

  it("blocks when neither user nor chat matches", () => {
    const h = makeHandler({ allowed_user_ids: [300], allowed_chat_ids: [99] });
    expect(h.isCommandAllowed(200, "42")).toBe(false);
  });
});

// ── /commands admin command ────────────────────────────────────────────

describe("AdminHandler.handleCommand — /commands", () => {
  it("shows current settings when no subcommand given", async () => {
    const h = makeHandler();
    const result = await h.handleCommand(
      { command: "commands", args: [], chatId: "1", senderId: 100 },
      "1",
      100
    );
    expect(result).toContain("Command Access Settings");
    expect(result).toContain("Commands enabled:");
  });

  it("enables commands", async () => {
    const h = makeHandler({ commands_enabled: false });
    const result = await h.handleCommand(
      { command: "commands", args: ["enable"], chatId: "1", senderId: 100 },
      "1",
      100
    );
    expect(result).toContain("enabled");
  });

  it("disables commands", async () => {
    const h = makeHandler({ commands_enabled: true });
    const result = await h.handleCommand(
      { command: "commands", args: ["disable"], chatId: "1", senderId: 100 },
      "1",
      100
    );
    expect(result).toContain("disabled");
  });

  it("sets admin_only on", async () => {
    const h = makeHandler({ admin_only_commands: false });
    const result = await h.handleCommand(
      { command: "commands", args: ["admin_only", "on"], chatId: "1", senderId: 100 },
      "1",
      100
    );
    expect(result).toContain("ON");
  });

  it("sets admin_only off", async () => {
    const h = makeHandler({ admin_only_commands: true });
    const result = await h.handleCommand(
      { command: "commands", args: ["admin_only", "off"], chatId: "1", senderId: 100 },
      "1",
      100
    );
    expect(result).toContain("OFF");
  });

  it("sets unknown_reply on", async () => {
    const h = makeHandler({ unknown_command_reply: false });
    const result = await h.handleCommand(
      { command: "commands", args: ["unknown_reply", "on"], chatId: "1", senderId: 100 },
      "1",
      100
    );
    expect(result).toContain("ON");
  });

  it("sets unknown_reply off", async () => {
    const h = makeHandler({ unknown_command_reply: true });
    const result = await h.handleCommand(
      { command: "commands", args: ["unknown_reply", "off"], chatId: "1", senderId: 100 },
      "1",
      100
    );
    expect(result).toContain("OFF");
  });

  it("adds user to allow_user list", async () => {
    const h = makeHandler({ allowed_user_ids: [] });
    const result = await h.handleCommand(
      { command: "commands", args: ["allow_user", "999"], chatId: "1", senderId: 100 },
      "1",
      100
    );
    expect(result).toContain("999");
    expect(result).toContain("added");
  });

  it("removes user from allow_user list", async () => {
    const h = makeHandler({ allowed_user_ids: [999] });
    const result = await h.handleCommand(
      { command: "commands", args: ["allow_user", "remove", "999"], chatId: "1", senderId: 100 },
      "1",
      100
    );
    expect(result).toContain("999");
    expect(result).toContain("removed");
  });

  it("adds negative chat ID to allow_chat list", async () => {
    const h = makeHandler({ allowed_chat_ids: [] });
    const result = await h.handleCommand(
      { command: "commands", args: ["allow_chat", "-100123456"], chatId: "1", senderId: 100 },
      "1",
      100
    );
    expect(result).toContain("-100123456");
    expect(result).toContain("added");
  });

  it("removes chat from allow_chat list", async () => {
    const h = makeHandler({ allowed_chat_ids: [-100123456] });
    const result = await h.handleCommand(
      {
        command: "commands",
        args: ["allow_chat", "remove", "-100123456"],
        chatId: "1",
        senderId: 100,
      },
      "1",
      100
    );
    expect(result).toContain("-100123456");
    expect(result).toContain("removed");
  });

  it("non-admin is denied", async () => {
    const h = makeHandler();
    const result = await h.handleCommand(
      { command: "commands", args: ["enable"], chatId: "1", senderId: 999 },
      "1",
      999
    );
    expect(result).toContain("Admin access required");
  });
});

describe("known commands and bot suffix (#747, #760)", () => {
  it.each(["...hi", "!question", ".NET", "/unrecognized"])(
    "passes normal text %s through",
    (text) => {
      expect(makeHandler().parseCommand(text)).toBeNull();
    }
  );
  it("accepts own bot suffix and ignores another bot", () => {
    const handler = makeHandler();
    expect(handler.parseCommand("/status@MyBot", "mybot")?.command).toBe("status");
    expect(handler.parseCommand("/status@other", "mybot")).toBeNull();
  });
});
