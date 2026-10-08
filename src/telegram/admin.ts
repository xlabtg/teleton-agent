import type { TelegramConfig } from "../config/schema.js";
import type { AgentRuntime } from "../agent/runtime.js";
import type { ITelegramBridge } from "./bridge-interface.js";
import { getWalletAddress, getWalletBalance, clearKeyPair } from "../ton/wallet-service.js";
import { Address } from "@ton/core";
import { DEALS_CONFIG } from "../deals/config.js";
import { loadTemplate } from "../workspace/manager.js";
import { isVerbose, setVerbose, createLogger } from "../utils/logger.js";

const log = createLogger("Telegram");
import type { ModulePermissions, ModuleLevel } from "../agent/tools/module-permissions.js";
import type { ToolRegistry } from "../agent/tools/registry.js";
import { writePluginSecret, deletePluginSecret, listPluginSecretKeys } from "../sdk/secrets.js";
import { readRawConfig, writeRawConfig, setNestedValue } from "../config/configurable-keys.js";
import { getErrorMessage } from "../utils/errors.js";

export interface AdminCommand {
  command: string;
  args: string[];
  chatId: string;
  senderId: number;
}

const VALID_DM_POLICIES = ["open", "allowlist", "admin-only", "disabled"] as const;
const VALID_GROUP_POLICIES = ["open", "allowlist", "admin-only", "disabled"] as const;
const VALID_MODULE_LEVELS = ["open", "admin", "disabled"] as const;

export class AdminHandler {
  private bridge: ITelegramBridge;
  private config: TelegramConfig;
  private agent: AgentRuntime;
  private paused = false;
  private permissions: ModulePermissions | null;
  private registry: ToolRegistry | null;
  private configPath: string;

  constructor(
    bridge: ITelegramBridge,
    config: TelegramConfig,
    agent: AgentRuntime,
    configPath: string,
    permissions?: ModulePermissions,
    registry?: ToolRegistry
  ) {
    this.bridge = bridge;
    this.config = config;
    this.agent = agent;
    this.configPath = configPath;
    this.permissions = permissions ?? null;
    this.registry = registry ?? null;
  }

  isAdmin(userId: number): boolean {
    return this.config.admin_ids.includes(userId);
  }

  /**
   * Check whether a user/chat is permitted to run commands, according to
   * telegram.command_access settings.  Admins always bypass all restrictions.
   */
  isCommandAllowed(userId: number, chatId: string): boolean {
    // Admins always have access
    if (this.isAdmin(userId)) return true;

    const ca = this.config.command_access;

    // Global kill-switch
    if (!ca.commands_enabled) return false;

    // Admin-only mode
    if (ca.admin_only_commands) return false;

    // User allowlist (non-empty means restrict to listed users)
    if (ca.allowed_user_ids.length > 0 && !ca.allowed_user_ids.includes(userId)) return false;

    // Chat allowlist (non-empty means restrict to listed chats)
    const numericChatId = Number(chatId);
    if (
      ca.allowed_chat_ids.length > 0 &&
      !isNaN(numericChatId) &&
      !ca.allowed_chat_ids.includes(numericChatId)
    )
      return false;

    return true;
  }

  isPrivilegedCommandAllowed(command: string, userId: number): boolean {
    return !["boot", "task"].includes(command) || this.isAdmin(userId);
  }

  isPaused(): boolean {
    return this.paused;
  }

  parseCommand(message: string, botUsername = this.bridge.getUsername?.()): AdminCommand | null {
    const match = message.trim().match(/^[/!.]([a-z][a-z0-9_]*)(?:@([a-z0-9_]+))?(?:\s|$)/i);
    if (!match) return null;
    if (match[2] && match[2].toLowerCase() !== botUsername?.toLowerCase()) return null;
    const command = match[1].toLowerCase();
    const known = new Set([
      "status",
      "clear",
      "loop",
      "model",
      "policy",
      "pause",
      "resume",
      "wallet",
      "strategy",
      "stop",
      "verbose",
      "rag",
      "guest",
      "modules",
      "plugin",
      "help",
      "commands",
      "ping",
      "boot",
      "task",
    ]);
    if (!known.has(command)) return null;
    return { command, args: message.trim().split(/\s+/).slice(1), chatId: "", senderId: 0 };
  }

  async handleCommand(
    command: AdminCommand,
    chatId: string,
    senderId: number,
    isGroup?: boolean
  ): Promise<string> {
    if (!this.isAdmin(senderId)) {
      return "⛔ Admin access required";
    }

    command.chatId = chatId;
    command.senderId = senderId;

    switch (command.command) {
      case "status":
        return await this.handleStatusCommand(command);
      case "clear":
        return await this.handleClearCommand(command);
      case "loop":
        return this.handleLoopCommand(command);
      case "model":
        return this.handleModelCommand(command);
      case "policy":
        return this.handlePolicyCommand(command);
      case "pause":
        return this.handlePauseCommand();
      case "resume":
        return this.handleResumeCommand();
      case "wallet":
        return await this.handleWalletCommand();
      case "strategy":
        return this.handleStrategyCommand(command);
      case "stop":
        return await this.handleStopCommand();
      case "verbose":
        return this.handleVerboseCommand();
      case "rag":
        return this.handleRagCommand(command);
      case "guest":
        return this.handleGuestCommand(command);
      case "modules":
        return this.handleModulesCommand(command, isGroup ?? false);
      case "plugin":
        return this.handlePluginCommand(command);
      case "help":
        return this.handleHelpCommand();
      case "commands":
        return this.handleCommandsCommand(command);
      case "ping":
        return "🏓 Pong!";
      default:
        if (this.config.command_access.unknown_command_reply) {
          return `❓ Unknown command: /${command.command}\n\nUse /help for available commands.`;
        }
        return "";
    }
  }

  private async handleStatusCommand(_command: AdminCommand): Promise<string> {
    const activeChatIds = this.agent.getActiveChatIds();
    const chatCount = activeChatIds.length;
    const cfg = this.agent.getConfig();

    let status = "🤖 **Teleton Status**\n\n";
    status += `${this.paused ? "⏸️ **PAUSED**\n" : ""}`;
    status += `💬 Active conversations: ${chatCount}\n`;
    status += `🧠 Provider: ${cfg.agent.provider}\n`;
    status += `🤖 Model: ${cfg.agent.model}\n`;
    status += `🔄 Max iterations: ${cfg.agent.max_agentic_iterations}\n`;
    status += `📬 DM policy: ${this.config.dm_policy}\n`;
    status += `👥 Group policy: ${this.config.group_policy}\n`;

    if (this.config.require_mention) {
      status += `🔔 Mention required: Yes\n`;
    }

    return status;
  }

  private async handleClearCommand(command: AdminCommand): Promise<string> {
    const targetChatId = command.args[0] || command.chatId;

    try {
      this.agent.clearHistory(targetChatId);
      return `✅ Cleared conversation history for chat: ${targetChatId}`;
    } catch (error) {
      return `❌ Error clearing history: ${error}`;
    }
  }

  private handleLoopCommand(command: AdminCommand): string {
    const n = parseInt(command.args[0], 10);
    if (isNaN(n) || n < 1 || n > 50) {
      const current = this.agent.getConfig().agent.max_agentic_iterations || 5;
      return `🔄 Current loop: **${current}** iterations\n\nUsage: /loop <1-50>`;
    }
    this.agent.getConfig().agent.max_agentic_iterations = n;
    return `🔄 Max iterations set to **${n}**`;
  }

  private handleModelCommand(command: AdminCommand): string {
    const cfg = this.agent.getConfig();
    if (command.args.length === 0) {
      return `🧠 Current model: **${cfg.agent.model}**\n\nUsage: /model <model_name>`;
    }
    const newModel = command.args[0];
    const oldModel = cfg.agent.model;
    cfg.agent.model = newModel;
    return `🧠 Model: **${oldModel}** → **${newModel}**`;
  }

  private handlePolicyCommand(command: AdminCommand): string {
    if (command.args.length < 2) {
      return (
        `📬 DM policy: **${this.config.dm_policy}**\n` +
        `👥 Group policy: **${this.config.group_policy}**\n\n` +
        `Usage:\n/policy dm <${VALID_DM_POLICIES.join("|")}>\n/policy group <${VALID_GROUP_POLICIES.join("|")}>`
      );
    }

    const [target, value] = command.args;

    if (target === "dm") {
      if (!(VALID_DM_POLICIES as readonly string[]).includes(value)) {
        return `❌ Invalid DM policy. Valid: ${VALID_DM_POLICIES.join(", ")}`;
      }
      const old = this.config.dm_policy;
      this.config.dm_policy = value as typeof this.config.dm_policy;
      return `📬 DM policy: **${old}** → **${value}**`;
    }

    if (target === "group") {
      if (!(VALID_GROUP_POLICIES as readonly string[]).includes(value)) {
        return `❌ Invalid group policy. Valid: ${VALID_GROUP_POLICIES.join(", ")}`;
      }
      const old = this.config.group_policy;
      this.config.group_policy = value as typeof this.config.group_policy;
      return `👥 Group policy: **${old}** → **${value}**`;
    }

    return `❌ Unknown target: ${target}. Use "dm" or "group".`;
  }

  private handlePauseCommand(): string {
    if (this.paused) return "⏸️ Already paused.";
    this.paused = true;
    clearKeyPair();
    return "⏸️ Agent paused. Use /resume to restart.";
  }

  private handleResumeCommand(): string {
    if (!this.paused) return "▶️ Already running.";
    this.paused = false;
    return "▶️ Agent resumed.";
  }

  private handleStrategyCommand(command: AdminCommand): string {
    if (command.args.length === 0) {
      const buy = Math.round(DEALS_CONFIG.strategy.buyMaxMultiplier * 100);
      const sell = Math.round(DEALS_CONFIG.strategy.sellMinMultiplier * 100);
      return (
        `📊 **Trading Strategy**\n\n` +
        `Buy: max **${buy}%** of floor\n` +
        `Sell: min **${sell}%** of floor\n\n` +
        `Usage:\n/strategy buy <percent>\n/strategy sell <percent>`
      );
    }

    const [target, valueStr] = command.args;
    const value = parseInt(valueStr, 10);

    if (target === "buy") {
      if (isNaN(value) || value < 50 || value > 150) {
        return "❌ Buy threshold must be between 50 and 150";
      }
      const old = Math.round(DEALS_CONFIG.strategy.buyMaxMultiplier * 100);
      DEALS_CONFIG.strategy.buyMaxMultiplier = value / 100;
      return `📊 Buy threshold: **${old}%** → **${value}%** of floor`;
    }

    if (target === "sell") {
      if (isNaN(value) || value < 100 || value > 200) {
        return "❌ Sell threshold must be between 100 and 200";
      }
      const old = Math.round(DEALS_CONFIG.strategy.sellMinMultiplier * 100);
      DEALS_CONFIG.strategy.sellMinMultiplier = value / 100;
      return `📊 Sell threshold: **${old}%** → **${value}%** of floor`;
    }

    return `❌ Unknown target: ${target}. Use "buy" or "sell".`;
  }

  private async handleStopCommand(): Promise<string> {
    log.info("🛑 [Admin] /stop command received - shutting down");
    setTimeout(() => process.kill(process.pid, "SIGTERM"), 1000);
    return "🛑 Shutting down...";
  }

  private async handleWalletCommand(): Promise<string> {
    const address = getWalletAddress();
    if (!address) return "❌ No wallet configured.";

    const result = await getWalletBalance(address);
    if (!result) return "❌ Failed to fetch balance.";

    const friendly = Address.parse(address).toString({ bounceable: false });
    return `💎 **${result.balance} TON**\n📍 \`${friendly}\``;
  }

  getBootstrapContent(): string | null {
    try {
      return loadTemplate("BOOTSTRAP.md");
    } catch {
      return null;
    }
  }

  private handleVerboseCommand(): string {
    const next = !isVerbose();
    setVerbose(next);
    return next ? "🔊 Verbose logging **ON**" : "🔇 Verbose logging **OFF**";
  }

  private handleRagCommand(command: AdminCommand): string {
    const cfg = this.agent.getConfig();
    const sub = command.args[0]?.toLowerCase();

    if (sub === "status") {
      const enabled = cfg.tool_rag.enabled;
      const topK = cfg.tool_rag.top_k;
      const toolIndex = this.registry?.getToolIndex();
      const indexed = toolIndex?.isIndexed ? "Yes" : "No";
      const totalTools = this.registry?.enabledCount ?? 0;
      return (
        `🔍 **Tool RAG Status**\n\n` +
        `Enabled: ${enabled ? "✅ ON" : "❌ OFF"}\n` +
        `Indexed: ${indexed}\n` +
        `Top-K: ${topK}\n` +
        `Active tools: ${totalTools}\n` +
        `Always include: ${cfg.tool_rag.always_include.length} patterns`
      );
    }

    if (sub === "topk") {
      const n = parseInt(command.args[1], 10);
      if (isNaN(n) || n < 5 || n > 200) {
        return `🔍 Current top_k: **${cfg.tool_rag.top_k}**\n\nUsage: /rag topk <5-200>`;
      }
      const old = cfg.tool_rag.top_k;
      cfg.tool_rag.top_k = n;
      return `🔍 Tool RAG top_k: **${old}** → **${n}**`;
    }

    // Toggle ON/OFF
    const next = !cfg.tool_rag.enabled;
    cfg.tool_rag.enabled = next;
    return next ? "🔍 Tool RAG **ON**" : "🔇 Tool RAG **OFF**";
  }

  private handleGuestCommand(command: AdminCommand): string {
    const cfg = this.agent.getConfig();
    const sub = command.args[0]?.toLowerCase();
    if (sub !== "on" && sub !== "off") {
      const state = cfg.telegram.guest_mode ? "ON" : "OFF";
      return `👤 Guest mode: **${state}**\n\nUsage: /guest on|off`;
    }
    const enabled = sub === "on";
    try {
      const raw = readRawConfig(this.configPath);
      setNestedValue(raw, "telegram.guest_mode", enabled);
      writeRawConfig(raw, this.configPath);
    } catch (error) {
      return `❌ Error saving config: ${getErrorMessage(error)}`;
    }
    cfg.telegram.guest_mode = enabled;
    return enabled ? "👤 Guest mode **ON**" : "👤 Guest mode **OFF**";
  }

  private handleModulesCommand(command: AdminCommand, isGroup: boolean): string {
    if (!this.permissions || !this.registry) {
      return "❌ Module permissions not available";
    }

    if (!isGroup) {
      return "❌ /modules is only available in groups";
    }

    const chatId = command.chatId;
    const sub = command.args[0]?.toLowerCase();

    if (!sub) {
      return this.listModules(chatId);
    }

    switch (sub) {
      case "set":
        return this.setModuleLevel(chatId, command.args[1], command.args[2], command.senderId);
      case "info":
        return this.showModuleInfo(command.args[1], chatId);
      case "reset":
        return this.resetModules(chatId, command.args[1]);
      default:
        return `❌ Unknown subcommand: "${sub}"\n\nUsage: /modules | /modules set <module> <level> | /modules info <module> | /modules reset [module]`;
    }
  }

  private listModules(chatId: string): string {
    if (!this.registry || !this.permissions) return "❌ Module permissions not available";
    const modules = this.registry.getAvailableModules();
    const overrides = this.permissions.getOverrides(chatId);

    const lines: string[] = ["🧩 **Modules** (this group)\n"];

    for (const mod of modules) {
      const count = this.registry.getModuleToolCount(mod);
      const level = overrides.get(mod) ?? "open";
      const isProtected = this.permissions.isProtected(mod);

      let icon: string;
      switch (level) {
        case "open":
          icon = "✅";
          break;
        case "admin":
          icon = "🔐";
          break;
        case "disabled":
          icon = "❌";
          break;
      }

      const toolWord = count === 1 ? "tool" : "tools";
      const protectedMark = isProtected ? " 🔒" : "";
      lines.push(` ${icon} **${mod}**   ${count} ${toolWord}  ${level}${protectedMark}`);
    }

    lines.push("");
    lines.push("Levels: `open` | `admin` | `disabled`");
    lines.push("Usage: `/modules set <module> <level>`");

    return lines.join("\n");
  }

  private setModuleLevel(
    chatId: string,
    module: string | undefined,
    level: string | undefined,
    senderId: number
  ): string {
    if (!module || !level) {
      return "❌ Usage: /modules set <module> <level>";
    }

    module = module.toLowerCase();
    level = level.toLowerCase();

    if (!this.registry || !this.permissions) return "❌ Module permissions not available";
    const available = this.registry.getAvailableModules();
    if (!available.includes(module)) {
      return `❌ Unknown module: "${module}"`;
    }

    if (this.permissions.isProtected(module)) {
      return `⛔ Module "${module}" is protected`;
    }

    if (!(VALID_MODULE_LEVELS as readonly string[]).includes(level)) {
      return `❌ Invalid level: "${level}". Valid: ${VALID_MODULE_LEVELS.join(", ")}`;
    }

    const oldLevel = this.permissions.getLevel(chatId, module);
    this.permissions.setLevel(chatId, module, level as ModuleLevel, senderId);

    const icons: Record<string, string> = { open: "✅", admin: "🔐", disabled: "❌" };
    return `${icons[level]} **${module}**: ${oldLevel} → ${level}`;
  }

  private showModuleInfo(module: string | undefined, chatId: string): string {
    if (!module) {
      return "❌ Usage: /modules info <module>";
    }

    module = module.toLowerCase();

    if (!this.registry || !this.permissions) return "❌ Module permissions not available";
    const available = this.registry.getAvailableModules();
    if (!available.includes(module)) {
      return `❌ Unknown module: "${module}"`;
    }

    const tools = this.registry.getModuleTools(module);
    const count = tools.length;
    const toolWord = count === 1 ? "tool" : "tools";
    const level = this.permissions.getLevel(chatId, module);
    const isProtected = this.permissions.isProtected(module);
    const protectedMark = isProtected ? " 🔒" : "";

    const lines: string[] = [
      `📦 Module "**${module}**" — ${level}${protectedMark} (${count} ${toolWord})\n`,
    ];

    for (const t of tools) {
      lines.push(` ${t.name}   ${t.scope}`);
    }

    return lines.join("\n");
  }

  private resetModules(chatId: string, module: string | undefined): string {
    if (!this.registry || !this.permissions) return "❌ Module permissions not available";
    if (module) {
      module = module.toLowerCase();
      const available = this.registry.getAvailableModules();
      if (!available.includes(module)) {
        return `❌ Unknown module: "${module}"`;
      }
      if (this.permissions.isProtected(module)) {
        return `⛔ Module "${module}" is protected (already open)`;
      }
      this.permissions.resetModule(chatId, module);
      return `✅ **${module}** → open`;
    }

    this.permissions.resetAll(chatId);
    return "✅ All modules reset to **open**";
  }

  private handlePluginCommand(command: AdminCommand): string {
    const sub = command.args[0]?.toLowerCase();

    if (!sub) {
      return (
        "🔌 **Plugin Secrets**\n\n" +
        "**/plugin set** <name> <key> <value>\n" +
        "Set a secret for a plugin\n\n" +
        "**/plugin unset** <name> <key>\n" +
        "Remove a secret\n\n" +
        "**/plugin keys** <name>\n" +
        "List configured secret keys"
      );
    }

    switch (sub) {
      case "set": {
        const [, pluginName, key, ...valueParts] = command.args;
        if (!pluginName || !key || valueParts.length === 0) {
          return "❌ Usage: /plugin set <name> <key> <value>";
        }
        const value = valueParts.join(" ");
        writePluginSecret(pluginName, key, value);
        return `✅ Secret **${key}** saved for **${pluginName}**\n\n⚠️ Restart agent or reload plugin for changes to take effect.`;
      }

      case "unset": {
        const [, pluginName, key] = command.args;
        if (!pluginName || !key) {
          return "❌ Usage: /plugin unset <name> <key>";
        }
        const deleted = deletePluginSecret(pluginName, key);
        return deleted
          ? `✅ Secret **${key}** removed from **${pluginName}**`
          : `⚠️ Secret **${key}** not found for **${pluginName}**`;
      }

      case "keys": {
        const [, pluginName] = command.args;
        if (!pluginName) {
          return "❌ Usage: /plugin keys <name>";
        }
        const keys = listPluginSecretKeys(pluginName);
        if (keys.length === 0) {
          return `🔌 **${pluginName}** — no secrets configured`;
        }
        return `🔌 **${pluginName}** secrets:\n${keys.map((k) => `  • ${k}`).join("\n")}`;
      }

      default:
        return `❌ Unknown subcommand: "${sub}"\n\nUsage: /plugin set|unset|keys <name> ...`;
    }
  }

  private handleCommandsCommand(command: AdminCommand): string {
    const ca = this.config.command_access;
    const sub = command.args[0]?.toLowerCase();

    if (!sub) {
      // Show current settings
      return (
        `🔒 **Command Access Settings**\n\n` +
        `Commands enabled: ${ca.commands_enabled ? "✅ ON" : "❌ OFF"}\n` +
        `Admin-only: ${ca.admin_only_commands ? "✅ ON" : "❌ OFF"}\n` +
        `Unknown command reply: ${ca.unknown_command_reply ? "✅ ON" : "❌ OFF"}\n` +
        `Allowed users: ${ca.allowed_user_ids.length > 0 ? ca.allowed_user_ids.join(", ") : "(none — unrestricted)"}\n` +
        `Allowed chats: ${ca.allowed_chat_ids.length > 0 ? ca.allowed_chat_ids.join(", ") : "(none — unrestricted)"}\n\n` +
        `Usage:\n` +
        `/commands enable|disable\n` +
        `/commands admin_only on|off\n` +
        `/commands unknown_reply on|off\n` +
        `/commands allow_user <id>\n` +
        `/commands allow_user remove <id>\n` +
        `/commands allow_chat <id>\n` +
        `/commands allow_chat remove <id>`
      );
    }

    if (sub === "enable") {
      ca.commands_enabled = true;
      return "✅ Commands **enabled**";
    }

    if (sub === "disable") {
      ca.commands_enabled = false;
      return "❌ Commands **disabled**";
    }

    if (sub === "admin_only") {
      const val = command.args[1]?.toLowerCase();
      if (val !== "on" && val !== "off") {
        return `❌ Usage: /commands admin_only on|off\nCurrent: ${ca.admin_only_commands ? "on" : "off"}`;
      }
      ca.admin_only_commands = val === "on";
      return val === "on"
        ? "🔐 Admin-only commands **ON** — only admins can run commands"
        : "✅ Admin-only commands **OFF** — all users can run commands (subject to other restrictions)";
    }

    if (sub === "unknown_reply") {
      const val = command.args[1]?.toLowerCase();
      if (val !== "on" && val !== "off") {
        return `❌ Usage: /commands unknown_reply on|off\nCurrent: ${ca.unknown_command_reply ? "on" : "off"}`;
      }
      ca.unknown_command_reply = val === "on";
      return val === "on"
        ? "✅ Unknown command reply **ON**"
        : "❌ Unknown command reply **OFF** — unrecognized commands will be silently ignored";
    }

    if (sub === "allow_user") {
      const action = command.args[1]?.toLowerCase();
      if (action === "remove") {
        const id = parseInt(command.args[2], 10);
        if (isNaN(id)) return "❌ Usage: /commands allow_user remove <id>";
        const idx = ca.allowed_user_ids.indexOf(id);
        if (idx === -1) return `⚠️ User ${id} was not in the allowlist`;
        ca.allowed_user_ids.splice(idx, 1);
        return `✅ User **${id}** removed from allowed users\nAllowed: ${ca.allowed_user_ids.length > 0 ? ca.allowed_user_ids.join(", ") : "(none — unrestricted)"}`;
      }
      const id = parseInt(command.args[1], 10);
      if (isNaN(id)) return "❌ Usage: /commands allow_user <id>";
      if (ca.allowed_user_ids.includes(id)) return `⚠️ User ${id} is already in the allowlist`;
      ca.allowed_user_ids.push(id);
      return `✅ User **${id}** added to allowed users\nAllowed: ${ca.allowed_user_ids.join(", ")}`;
    }

    if (sub === "allow_chat") {
      const action = command.args[1]?.toLowerCase();
      if (action === "remove") {
        const id = parseInt(command.args[2], 10);
        if (isNaN(id)) return "❌ Usage: /commands allow_chat remove <id>";
        const idx = ca.allowed_chat_ids.indexOf(id);
        if (idx === -1) return `⚠️ Chat ${id} was not in the allowlist`;
        ca.allowed_chat_ids.splice(idx, 1);
        return `✅ Chat **${id}** removed from allowed chats\nAllowed: ${ca.allowed_chat_ids.length > 0 ? ca.allowed_chat_ids.join(", ") : "(none — unrestricted)"}`;
      }
      const id = parseInt(command.args[1], 10);
      if (isNaN(id)) return "❌ Usage: /commands allow_chat <id>";
      if (ca.allowed_chat_ids.includes(id)) return `⚠️ Chat ${id} is already in the allowlist`;
      ca.allowed_chat_ids.push(id);
      return `✅ Chat **${id}** added to allowed chats\nAllowed: ${ca.allowed_chat_ids.join(", ")}`;
    }

    return `❌ Unknown subcommand: "${sub}"\n\nRun /commands for help.`;
  }

  private handleHelpCommand(): string {
    return `🤖 **Teleton Admin Commands**

**/status**
View agent status

**/model** <name>
Switch LLM model

**/loop** <1-50>
Set max agentic iterations

**/policy** <dm|group> <value>
Change access policy

**/commands** [enable|disable|admin_only|unknown_reply|allow_user|allow_chat]
Manage command access control settings

**/strategy** [buy|sell <percent>]
View or change trading thresholds

**/modules** [set|info|reset]
Manage per-group module permissions

**/plugin** set|unset|keys <name> ...
Manage plugin secrets (API keys, tokens)

**/wallet**
Check TON wallet balance

**/verbose**
Toggle verbose debug logging

**/rag** [status|topk <n>]
Toggle Tool RAG or view status

**/guest** on|off
Toggle guest mode (answer queries in non-member chats)

**/pause** / **/resume**
Pause or resume the agent

**/stop**
Emergency shutdown

**/task** <description>
Give a task to the agent

**/clear** [chat_id]
Clear conversation history

**/boot**
Run agent bootstrap (first-time setup conversation)

**/ping**
Check if agent is responsive

**/help**
Show this help message`;
  }
}
