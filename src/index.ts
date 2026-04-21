import type { Api } from "telegram";
import type { PluginMessageEvent, PluginCallbackEvent } from "@teleton-agent/sdk";
import { loadConfig, getDefaultConfigPath } from "./config/index.js";
import { loadSoul } from "./soul/index.js";
import { AgentRuntime } from "./agent/runtime.js";
import { TelegramBridge, type TelegramMessage } from "./telegram/bridge.js";
import { MessageHandler } from "./telegram/handlers.js";
import { AdminHandler } from "./telegram/admin.js";
import { MessageDebouncer } from "./telegram/debounce.js";
import { getDatabase, closeDatabase, initializeMemory, type MemorySystem } from "./memory/index.js";
import { getWalletAddress } from "./ton/wallet-service.js";
import { setTonapiKey } from "./constants/api-endpoints.js";
import { setToncenterApiKey } from "./ton/endpoint.js";
import { TELETON_ROOT } from "./workspace/paths.js";
import {
  TELEGRAM_CONNECTION_RETRIES,
  TELEGRAM_FLOOD_SLEEP_THRESHOLD,
  SESSION_PRUNE_DAYS,
} from "./constants/limits.js";
import { join } from "path";
import { ToolRegistry } from "./agent/tools/registry.js";
import { registerAllTools } from "./agent/tools/register-all.js";
import { loadEnhancedPlugins, type PluginModuleWithHooks } from "./agent/tools/plugin-loader.js";
import type { HookName, AgentStartEvent, AgentStopEvent } from "./sdk/hooks/types.js";
import { createHookRunner } from "./sdk/hooks/runner.js";
import type { SDKDependencies } from "./sdk/index.js";
import { getProviderMetadata, type SupportedProvider } from "./config/providers.js";
import { readRawConfig, setNestedValue, writeRawConfig } from "./config/configurable-keys.js";
import { loadModules } from "./agent/tools/module-loader.js";
import { ModulePermissions } from "./agent/tools/module-permissions.js";
import { SHUTDOWN_TIMEOUT_MS } from "./constants/timeouts.js";
import type { PluginModule, PluginContext } from "./agent/tools/types.js";
import { PluginWatcher } from "./agent/tools/plugin-watcher.js";
import {
  loadMcpServers,
  registerMcpTools,
  closeMcpServers,
  type McpConnection,
} from "./agent/tools/mcp-loader.js";
import { getErrorMessage } from "./utils/errors.js";
import { isHeartbeatOk, isSilentReply } from "./constants/tokens.js";
import { UserHookEvaluator } from "./agent/hooks/user-hook-evaluator.js";
import { createLogger, initLoggerFromConfig } from "./utils/logger.js";
import { AgentLifecycle } from "./agent/lifecycle.js";
import { InlineRouter } from "./bot/inline-router.js";
import { PluginRateLimiter } from "./bot/rate-limiter.js";
import { setBotPreMiddleware, getDealBot } from "./deals/module.js";
import type { TaskDependencyResolver } from "./telegram/task-dependency-resolver.js";
import type { Task, TaskStore } from "./memory/agent/tasks.js";
import type { WebUIServer } from "./webui/server.js";
import type { ApiServer } from "./api/server.js";
import { initMetrics } from "./services/metrics.js";
import { initAnalytics } from "./services/analytics.js";
import { initAutonomousPlanning } from "./services/autonomous-planning.js";
import { flushOffsets } from "./telegram/offset-store.js";

const log = createLogger("App");

export class TeletonApp {
  private config;
  private agent: AgentRuntime;
  private bridge: TelegramBridge;
  private messageHandler: MessageHandler;
  private adminHandler: AdminHandler;
  private debouncer: MessageDebouncer | null = null;
  private toolCount: number = 0;
  private toolRegistry: ToolRegistry;
  private dependencyResolver: TaskDependencyResolver | null = null;
  private modules: PluginModule[] = [];
  private builtinModuleCount: number = 0;
  private memory: MemorySystem;
  private sdkDeps: SDKDependencies;
  private webuiServer: WebUIServer | null = null;
  private apiServer: ApiServer | null = null;
  private pluginWatcher: PluginWatcher | null = null;
  private mcpConnections: McpConnection[] = [];
  private callbackHandlerRegistered = false;
  private messageHandlersRegistered = false;
  private lifecycle = new AgentLifecycle();
  private hookRunner?: ReturnType<typeof createHookRunner>;
  private userHookEvaluator: UserHookEvaluator | null = null;
  private startTime: number = 0;
  private messagesProcessed: number = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatRunning = false;

  private configPath: string;

  constructor(configPath?: string) {
    this.configPath = configPath ?? getDefaultConfigPath();
    this.config = loadConfig(this.configPath);

    // Wire YAML logging config to pino (H2 fix)
    initLoggerFromConfig(this.config.logging);

    if (this.config.tonapi_key) {
      setTonapiKey(this.config.tonapi_key);
    }
    if (this.config.toncenter_api_key) {
      setToncenterApiKey(this.config.toncenter_api_key);
    }

    const soul = loadSoul();

    this.toolRegistry = new ToolRegistry();
    registerAllTools(this.toolRegistry);

    this.agent = new AgentRuntime(this.config, soul, this.toolRegistry);

    const mtprotoProxies =
      this.config.mtproto?.enabled && this.config.mtproto.proxies.length > 0
        ? this.config.mtproto.proxies
        : undefined;

    this.bridge = new TelegramBridge({
      apiId: this.config.telegram.api_id,
      apiHash: this.config.telegram.api_hash,
      phone: this.config.telegram.phone,
      sessionPath: join(TELETON_ROOT, "telegram_session.txt"),
      connectionRetries: TELEGRAM_CONNECTION_RETRIES,
      autoReconnect: true,
      floodSleepThreshold: TELEGRAM_FLOOD_SLEEP_THRESHOLD,
      mtprotoProxies,
    });

    const embeddingProvider = this.config.embedding.provider;
    this.memory = initializeMemory({
      database: {
        path: join(TELETON_ROOT, "memory.db"),
        enableVectorSearch: embeddingProvider !== "none",
        vectorDimensions: 384,
      },
      embeddings: {
        provider: embeddingProvider,
        model: this.config.embedding.model,
        apiKey: embeddingProvider === "anthropic" ? this.config.agent.api_key : undefined,
      },
      workspaceDir: join(TELETON_ROOT),
    });

    const db = getDatabase().getDb();

    // Initialize analytics and metrics singletons early so agent runtime can record data
    initMetrics(db);
    initAnalytics(db);
    initAutonomousPlanning(this.config);

    this.userHookEvaluator = new UserHookEvaluator(db);
    this.agent.setUserHookEvaluator(this.userHookEvaluator);

    this.sdkDeps = { bridge: this.bridge };

    this.modules = loadModules(this.toolRegistry, this.config, db);
    this.builtinModuleCount = this.modules.length;

    const modulePermissions = new ModulePermissions(db);
    this.toolRegistry.setPermissions(modulePermissions);

    this.toolCount = this.toolRegistry.count;
    this.messageHandler = new MessageHandler(
      this.bridge,
      this.config.telegram,
      this.agent,
      db,
      this.memory.embedder,
      getDatabase().isVectorSearchReady(),
      this.config
    );

    this.adminHandler = new AdminHandler(
      this.bridge,
      this.config.telegram,
      this.agent,
      modulePermissions,
      this.toolRegistry
    );
  }

  /**
   * Get the lifecycle state machine for WebUI integration
   */
  getLifecycle(): AgentLifecycle {
    return this.lifecycle;
  }

  // --- Public accessors for API-only bootstrap mode ---

  getAgent(): AgentRuntime {
    return this.agent;
  }

  getBridge(): TelegramBridge {
    return this.bridge;
  }

  getMemory(): MemorySystem {
    return this.memory;
  }

  getToolRegistry(): ToolRegistry {
    return this.toolRegistry;
  }

  getPlugins(): { name: string; version: string }[] {
    return this.modules
      .filter((m) => this.toolRegistry.isPluginModule(m.name))
      .map((m) => ({ name: m.name, version: m.version ?? "0.0.0" }));
  }

  getWebuiConfig() {
    return this.config.webui;
  }

  getConfigPath(): string {
    return this.configPath;
  }

  /** Start agent subsystems without WebUI/API servers. For bootstrap mode. */
  async startAgentSubsystems(): Promise<void> {
    this.lifecycle.registerCallbacks(
      () => this.startAgent(),
      () => this.stopAgent()
    );
    await this.lifecycle.start();
  }

  /** Stop agent subsystems and close database. For bootstrap mode. */
  async stopAgentSubsystems(): Promise<void> {
    await this.lifecycle.stop();
    try {
      closeDatabase();
    } catch (e) {
      log.error({ err: e }, "Database close failed");
    }
  }

  /**
   * Build a live MCP server info getter for WebUI / API server initialization.
   * Returns a function (not a snapshot) so it always reflects current connection state.
   */
  private buildMcpServerInfoGetter() {
    return () =>
      Object.entries(this.config.mcp.servers).map(([name, serverConfig]) => {
        const type = serverConfig.command
          ? ("stdio" as const)
          : serverConfig.url
            ? ("streamable-http" as const)
            : ("sse" as const);
        const target = serverConfig.command ?? serverConfig.url ?? "";
        const connected = this.mcpConnections.some((c) => c.serverName === name);
        const moduleName = `mcp_${name}`;
        const moduleTools = this.toolRegistry.getModuleTools(moduleName);
        return {
          name,
          type,
          target,
          scope: serverConfig.scope ?? "always",
          enabled: serverConfig.enabled ?? true,
          connected,
          toolCount: moduleTools.length,
          tools: moduleTools.map((t) => t.name),
          envKeys: Object.keys(serverConfig.env ?? {}),
        };
      });
  }

  /**
   * Build the shared plugin context passed to marketplace / module startup.
   */
  private buildPluginContext(): PluginContext {
    return {
      bridge: this.bridge,
      db: getDatabase().getDb(),
      config: this.config,
    };
  }

  /**
   * Start the agent
   */
  async start(): Promise<void> {
    // ASCII banner (blue color)
    const blue = "\x1b[34m";
    const reset = "\x1b[0m";
    log.info(`
${blue}  ┌───────────────────────────────────────────────────────────────────────────────────────┐
  │                                                                                       │
  │       ______________    ________________  _   __   ___   _____________   ________     │
  │      /_  __/ ____/ /   / ____/_  __/ __ \\/ | / /  /   | / ____/ ____/ | / /_  __/     │
  │       / / / __/ / /   / __/   / / / / / /  |/ /  / /| |/ / __/ __/ /  |/ / / /        │
  │      / / / /___/ /___/ /___  / / / /_/ / /|  /  / ___ / /_/ / /___/ /|  / / /         │
  │     /_/ /_____/_____/_____/ /_/  \\____/_/ |_/  /_/  |_\\____/_____/_/ |_/ /_/          │
  │                                                                                       │
  └────────────────────────────────────────────────────────────────── DEV: ZKPROOF.T.ME ──┘${reset}
`);

    // Register lifecycle callbacks so WebUI routes can call start()/stop() without args
    this.lifecycle.registerCallbacks(
      () => this.startAgent(),
      () => this.stopAgent()
    );

    // Start WebUI server if enabled (before agent — survives agent stop/restart)
    if (this.config.webui.enabled) {
      try {
        const { WebUIServer } = await import("./webui/server.js");
        const mcpServers = this.buildMcpServerInfoGetter();
        const pluginContext = this.buildPluginContext();
        const builtinNames = this.modules.map((m) => m.name);

        this.webuiServer = new WebUIServer({
          agent: this.agent,
          bridge: this.bridge,
          memory: this.memory,
          toolRegistry: this.toolRegistry,
          plugins: this.getPlugins(),
          mcpServers,
          config: this.config.webui,
          configPath: this.configPath,
          lifecycle: this.lifecycle,
          marketplace: {
            modules: this.modules,
            config: this.config,
            sdkDeps: this.sdkDeps,
            pluginContext,
            loadedModuleNames: builtinNames,
            rewireHooks: () => this.wirePluginEventHooks(),
          },
          userHookEvaluator: this.userHookEvaluator,
        });
        await this.webuiServer.start();
      } catch (error) {
        log.error({ err: error }, "❌ Failed to start WebUI server");
        log.warn("⚠️ Continuing without WebUI...");
      }
    }

    // Start Management API server if enabled (before agent — survives agent stop/restart)
    if (this.config.api?.enabled) {
      try {
        const { ApiServer: ApiServerClass } = await import("./api/server.js");
        const mcpServers = this.buildMcpServerInfoGetter();
        const pluginContext = this.buildPluginContext();
        const builtinNames = this.modules.map((m) => m.name);

        this.apiServer = new ApiServerClass(
          {
            agent: this.agent,
            bridge: this.bridge,
            memory: this.memory,
            toolRegistry: this.toolRegistry,
            plugins: this.getPlugins(),
            mcpServers,
            config: this.config.webui,
            configPath: this.configPath,
            lifecycle: this.lifecycle,
            marketplace: {
              modules: this.modules,
              config: this.config,
              sdkDeps: this.sdkDeps,
              pluginContext,
              loadedModuleNames: builtinNames,
              rewireHooks: () => this.wirePluginEventHooks(),
            },
            userHookEvaluator: this.userHookEvaluator,
          },
          this.config.api
        );
        await this.apiServer.start();

        // Output credentials if requested via --json-credentials flag
        if (process.env.TELETON_JSON_CREDENTIALS === "true") {
          const creds = this.apiServer.getCredentials();
          process.stdout.write(JSON.stringify(creds) + "\n");
        }
      } catch (error) {
        log.error({ err: error }, "Failed to start Management API server");
        log.warn("Continuing without Management API...");
      }
    }

    // Start agent subsystems via lifecycle
    await this.lifecycle.start(() => this.startAgent());

    // Keep process alive
    await new Promise(() => {});
  }

  /**
   * Start agent subsystems (Telegram, plugins, MCP, modules, debouncer, handler).
   * Called by lifecycle.start() — do NOT call directly.
   */
  private async startAgent(): Promise<void> {
    // Truncate to builtins before re-loading plugins (prevents duplication on restart)
    this.modules.length = this.builtinModuleCount;

    // Capture builtin module names AFTER truncation so plugin names from a previous
    // run are not included in the tools-loaded log line (which caused duplicates).
    const moduleNames = this.modules
      .filter((m) => m.tools(this.config).length > 0)
      .map((m) => m.name);

    // Load enhanced plugins from ~/.teleton/plugins/
    const builtinNames = this.modules.map((m) => m.name);
    const { modules: externalModules, hookRegistry } = await loadEnhancedPlugins(
      this.config,
      builtinNames,
      this.sdkDeps,
      getDatabase().getDb()
    );
    let pluginToolCount = 0;
    const pluginNames: string[] = [];
    for (const mod of externalModules) {
      try {
        mod.configure?.(this.config);
        mod.migrate?.(getDatabase().getDb());
        const tools = mod.tools(this.config);
        if (tools.length > 0) {
          pluginToolCount += this.toolRegistry.registerPluginTools(mod.name, tools);
          pluginNames.push(mod.name);
        }
        this.modules.push(mod);
      } catch (error) {
        log.error(
          `❌ Plugin "${mod.name}" failed to load: ${error instanceof Error ? error.message : error}`
        );
      }
    }
    if (pluginToolCount > 0) {
      this.toolCount = this.toolRegistry.count;
    }

    // Load MCP servers
    const mcpServerNames: string[] = [];
    if (Object.keys(this.config.mcp.servers).length > 0) {
      this.mcpConnections = await loadMcpServers(this.config.mcp);
      if (this.mcpConnections.length > 0) {
        const mcp = await registerMcpTools(this.mcpConnections, this.toolRegistry);
        if (mcp.count > 0) {
          this.toolCount = this.toolRegistry.count;
          mcpServerNames.push(...mcp.names);
          log.info(
            `🔌 MCP: ${mcp.count} tools from ${mcp.names.length} server(s) (${mcp.names.join(", ")})`
          );
        }
      }
    }

    // Initialize tool config from database
    this.toolRegistry.loadConfigFromDB(getDatabase().getDb());

    // Initialize Tool RAG index
    if (this.config.tool_rag.enabled) {
      const { ToolIndex } = await import("./agent/tools/tool-index.js");
      const toolIndex = new ToolIndex(
        getDatabase().getDb(),
        this.memory.embedder,
        getDatabase().isVectorSearchReady(),
        {
          topK: this.config.tool_rag.top_k,
          alwaysInclude: this.config.tool_rag.always_include,
          skipUnlimitedProviders: this.config.tool_rag.skip_unlimited_providers,
        }
      );
      toolIndex.ensureSchema();
      this.toolRegistry.setToolIndex(toolIndex);

      // Re-index callback for hot-reload plugins
      // eslint-disable-next-line @typescript-eslint/no-misused-promises -- callback is fire-and-forget
      this.toolRegistry.onToolsChanged(async (removed, added) => {
        await toolIndex.reindexTools(removed, added);
      });
    }

    // Provider info and tool limit check
    const provider = (this.config.agent.provider || "anthropic") as SupportedProvider;
    const providerMeta = getProviderMetadata(provider);
    const allNames = [...moduleNames, ...pluginNames, ...mcpServerNames];
    log.info(
      `🔌 ${this.toolCount} tools loaded (${allNames.join(", ")})${pluginToolCount > 0 ? ` — ${pluginToolCount} from plugins` : ""}`
    );
    if (providerMeta.toolLimit !== null && this.toolCount > providerMeta.toolLimit) {
      log.warn(
        `⚠️ Tool count (${this.toolCount}) exceeds ${providerMeta.displayName} limit (${providerMeta.toolLimit})`
      );
    }

    // Migrate sessions from JSON to SQLite (one-time)
    const { migrateSessionsToDb } = await import("./session/migrate.js");
    migrateSessionsToDb();

    // Cleanup old transcript files (>30 days)
    const { cleanupOldTranscripts } = await import("./session/transcript.js");
    cleanupOldTranscripts(SESSION_PRUNE_DAYS);

    // Prune old sessions (>SESSION_PRUNE_DAYS days)
    const { pruneOldSessions } = await import("./session/store.js");
    pruneOldSessions(SESSION_PRUNE_DAYS);

    // Harden permissions on existing files (one-shot, idempotent)
    const { hardenExistingPermissions } = await import("./workspace/harden-permissions.js");
    hardenExistingPermissions();

    // Ensure heartbeat config exists in YAML (so users can see/edit it)
    {
      const raw = readRawConfig(this.configPath);
      if (raw && !raw.heartbeat) {
        raw.heartbeat = {
          enabled: this.config.heartbeat.enabled,
          interval_ms: this.config.heartbeat.interval_ms,
          self_configurable: this.config.heartbeat.self_configurable,
        };
        writeRawConfig(raw, this.configPath);
        log.info("Config: heartbeat section added to config.yaml");
      }
    }

    // Warmup embedding model (pre-download at startup, not on first message)
    if (this.memory.embedder.warmup) {
      await this.memory.embedder.warmup();
    }

    // Index knowledge base (MEMORY.md, memory/*.md)
    // Force re-index if embedding dimensions changed (model switch)
    const db = getDatabase();
    const forceReindex = db.didDimensionsChange();
    const indexResult = await this.memory.knowledge.indexAll({ force: forceReindex });
    let ftsResult = { knowledge: 0, messages: 0 };
    if (indexResult.indexed > 0) {
      ftsResult = db.rebuildFtsIndexes();
    }

    // Consolidate old session memory files (non-blocking — runs after startup)
    import("./session/memory-hook.js")
      .then(({ consolidateOldMemoryFiles }) =>
        consolidateOldMemoryFiles({
          apiKey: this.config.agent.api_key,
          provider: this.config.agent.provider as SupportedProvider,
          utilityModel: this.config.agent.utility_model,
        })
      )
      .then((r) => {
        if (r.consolidated > 0)
          log.info(`🧹 Consolidated ${r.consolidated} old session memory files`);
      })
      .catch((error) => log.warn({ err: error }, "Memory consolidation skipped"));

    // Index tools for Tool RAG
    const toolIndex = this.toolRegistry.getToolIndex();
    if (toolIndex) {
      const t0 = Date.now();
      const indexedCount = await toolIndex.indexAll(this.toolRegistry.getAll());
      log.info(`🔍 Tool RAG: ${indexedCount} tools indexed (${Date.now() - t0}ms)`);
    }

    // Initialize context builder for RAG search in agent
    this.agent.initializeContextBuilder(this.memory.embedder, db.isVectorSearchReady());

    // Cocoon Network — register models from external cocoon-cli proxy
    if (this.config.agent.provider === "cocoon") {
      try {
        const { registerCocoonModels } = await import("./agent/client.js");
        const port = this.config.cocoon?.port ?? 10000;
        const models = await registerCocoonModels(port);
        if (models.length === 0) {
          throw new Error(`No models found on port ${port}`);
        }
        log.info(`Cocoon Network ready — ${models.length} model(s) on port ${port}`);
      } catch (err) {
        log.error(
          `Cocoon Network unavailable on port ${this.config.cocoon?.port ?? 10000}: ${getErrorMessage(err)}`
        );
        log.error("Start the Cocoon client first: cocoon start");
        throw new Error(`Cocoon Network unavailable: ${getErrorMessage(err)}`);
      }
    }

    // Local LLM — register models from OpenAI-compatible server
    if (this.config.agent.provider === "local" && !this.config.agent.base_url) {
      throw new Error(
        "Local provider requires base_url in config (e.g. http://localhost:11434/v1)"
      );
    }
    if (this.config.agent.provider === "local" && this.config.agent.base_url) {
      try {
        const { registerLocalModels } = await import("./agent/client.js");
        const models = await registerLocalModels(this.config.agent.base_url);
        if (models.length > 0) {
          log.info(`Discovered ${models.length} local model(s): ${models.join(", ")}`);
          if (!this.config.agent.model || this.config.agent.model === "auto") {
            this.config.agent.model = models[0];
            log.info(`Using local model: ${models[0]}`);
          }
        } else {
          log.warn("No models found on local LLM server — is it running?");
        }
      } catch (err) {
        log.error(
          `Local LLM server unavailable at ${this.config.agent.base_url}: ${getErrorMessage(err)}`
        );
        log.error("Start the LLM server first (e.g. ollama serve)");
        throw new Error(`Local LLM server unavailable: ${getErrorMessage(err)}`);
      }
    }

    // Connect to Telegram
    await this.bridge.connect();

    if (!this.bridge.isAvailable()) {
      throw new Error("Failed to connect to Telegram");
    }

    // Resolve owner name/username from Telegram if not already set
    await this.resolveOwnerInfo();

    // Set own user ID in handler after connection
    const ownUserId = this.bridge.getOwnUserId();
    if (ownUserId) {
      this.messageHandler.setOwnUserId(ownUserId.toString());
    }

    const username = await this.bridge.getUsername();
    const walletAddress = getWalletAddress();

    // Set up inline router for plugin bot SDK (before modules start)
    const inlineRouter = new InlineRouter();
    const rateLimiter = new PluginRateLimiter();

    // Install router middleware on the DealBot's Grammy instance
    // setBotPreMiddleware must be called BEFORE deals module start()
    setBotPreMiddleware(inlineRouter.middleware());

    // Start module background jobs (after bridge connect — deals needs bridge)
    const pluginContext = this.buildPluginContext();
    const startedModules: typeof this.modules = [];
    try {
      for (const mod of this.modules) {
        await mod.start?.(pluginContext);
        startedModules.push(mod);
      }
    } catch (error) {
      log.error({ err: error }, "❌ Module start failed, cleaning up started modules");
      for (const mod of startedModules.reverse()) {
        try {
          await mod.stop?.();
        } catch (e) {
          log.error({ err: e }, `⚠️ Module "${mod.name}" cleanup failed`);
        }
      }
      throw error;
    }

    // Wire bot references into SDK deps (after DealBot has started)
    const activeDealBot = getDealBot();
    if (activeDealBot) {
      this.sdkDeps.inlineRouter = inlineRouter;
      this.sdkDeps.gramjsBot = activeDealBot.getGramJSBot();
      this.sdkDeps.grammyBot = activeDealBot.getBot();
      this.sdkDeps.rateLimiter = rateLimiter;
      inlineRouter.setGramJSBot(activeDealBot.getGramJSBot());
      log.info("🔌 Bot SDK: inline router installed");
    }

    // Create hook runner if any plugins registered hooks
    if (hookRegistry.hasAnyHooks()) {
      const hookRunner = createHookRunner(hookRegistry, { logger: log });
      this.agent.setHookRunner(hookRunner);
      this.hookRunner = hookRunner;

      const activeHooks: HookName[] = [
        "tool:before",
        "tool:after",
        "tool:error",
        "prompt:before",
        "prompt:after",
        "session:start",
        "session:end",
        "message:receive",
        "response:before",
        "response:after",
        "response:error",
        "agent:start",
        "agent:stop",
      ];
      const active = activeHooks.filter((n) => hookRegistry.hasHooks(n));
      log.info(`🪝 Hook runner created (${active.join(", ")})`);
    }

    // Collect plugin event hooks and wire them up
    this.wirePluginEventHooks();

    // Start plugin hot-reload watcher (dev mode)
    if (this.config.dev.hot_reload) {
      this.pluginWatcher = new PluginWatcher({
        config: this.config,
        registry: this.toolRegistry,
        sdkDeps: this.sdkDeps,
        modules: this.modules,
        pluginContext,
        loadedModuleNames: builtinNames,
      });
      this.pluginWatcher.start();
    }

    // Display startup summary
    log.info(`✅ SOUL.md loaded`);
    log.info(`✅ Knowledge: ${indexResult.indexed} files, ${ftsResult.knowledge} chunks indexed`);
    log.info(`✅ Telegram: @${username} connected`);
    log.info(`✅ TON Blockchain: connected`);
    if (this.config.tonapi_key) {
      log.info(`🔑 TonAPI key configured`);
    }
    log.info(`✅ DEXs: STON.fi, DeDust connected`);
    log.info(`✅ Wallet: ${walletAddress || "not configured"}`);
    log.info(`✅ Model: ${provider}/${this.config.agent.model}`);
    log.info(`✅ Admins: ${this.config.telegram.admin_ids.join(", ")}`);
    log.info(
      `✅ Policy: DM ${this.config.telegram.dm_policy}, Groups ${this.config.telegram.group_policy}, Debounce ${this.config.telegram.debounce_ms}ms\n`
    );

    log.info("Teleton Agent is running! Press Ctrl+C to stop.");

    // Hook: agent:start
    this.startTime = Date.now();
    this.messagesProcessed = 0;
    if (this.hookRunner) {
      let version = "0.0.0";
      try {
        const { createRequire } = await import("module");
        const req = createRequire(import.meta.url);
        version = (req("../package.json") as { version: string }).version;
      } catch {
        /* ignore */
      }
      const agentStartEvent: AgentStartEvent = {
        version,
        provider: provider,
        model: this.config.agent.model,
        pluginCount: pluginNames.length,
        toolCount: this.toolCount,
        timestamp: Date.now(),
      };
      await this.hookRunner.runObservingHook("agent:start", agentStartEvent);
    }

    // Start heartbeat timer if enabled
    if (this.config.heartbeat.enabled) {
      const hbInterval = this.config.heartbeat.interval_ms;
      const adminChatId = this.config.telegram.admin_ids[0];
      if (adminChatId) {
        this.heartbeatTimer = setInterval(() => {
          void this.runHeartbeat();
        }, hbInterval);
        this.heartbeatTimer.unref();
        log.info(
          `Heartbeat enabled: every ${Math.round(hbInterval / 60000)}min → admin ${adminChatId}`
        );
      }
    }

    // Schedule autonomous daily planning and reflection cycle
    const { getAutonomousPlanning } = await import("./services/autonomous-planning.js");
    const planningSystem = getAutonomousPlanning();
    if (planningSystem) {
      planningSystem.scheduleDailyCycle();
      log.info("📅 Autonomous daily planning & reflection cycle scheduled");
    }

    // Initialize message debouncer with bypass logic
    this.debouncer = new MessageDebouncer(
      {
        debounceMs: this.config.telegram.debounce_ms,
      },
      (msg) => {
        // Bypass debounce for DMs (only debounce groups)
        if (!msg.isGroup) return false;

        // Bypass debounce for admin commands (priority processing)
        if (msg.text.startsWith("/")) {
          const adminCmd = this.adminHandler.parseCommand(msg.text);
          if (adminCmd && this.adminHandler.isAdmin(msg.senderId)) {
            return false;
          }
        }

        return true;
      },
      async (messages) => {
        // Process each message one by one (preserves full context for each)
        for (const message of messages) {
          await this.handleSingleMessage(message);
        }
      },
      (error, messages) => {
        log.error({ err: error }, `Error processing batch of ${messages.length} messages`);
      }
    );

    // Register GramJS event handlers ONCE (survive agent restart via WebUI)
    if (!this.messageHandlersRegistered) {
      this.bridge.onNewMessage(async (message) => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- debouncer always initialized before handlers register
          await this.debouncer!.enqueue(message);
        } catch (error) {
          log.error({ err: error }, "Error enqueueing message");
        }
      });

      this.bridge.onServiceMessage(async (message) => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- debouncer always initialized before handlers register
          await this.debouncer!.enqueue(message);
        } catch (error) {
          log.error({ err: error }, "Error enqueueing service message");
        }
      });

      this.messageHandlersRegistered = true;
    }
  }

  /**
   * Resolve owner name and username from Telegram API if not already configured.
   * Persists resolved values to the config file so this only happens once.
   */
  private async resolveOwnerInfo(): Promise<void> {
    try {
      // Skip if both are already set
      if (this.config.telegram.owner_name && this.config.telegram.owner_username) {
        return;
      }

      // Can't resolve without an owner ID
      if (!this.config.telegram.owner_id) {
        return;
      }

      const entity = await this.bridge.getClient().getEntity(String(this.config.telegram.owner_id));

      // Check that the entity is a User (has firstName)
      if (!entity || !("firstName" in entity)) {
        return;
      }

      const user = entity as Api.User;
      const firstName = user.firstName || "";
      const lastName = user.lastName || "";
      const fullName = lastName ? `${firstName} ${lastName}` : firstName;
      const username = user.username || "";

      let updated = false;

      if (!this.config.telegram.owner_name && fullName) {
        this.config.telegram.owner_name = fullName;
        updated = true;
      }

      if (!this.config.telegram.owner_username && username) {
        this.config.telegram.owner_username = username;
        updated = true;
      }

      if (updated) {
        // Persist to disk
        const raw = readRawConfig(this.configPath);
        if (this.config.telegram.owner_name) {
          setNestedValue(raw, "telegram.owner_name", this.config.telegram.owner_name);
        }
        if (this.config.telegram.owner_username) {
          setNestedValue(raw, "telegram.owner_username", this.config.telegram.owner_username);
        }
        writeRawConfig(raw, this.configPath);

        const displayName = this.config.telegram.owner_name || "Unknown";
        const displayUsername = this.config.telegram.owner_username
          ? ` (@${this.config.telegram.owner_username})`
          : "";
        log.info(`👤 Owner resolved: ${displayName}${displayUsername}`);
      }
    } catch (error) {
      log.warn(
        `⚠️ Could not resolve owner info: ${error instanceof Error ? error.message : error}`
      );
    }
  }

  /**
   * Handle a single message (extracted for debouncer callback)
   */
  private async handleSingleMessage(message: TelegramMessage): Promise<void> {
    this.messagesProcessed++;
    try {
      // Check if this is a scheduled task (from self)
      const ownUserId = this.bridge.getOwnUserId();
      if (
        ownUserId &&
        message.senderId === Number(ownUserId) &&
        message.text.startsWith("[TASK:")
      ) {
        await this.handleScheduledTask(message);
        return;
      }

      // Check if this is an admin command
      const adminCmd = this.adminHandler.parseCommand(message.text);
      const commandAllowed = adminCmd
        ? this.adminHandler.isCommandAllowed(message.senderId, message.chatId)
        : false;
      if (adminCmd && commandAllowed) {
        // /boot passes through to the agent with bootstrap instructions
        if (adminCmd.command === "boot") {
          const bootstrapContent = this.adminHandler.getBootstrapContent();
          if (bootstrapContent) {
            message.text = bootstrapContent;
            // Fall through to handleMessage below
          } else {
            await this.bridge.sendMessage({
              chatId: message.chatId,
              text: "❌ Bootstrap template not found.",
              replyToId: message.id,
            });
            return;
          }
        } else if (adminCmd.command === "task") {
          // /task passes through to the agent with task creation context
          const taskDescription = adminCmd.args.join(" ");
          if (!taskDescription) {
            await this.bridge.sendMessage({
              chatId: message.chatId,
              text: "❌ Usage: /task <description>",
              replyToId: message.id,
            });
            return;
          }
          message.text =
            `[ADMIN TASK]\n` +
            `Create a scheduled task using the telegram_create_scheduled_task tool.\n\n` +
            `Guidelines:\n` +
            `- If the description mentions a specific time or delay, use it as scheduleDate\n` +
            `- Otherwise, schedule 1 minute from now for immediate execution\n` +
            `- For simple operations (check a price, send a message), use a tool_call payload\n` +
            `- For complex multi-step tasks, use an agent_task payload with detailed instructions\n` +
            `- Always include a reason explaining why this task is being created\n\n` +
            `Task: "${taskDescription}"`;
          // Fall through to handleMessage below
        } else {
          const response = await this.adminHandler.handleCommand(
            adminCmd,
            message.chatId,
            message.senderId,
            message.isGroup
          );

          if (response) {
            await this.bridge.sendMessage({
              chatId: message.chatId,
              text: response,
              replyToId: message.id,
            });
          }

          return;
        }
      }

      // Silently drop commands that are not allowed (prevents LLM from seeing them)
      if (adminCmd && !commandAllowed) return;

      // Skip if paused (admin commands still work above)
      if (this.adminHandler.isPaused()) return;

      // Handle as regular message
      await this.messageHandler.handleMessage(message);
    } catch (error) {
      log.error({ err: error }, "Error handling message");
    }
  }

  /**
   * Handle scheduled task message
   */
  private async handleScheduledTask(message: TelegramMessage): Promise<void> {
    // Hoist all dynamic imports to top of function
    const { getTaskStore } = await import("./memory/agent/tasks.js");
    const { executeScheduledTask } = await import("./telegram/task-executor.js");
    const { TaskDependencyResolver } = await import("./telegram/task-dependency-resolver.js");
    const { getDatabase } = await import("./memory/index.js");

    const db = getDatabase().getDb();
    const taskStore = getTaskStore(db);

    // Extract task ID from format: [TASK:uuid] description
    const match = message.text.match(/^\[TASK:([^\]]+)\]/);
    if (!match) {
      log.warn(`Invalid task format: ${message.text}`);
      return;
    }

    const taskId = match[1];

    try {
      const task = taskStore.getTask(taskId);

      if (!task) {
        log.warn(`Task ${taskId} not found in database`);
        await this.bridge.sendMessage({
          chatId: message.chatId,
          text: `⚠️ Task ${taskId} not found. It may have been deleted.`,
          replyToId: message.id,
        });
        return;
      }

      // Skip tasks that are already running or in a terminal state
      if (
        task.status === "in_progress" ||
        task.status === "cancelled" ||
        task.status === "done" ||
        task.status === "failed"
      ) {
        log.info(`⏭️ Task ${taskId} already ${task.status}, skipping`);
        return;
      }

      // Check if all dependencies are satisfied
      if (!taskStore.canExecute(taskId)) {
        log.warn(`Task ${taskId} cannot execute yet - dependencies not satisfied`);
        await this.bridge.sendMessage({
          chatId: message.chatId,
          text: `⏳ Task "${task.description}" is waiting for parent tasks to complete.`,
          replyToId: message.id,
        });
        return;
      }

      // Mark task as in_progress
      taskStore.startTask(taskId);

      // Get parent task results for context
      const parentResults = taskStore.getParentResults(taskId);

      // Build tool context
      const toolContext = {
        bridge: this.bridge,
        db,
        chatId: message.chatId,
        isGroup: message.isGroup,
        senderId: message.senderId,
        config: this.config,
      };

      // Get tool registry from agent runtime
      const toolRegistry = this.agent.getToolRegistry();

      // Execute task and get prompt for agent (with parent context)
      const agentPrompt = await executeScheduledTask(
        task,
        this.agent,
        toolContext,
        toolRegistry,
        parentResults
      );

      // Feed prompt to agent (agent loop with full context)
      const response = await this.agent.processMessage({
        chatId: message.chatId,
        userMessage: agentPrompt,
        userName: "self-scheduled-task",
        timestamp: message.timestamp.getTime(),
        isGroup: false,
        toolContext,
        messageId: message.id,
      });

      // Send agent response
      if (response.content && response.content.trim().length > 0) {
        await this.bridge.sendMessage({
          chatId: message.chatId,
          text: response.content,
          replyToId: message.id,
        });
      }

      // Mark task as done if agent responded successfully
      taskStore.completeTask(taskId, response.content);

      log.info(`✅ Executed scheduled task ${taskId}: ${task.description}`);

      // Initialize dependency resolver if needed
      if (!this.dependencyResolver) {
        this.dependencyResolver = new TaskDependencyResolver(taskStore, this.bridge);
      }

      // Trigger any dependent tasks
      await this.dependencyResolver.onTaskComplete(taskId);

      // Reschedule recurring tasks
      if (task.recurrenceInterval && task.recurrenceInterval > 0) {
        await this.rescheduleRecurringTask(task, taskStore);
      }
    } catch (error) {
      log.error({ err: error }, "Error handling scheduled task");

      // Try to mark task as failed and cascade to dependents
      try {
        taskStore.failTask(taskId, getErrorMessage(error));

        // Initialize resolver if needed
        if (!this.dependencyResolver) {
          this.dependencyResolver = new TaskDependencyResolver(taskStore, this.bridge);
        }

        // Cascade failure to dependents
        await this.dependencyResolver.onTaskFail(taskId);
      } catch {
        // Ignore if we can't update task
      }
    }
  }

  /**
   * Reschedule a recurring task after it has completed.
   * Creates a new task with the same config, scheduled recurrenceInterval seconds from now.
   * Respects recurrenceUntil — stops rescheduling when the boundary is passed.
   */
  private async rescheduleRecurringTask(completedTask: Task, taskStore: TaskStore): Promise<void> {
    if (!completedTask.recurrenceInterval) return;

    try {
      const { Api } = await import("telegram");
      const { randomLong } = await import("./utils/gramjs-bigint.js");

      const nextRunAt = Math.floor(Date.now() / 1000) + completedTask.recurrenceInterval;

      // Stop recurring if recurrenceUntil has passed
      const until = completedTask.recurrenceUntil
        ? Math.floor(completedTask.recurrenceUntil.getTime() / 1000)
        : null;
      if (until !== null && nextRunAt > until) {
        log.info(
          `⏹️ Recurrence for task "${completedTask.description}" has ended (recurrenceUntil passed)`
        );
        return;
      }

      const nextRunDate = new Date(nextRunAt * 1000);

      const newTask = taskStore.createTask({
        description: completedTask.description,
        priority: completedTask.priority,
        createdBy: completedTask.createdBy,
        scheduledFor: nextRunDate,
        payload: completedTask.payload,
        reason: completedTask.reason,
        recurrenceInterval: completedTask.recurrenceInterval,
        recurrenceUntil: completedTask.recurrenceUntil,
      });

      // Schedule Telegram message for the next run
      const gramJsClient = this.bridge.getClient().getClient();
      const me = await gramJsClient.getMe();
      const taskMessage = `[TASK:${newTask.id}] ${newTask.description}`;

      const result = await gramJsClient.invoke(
        new Api.messages.SendMessage({
          peer: me,
          message: taskMessage,
          scheduleDate: nextRunAt,
          randomId: randomLong(),
        })
      );

      // Extract and persist the new scheduled message ID
      let scheduledMessageId: number | undefined;
      if (result instanceof Api.Updates || result instanceof Api.UpdatesCombined) {
        for (const update of result.updates) {
          if (update instanceof Api.UpdateMessageID) {
            scheduledMessageId = update.id;
            break;
          }
        }
      }
      if (scheduledMessageId !== undefined) {
        taskStore.updateTask(newTask.id, { scheduledMessageId });
      }

      log.info(
        `🔁 Rescheduled recurring task "${newTask.description}" → next run at ${nextRunDate.toISOString()} (taskId: ${newTask.id})`
      );
    } catch (error) {
      log.error({ err: error }, `Failed to reschedule recurring task ${completedTask.id}`);
    }
  }

  /**
   * Collect plugin onMessage/onCallbackQuery hooks and register them.
   * Uses dynamic dispatch over this.modules so newly installed/uninstalled
   * plugins are picked up without re-registering handlers.
   */
  private wirePluginEventHooks(): void {
    // Message hooks: single dynamic dispatcher that iterates this.modules
    this.messageHandler.setPluginMessageHooks([
      async (event: PluginMessageEvent) => {
        for (const mod of this.modules) {
          const withHooks = mod as PluginModuleWithHooks;
          if (withHooks.onMessage) {
            try {
              await withHooks.onMessage(event);
            } catch (err) {
              log.error(
                `❌ [${mod.name}] onMessage error: ${err instanceof Error ? err.message : err}`
              );
            }
          }
        }
      },
    ]);

    const hookCount = this.modules.filter((m) => (m as PluginModuleWithHooks).onMessage).length;
    if (hookCount > 0) {
      log.info(`🔗 ${hookCount} plugin onMessage hook(s) registered`);
    }

    // Callback query handler: register ONCE, dispatch dynamically
    if (!this.callbackHandlerRegistered) {
      this.bridge.getClient().addCallbackQueryHandler(async (update: unknown) => {
        if (!update || typeof update !== "object") {
          return;
        }
        const callbackUpdate = update as {
          queryId?: unknown;
          data?: { toString(): string } | string;
          peer?: {
            channelId?: { toString(): string };
            chatId?: { toString(): string };
            userId?: { toString(): string };
          };
          msgId?: unknown;
          userId?: unknown;
        };
        const queryId = callbackUpdate.queryId;
        const data =
          typeof callbackUpdate.data === "string"
            ? callbackUpdate.data
            : callbackUpdate.data?.toString() || "";
        const parts = data.split(":");
        const action = parts[0];
        const params = parts.slice(1);

        const chatId =
          callbackUpdate.peer?.channelId?.toString() ??
          callbackUpdate.peer?.chatId?.toString() ??
          callbackUpdate.peer?.userId?.toString() ??
          "";
        const messageId =
          typeof callbackUpdate.msgId === "number"
            ? callbackUpdate.msgId
            : Number(callbackUpdate.msgId || 0);
        const userId = Number(callbackUpdate.userId);

        const answer = async (text?: string, alert = false): Promise<void> => {
          try {
            await this.bridge.getClient().answerCallbackQuery(queryId, { message: text, alert });
          } catch (err) {
            log.error(
              `❌ Failed to answer callback query: ${err instanceof Error ? err.message : err}`
            );
          }
        };

        const event: PluginCallbackEvent = {
          data,
          action,
          params,
          chatId,
          messageId,
          userId,
          answer,
        };

        for (const mod of this.modules) {
          const withHooks = mod as PluginModuleWithHooks;
          if (withHooks.onCallbackQuery) {
            try {
              await withHooks.onCallbackQuery(event);
            } catch (err) {
              log.error(
                `❌ [${mod.name}] onCallbackQuery error: ${err instanceof Error ? err.message : err}`
              );
            }
          }
        }
      });
      this.callbackHandlerRegistered = true;

      const cbCount = this.modules.filter(
        (m) => (m as PluginModuleWithHooks).onCallbackQuery
      ).length;
      if (cbCount > 0) {
        log.info(`🔗 ${cbCount} plugin onCallbackQuery hook(s) registered`);
      }
    }
  }

  /**
   * Stop the agent
   */
  async stop(): Promise<void> {
    log.info("👋 Stopping Teleton AI...");

    // Stop agent subsystems via lifecycle
    await this.lifecycle.stop(() => this.stopAgent());

    // Stop WebUI server (if running)
    if (this.webuiServer) {
      try {
        await this.webuiServer.stop();
      } catch (e) {
        log.error({ err: e }, "⚠️ WebUI stop failed");
      }
    }

    // Stop Management API server (if running)
    if (this.apiServer) {
      try {
        await this.apiServer.stop();
      } catch (e) {
        log.error({ err: e }, "⚠️ Management API stop failed");
      }
    }

    // Close database last (shared with WebUI)
    try {
      closeDatabase();
    } catch (e) {
      log.error({ err: e }, "⚠️ Database close failed");
    }
  }

  /**
   * Run a single heartbeat tick — modeled on handleScheduledTask().
   * Calls processMessage() directly, bypasses MessageHandler.
   */
  private async runHeartbeat(): Promise<void> {
    if (this.heartbeatRunning) {
      log.debug("Heartbeat tick skipped (previous still running)");
      return;
    }
    const cfg = this.config.heartbeat;
    if (!cfg?.enabled) return;

    const adminChatId = this.config.telegram.admin_ids[0];
    if (!adminChatId) return;

    this.heartbeatRunning = true;
    try {
      const { getDatabase } = await import("./memory/index.js");
      const sessionChatId = `telegram:direct:${adminChatId}`;
      const telegramChatId = String(adminChatId);
      const toolContext = {
        bridge: this.bridge,
        db: getDatabase().getDb(),
        chatId: sessionChatId,
        isGroup: false,
        senderId: adminChatId,
        config: this.config,
      };

      const response = await this.agent.processMessage({
        chatId: sessionChatId,
        userMessage: cfg.prompt,
        userName: "heartbeat",
        timestamp: Date.now(),
        isGroup: false,
        toolContext,
        isHeartbeat: true,
      });

      if (
        response.content &&
        !isHeartbeatOk(response.content) &&
        !isSilentReply(response.content)
      ) {
        await this.bridge.sendMessage({
          chatId: telegramChatId,
          text: response.content,
        });
        log.info("Heartbeat: alert sent to owner");
      } else {
        log.debug("Heartbeat: NO_ACTION (suppressed)");
      }
    } catch (err) {
      log.error({ err }, "Heartbeat error");
    } finally {
      this.heartbeatRunning = false;
    }
  }

  /**
   * Stop agent subsystems (watcher, MCP, debouncer, handler, modules, bridge).
   * Called by lifecycle.stop() — do NOT call directly.
   */
  private async stopAgent(): Promise<void> {
    // Stop heartbeat timer
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    // Hook: agent:stop — fire BEFORE disconnecting anything
    if (this.hookRunner) {
      try {
        const agentStopEvent: AgentStopEvent = {
          reason: "manual",
          uptimeMs: this.startTime > 0 ? Date.now() - this.startTime : 0,
          messagesProcessed: this.messagesProcessed,
          timestamp: Date.now(),
        };
        await this.hookRunner.runObservingHook("agent:stop", agentStopEvent);
      } catch (e) {
        log.error({ err: e }, "⚠️ agent:stop hook failed");
      }
    }

    // Stop plugin watcher first
    if (this.pluginWatcher) {
      try {
        await this.pluginWatcher.stop();
      } catch (e) {
        log.error({ err: e }, "⚠️ Plugin watcher stop failed");
      }
    }

    // Close MCP connections
    if (this.mcpConnections.length > 0) {
      try {
        await closeMcpServers(this.mcpConnections);
      } catch (e) {
        log.error({ err: e }, "⚠️ MCP close failed");
      }
    }

    // Each step is isolated so a failure in one doesn't skip the rest
    if (this.debouncer) {
      try {
        await this.debouncer.flushAll();
      } catch (e) {
        log.error({ err: e }, "⚠️ Debouncer flush failed");
      }
    }

    // Drain in-flight message processing before disconnecting
    try {
      await this.messageHandler.drain();
    } catch (e) {
      log.error({ err: e }, "⚠️ Message queue drain failed");
    }

    // Flush any pending offset writes (deferred disk writes from writeOffset)
    try {
      flushOffsets();
    } catch (e) {
      log.error({ err: e }, "⚠️ Offset flush failed");
    }

    for (const mod of this.modules) {
      try {
        await mod.stop?.();
      } catch (e) {
        log.error({ err: e }, `⚠️ Module "${mod.name}" stop failed`);
      }
    }

    try {
      await this.bridge.disconnect();
    } catch (e) {
      log.error({ err: e }, "⚠️ Bridge disconnect failed");
    }
  }
}

/**
 * Start the application
 */
export async function main(configPath?: string): Promise<void> {
  let app: TeletonApp;
  try {
    app = new TeletonApp(configPath);
  } catch (error) {
    log.error(`Failed to initialize: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }

  // Handle uncaught errors - log and keep running
  process.on("unhandledRejection", (reason) => {
    log.error({ err: reason }, "⚠️ Unhandled promise rejection");
  });

  process.on("uncaughtException", (error) => {
    log.error({ err: error }, "💥 Uncaught exception");
    // Exit on uncaught exceptions - state may be corrupted
    process.exit(1);
  });

  // Handle graceful shutdown with timeout safety net
  let shutdownInProgress = false;
  const gracefulShutdown = async () => {
    if (shutdownInProgress) return;
    shutdownInProgress = true;

    const forceExit = setTimeout(() => {
      log.error("⚠️ Shutdown timed out, forcing exit");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();
    await app.stop();
    clearTimeout(forceExit);
    process.exit(0);
  };

  // eslint-disable-next-line @typescript-eslint/no-misused-promises -- signal handler is fire-and-forget
  process.on("SIGINT", gracefulShutdown);
  // eslint-disable-next-line @typescript-eslint/no-misused-promises -- signal handler is fire-and-forget
  process.on("SIGTERM", gracefulShutdown);

  await app.start();
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    log.fatal({ err: error }, "Fatal error");
    process.exit(1);
  });
}
