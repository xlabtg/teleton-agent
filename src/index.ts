import type { Api } from "telegram";
import type { PluginMessageEvent, PluginCallbackEvent } from "@teleton-agent/sdk";
import { loadConfig, getDefaultConfigPath, type Config } from "./config/index.js";
import { loadSoul } from "./soul/index.js";
import { AgentRuntime } from "./agent/runtime.js";
import { TelegramBridge, type TelegramMessage } from "./telegram/bridge.js";
import { TelegramBotBridge } from "./telegram/bot-bridge.js";
import type { ITelegramBridge } from "./telegram/bridge-interface.js";
import { isBotBridge, isUserBridge } from "./telegram/bridge-guards.js";
import { eventBus } from "./events/bus.js";
import { MessageHandler } from "./telegram/handlers.js";
import { AdminHandler } from "./telegram/admin.js";
import { MessageDebouncer } from "./telegram/debounce.js";
import { MessageDedupCache } from "./telegram/message-dedup-cache.js";
import { getDatabase, closeDatabase, initializeMemory, type MemorySystem } from "./memory/index.js";
import { createPreUpgradeBackup } from "./backup/pre-upgrade.js";
import { setKnowledgeIndexer } from "./memory/agent/knowledge.js";
import { getWalletAddress, clearKeyPair } from "./ton/wallet-service.js";
import { setTonapiKey } from "./constants/api-endpoints.js";
import { setToncenterApiKey } from "./ton/endpoint.js";
import { TELETON_ROOT, WORKSPACE_ROOT } from "./workspace/paths.js";
import {
  TELEGRAM_CONNECTION_RETRIES,
  TELEGRAM_FLOOD_SLEEP_THRESHOLD,
  SESSION_PRUNE_DAYS,
} from "./constants/limits.js";
import { join } from "path";
import { existsSync } from "fs";
import type { GocoonSupervisor, GocoonSseProxy } from "./gocoon/index.js";
import { ToolRegistry } from "./agent/tools/registry.js";
import { registerAllTools } from "./agent/tools/register-all.js";
import { type PluginModuleWithHooks } from "./agent/tools/plugin-loader.js";
import type { HookName, AgentStartEvent, AgentStopEvent } from "./sdk/hooks/types.js";
import { createHookRunner } from "./sdk/hooks/runner.js";
import type { SDKDependencies } from "./sdk/index.js";
import { type SupportedProvider, getProviderMetadata } from "./config/providers.js";
import { readRawConfig, setNestedValue, writeRawConfig } from "./config/configurable-keys.js";
import { loadModules } from "./agent/tools/module-loader.js";
import { ModulePermissions } from "./agent/tools/module-permissions.js";
import { SHUTDOWN_TIMEOUT_MS } from "./constants/timeouts.js";

const PLUGIN_START_TIMEOUT_MS = 30_000;
const PLUGIN_STOP_TIMEOUT_MS = 30_000;
import type { PluginModule, PluginContext } from "./agent/tools/types.js";
import { PluginWatcher } from "./agent/tools/plugin-watcher.js";
import { loadMcpServers, closeMcpServers, type McpConnection } from "./agent/tools/mcp-loader.js";
import { getErrorMessage } from "./utils/errors.js";
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
import type { AutonomousTaskManager } from "./autonomous/manager.js";
import { initMetrics } from "./services/metrics.js";
import { initAnalytics } from "./services/analytics.js";
import { initAuditTrail } from "./services/audit-trail.js";
import { initBehaviorTracker } from "./services/behavior-tracker.js";
import { initPredictions } from "./services/predictions.js";
import { initFeedback } from "./services/feedback/capture.js";
import { initCache } from "./services/cache.js";
import { CacheInvalidationWatcher, initPreloader } from "./services/preloader.js";
import { initAlerting } from "./services/alerting.js";
import { initAnomalyDetector } from "./services/anomaly-detector.js";
import { getEventBus } from "./services/event-bus.js";
import { getWebhookDispatcher } from "./services/webhook-dispatcher.js";
import { flushOffsets } from "./telegram/offset-store.js";
import { WorkflowScheduler } from "./services/workflow-scheduler.js";
import { TaskScheduler } from "./services/task-scheduler.js";
import { ManagedAgentService } from "./agents/service.js";
import type { ManagedAgentMode } from "./agents/types.js";
import { HeartbeatRunner } from "./heartbeat.js";
import { PluginOrchestrator } from "./plugin-orchestrator.js";

const log = createLogger("App");

interface StartAgentKeepingDashboardAliveDeps {
  lifecycle: Pick<AgentLifecycle, "start">;
  startAgent: () => Promise<void>;
  /**
   * When true, swallow start errors so the WebUI / Management API stay up.
   * The lifecycle has already transitioned to "stopped" with the error
   * attached, so /api/status (and the WebUI) will still surface it.
   */
  keepAliveOnFailure: boolean;
  log: Pick<ReturnType<typeof createLogger>, "error">;
}

/**
 * Run lifecycle.start(startAgent). If `keepAliveOnFailure` is true and the
 * agent fails to start (invalid Telegram credentials, MTProto proxy
 * unreachable, no network connectivity, …), log the error and return
 * normally so the WebUI / Management API remain available for the user
 * to recover. Otherwise propagate the error.
 *
 * Regression guard for issue #469: previously a Telegram failure during
 * boot crashed the whole process, including the dashboard the user needs
 * to fix the problem.
 */
export async function startAgentKeepingDashboardAlive(
  deps: StartAgentKeepingDashboardAliveDeps
): Promise<void> {
  if (!deps.keepAliveOnFailure) {
    await deps.lifecycle.start(deps.startAgent);
    return;
  }

  try {
    await deps.lifecycle.start(deps.startAgent);
  } catch (error) {
    deps.log.error(
      { err: error },
      "Agent failed to start — WebUI/API remain available so you can fix the configuration"
    );
  }
}

export class TeletonApp {
  private config: Config;
  private agent: AgentRuntime;
  private bridge: ITelegramBridge;
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
  private cacheInvalidationWatcher: CacheInvalidationWatcher | null = null;
  private gocoonSupervisor: GocoonSupervisor | null = null;
  private gocoonProxy: GocoonSseProxy | null = null;
  private mcpConnections: McpConnection[] = [];
  private callbackHandlerRegistered = false;
  private messageHandlersRegistered = false;
  private scheduledTaskMessageHandlerRegistered = false;
  private scheduledTaskTriggerMessages = new MessageDedupCache();
  private lifecycle = new AgentLifecycle();
  private hookRunner?: ReturnType<typeof createHookRunner>;
  private userHookEvaluator: UserHookEvaluator | null = null;
  private startTime: number = 0;
  private messagesProcessed: number = 0;
  private heartbeatRunner: HeartbeatRunner;
  private workflowScheduler: WorkflowScheduler | null = null;
  private taskScheduler: TaskScheduler | null = null;
  private autonomousManager: AutonomousTaskManager | null = null;
  private agentManager: ManagedAgentService;
  private readonly agentMode: ManagedAgentMode;

  private configPath: string;

  /**
   * Stop the supervised gocoon runner + SSE proxy. A withdraw refuses to run
   * while the runner is active, so the Gocoon page calls this first. The agent
   * stays up; gocoon inference is unavailable until the next restart.
   */
  stopGocoonRunner(): boolean {
    let stopped = false;
    if (this.gocoonProxy) {
      try {
        this.gocoonProxy.stop();
      } catch (error: unknown) {
        log.error({ err: error }, "gocoon sse-proxy stop failed");
      }
      this.gocoonProxy = null;
      stopped = true;
    }
    if (this.gocoonSupervisor) {
      try {
        this.gocoonSupervisor.stop();
      } catch (error: unknown) {
        log.error({ err: error }, "gocoon supervisor stop failed");
      }
      this.gocoonSupervisor = null;
      stopped = true;
    }
    return stopped;
  }

  constructor(configPath?: string) {
    this.configPath = configPath ?? getDefaultConfigPath();
    this.config = loadConfig(this.configPath);
    this.agentMode = process.env.TELETON_MANAGED_AGENT_MODE === "bot" ? "bot" : "personal";

    if (this.agentMode === "bot" && this.config.deals.enabled) {
      this.config.deals.enabled = false;
      log.info("Bot-mode runtime: disabled deals module to avoid bot token polling conflicts");
    }

    this.agentManager = new ManagedAgentService({ primaryConfigPath: this.configPath });

    // Wire YAML logging config to pino (H2 fix)
    initLoggerFromConfig(this.config.logging);
    initCache(this.config.cache);

    if (this.config.tonapi_key) {
      setTonapiKey(this.config.tonapi_key);
    }
    if (this.config.toncenter_api_key) {
      setToncenterApiKey(this.config.toncenter_api_key);
    }

    const soul = loadSoul();

    this.toolRegistry = new ToolRegistry(this.config.telegram.mode);
    registerAllTools(this.toolRegistry);

    this.agent = new AgentRuntime(this.config, soul, this.toolRegistry);

    const mtprotoProxies =
      this.config.mtproto?.enabled && this.config.mtproto.proxies.length > 0
        ? this.config.mtproto.proxies
        : undefined;

    this.bridge =
      this.agentMode === "bot"
        ? new TelegramBotBridge({
            apiId: this.config.telegram.api_id,
            apiHash: this.config.telegram.api_hash,
            phone: this.config.telegram.phone,
            botToken: this.requireBotToken(),
            sessionPath: join(TELETON_ROOT, "telegram_session.txt"),
            connectionRetries: TELEGRAM_CONNECTION_RETRIES,
            autoReconnect: true,
            floodSleepThreshold: TELEGRAM_FLOOD_SLEEP_THRESHOLD,
            mtprotoProxies,
          })
        : new TelegramBridge({
            apiId: this.config.telegram.api_id,
            apiHash: this.config.telegram.api_hash,
            phone: this.config.telegram.phone,
            sessionPath: join(TELETON_ROOT, "telegram_session.txt"),
            connectionRetries: TELEGRAM_CONNECTION_RETRIES,
            autoReconnect: true,
            floodSleepThreshold: TELEGRAM_FLOOD_SLEEP_THRESHOLD,
            mtprotoProxies,
          });
    this.heartbeatRunner = new HeartbeatRunner(this.agent, this.bridge, this.config);

    const embeddingProvider = this.config.embedding.provider;
    this.memory = initializeMemory({
      database: {
        path: join(TELETON_ROOT, "memory.db"),
        enableVectorSearch: embeddingProvider !== "none",
        // vectorDimensions is derived from the active embedder in
        // initializeMemory so vec tables always match the provider's output.
        onBeforeMigrate: (from, to) => createPreUpgradeBackup(from, to),
      },
      embeddings: {
        provider: embeddingProvider,
        model: this.config.embedding.model,
        apiKey: embeddingProvider === "anthropic" ? this.config.agent.api_key : undefined,
      },
      vectorMemory: this.config.vector_memory,
      memory: this.config.memory,
      feed: this.config.feed,
      temporalContext: this.config.temporal_context,
      autonomous: this.config.autonomous,
      workspaceDir: WORKSPACE_ROOT,
    });

    setKnowledgeIndexer(this.memory.knowledge);

    const db = getDatabase().getDb();

    // Initialize analytics and metrics singletons early so agent runtime can record data
    const eventBus = getEventBus(db, {
      enabled: this.config.event_bus.enabled,
      maxLogEntries: this.config.event_bus.max_log_entries,
    });
    getWebhookDispatcher(db, {
      enabled: this.config.webhooks.enabled,
      defaultMaxRetries: this.config.webhooks.default_max_retries,
      deliveryTimeoutMs: this.config.webhooks.delivery_timeout_ms,
    });
    this.lifecycle.on("stateChange", (event) => {
      void eventBus
        .publish({
          type: "agent.state.changed",
          source: "agent-lifecycle",
          payload: {
            state: event.state,
            error: event.error ?? null,
          },
        })
        .catch((err: unknown) => {
          log.warn({ err }, "Failed to publish lifecycle event");
        });
    });
    initMetrics(db);
    initAnalytics(db);
    initAuditTrail(db, { maxPayloadBytes: this.config.audit_trail.payload_max_bytes });
    initBehaviorTracker(db, { historyLimit: this.config.predictions.history_limit });
    initPredictions(db);
    initFeedback(db, {
      correctionWindowSeconds: this.config.feedback.correction_window_seconds,
      acceptanceDelaySeconds: this.config.feedback.acceptance_delay_seconds,
    });
    const alerting = initAlerting(db, {
      config: this.config.anomaly_detection,
      telegram: {
        chatIds: this.config.telegram.admin_ids.map(String),
        sendMessage: async (chatId, text) => {
          await this.bridge.sendMessage({ chatId, text });
        },
      },
    });
    initAnomalyDetector(db, this.config.anomaly_detection, alerting);

    this.userHookEvaluator = new UserHookEvaluator(db);
    this.agent.setUserHookEvaluator(this.userHookEvaluator);

    this.sdkDeps = { bridge: this.bridge };

    this.modules = loadModules(this.toolRegistry, this.config, db);
    this.builtinModuleCount = this.modules.length;

    const modulePermissions = new ModulePermissions(db);
    this.toolRegistry.setPermissions(modulePermissions);

    this.toolCount = this.toolRegistry.enabledCount;
    this.messageHandler = new MessageHandler(
      this.bridge,
      this.config.telegram,
      this.agent,
      db,
      this.memory.embedder,
      getDatabase().isVectorSearchReady(),
      this.config,
      {
        embedder: this.memory.embedder,
        vectorEnabled: getDatabase().isVectorSearchReady(),
        vectorStore: this.memory.vectorStore,
      }
    );

    this.adminHandler = new AdminHandler(
      this.bridge,
      this.config.telegram,
      this.agent,
      this.configPath,
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

  getBridge(): ITelegramBridge {
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

  getNetworkConfig() {
    return this.config.network;
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
    this.memory.scheduler.stop();
    try {
      closeDatabase();
    } catch (error: unknown) {
      log.error({ err: error }, "Database close failed");
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

    // Shared manager so WebUI and Management API drive the same task queue.
    // Stored on the instance so stopAgent() can halt its loops — otherwise
    // autonomous tasks keep writing to SQLite after shutdown (AUDIT-C2).
    if (this.config.webui.enabled || this.config.api?.enabled) {
      if (this.config.telegram.admin_ids.length === 0) {
        // Explicit skip with a clear warning instead of starting an autonomous
        // manager whose tools would silently fail the admin-only check
        // (see AUDIT-H6 / issue #270). WebUI and API will run without an
        // autonomous task queue until admin_ids is configured.
        log.warn(
          "Autonomous manager disabled: config.telegram.admin_ids is empty. " +
            "Add at least one admin user id to enable autonomous tasks."
        );
      } else {
        const { createAutonomousManager } = await import("./autonomous/integration.js");
        this.autonomousManager = createAutonomousManager({
          agent: this.agent,
          toolRegistry: this.toolRegistry,
          bridge: this.bridge,
          db: this.memory.db,
        });
        // Resume tasks that were "running" when the agent last stopped so a
        // server restart doesn't leave them stuck forever.
        this.autonomousManager.restoreInterruptedTasks().catch((err: unknown) => {
          log.warn({ err }, "Failed to restore interrupted autonomous tasks");
        });
      }
    }

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
          networkConfig: this.config.network,
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
          autonomousManager: this.autonomousManager ?? undefined,
          workflowScheduler: () => this.workflowScheduler,
          agentManager: this.agentManager,
          gocoonControl: {
            stopRunner: () => this.stopGocoonRunner(),
          },
        });
        await this.webuiServer.start();
      } catch (error) {
        log.error({ err: error }, "Failed to start WebUI server");
        log.warn("Continuing without WebUI...");
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
            networkConfig: this.config.network,
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
            autonomousManager: this.autonomousManager,
            workflowScheduler: () => this.workflowScheduler,
            agentManager: this.agentManager,
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

    await startAgentKeepingDashboardAlive({
      lifecycle: this.lifecycle,
      startAgent: () => this.startAgent(),
      keepAliveOnFailure: this.config.webui.enabled || (this.config.api?.enabled ?? false),
      log,
    });

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
    const builtinNames = this.modules.map((m) => m.name);
    const moduleNames = this.modules
      .filter((m) => m.tools(this.config).length > 0)
      .map((m) => m.name);

    // Load plugins, MCP servers, and configure tool registry
    this.mcpConnections =
      Object.keys(this.config.mcp.servers).length > 0 ? await loadMcpServers(this.config.mcp) : [];
    const orchestrator = new PluginOrchestrator(
      this.toolRegistry,
      this.config,
      this.sdkDeps,
      this.memory.embedder
    );
    const {
      pluginNames,
      pluginToolCount,
      mcpServerNames,
      hookRegistry,
      externalModules,
      toolCount,
    } = await orchestrator.loadAll(builtinNames, moduleNames, this.mcpConnections);
    for (const mod of externalModules) this.modules.push(mod);
    if (pluginToolCount > 0 || toolCount !== this.toolCount) {
      this.toolCount = toolCount;
    }

    // Initialize tool config from database
    this.toolRegistry.loadConfigFromDB(getDatabase().getDb());
    initPreloader({
      db: getDatabase().getDb(),
      config: this.config,
      toolRegistry: this.toolRegistry,
    });

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
    const registeredToolCount = this.toolRegistry.count;
    const disabledToolCount = registeredToolCount - this.toolCount;
    const countSummary =
      disabledToolCount > 0
        ? `${this.toolCount}/${registeredToolCount} tools active`
        : `${this.toolCount} tools loaded`;
    log.info(
      `🔌 ${countSummary} (${allNames.join(", ")})${pluginToolCount > 0 ? ` — ${pluginToolCount} from plugins` : ""}`
    );
    if (providerMeta.toolLimit !== null && this.toolCount > providerMeta.toolLimit) {
      log.warn(
        `⚠️ Active tool count (${this.toolCount}) exceeds ${providerMeta.displayName} limit (${providerMeta.toolLimit})`
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
    const vectorStatus = await this.memory.vectorStore.logStatus();
    if (
      vectorStatus.mode === "online" &&
      typeof vectorStatus.indexDimension === "number" &&
      vectorStatus.indexDimension > 0 &&
      this.memory.embedder.dimensions > 0 &&
      vectorStatus.indexDimension !== this.memory.embedder.dimensions
    ) {
      log.warn(
        `Semantic Memory: embedding dimension ${this.memory.embedder.dimensions} ` +
          `(${this.memory.embedder.id}/${this.memory.embedder.model}) does not match ` +
          `Upstash Vector index dimension ${vectorStatus.indexDimension}. Upstash will reject ` +
          `vector upserts. Reprovision the index or switch the embedding provider to align dimensions.`
      );
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
      const indexedCount = await toolIndex.indexAll(this.toolRegistry.getEnabledTools());
      log.info(`Tool RAG: ${indexedCount} tools indexed (${Date.now() - t0}ms)`);
    }

    // Initialize context builder for RAG search in agent
    this.agent.initializeContextBuilder(
      this.memory.embedder,
      db.isVectorSearchReady(),
      this.memory.vectorStore
    );

    // Register provider-specific models (gocoon / local LLM)
    await this.initializeProviders();

    // Connect to Telegram
    await this.bridge.connect();
    if (!this.bridge.isAvailable()) {
      throw new Error("Failed to connect to Telegram");
    }
    eventBus.emit("bridge:connected", { mode: this.config.telegram.mode });

    // Resolve owner name/username from Telegram if not already set
    if (this.agentMode === "personal") {
      await this.resolveOwnerInfo();
    }

    // Set own user ID in handler after connection
    const ownUserId = this.bridge.getOwnUserId();
    if (ownUserId) {
      this.messageHandler.setOwnUserId(ownUserId.toString());
    }

    const username = await this.bridge.getUsername();
    const walletAddress = getWalletAddress();

    // Set up inline router and rate limiter
    const inlineRouter = new InlineRouter();
    const rateLimiter = new PluginRateLimiter();

    // User mode: install DealBot middleware before modules start
    if (isUserBridge(this.bridge)) {
      setBotPreMiddleware(inlineRouter.middleware());
    }

    // Start module background jobs (after bridge connect)
    const pluginContext = await this.startModules();

    // Wire mode-specific SDK deps, handlers, and polling
    const firstStart = !this.messageHandlersRegistered;
    if (isBotBridge(this.bridge)) {
      this.wireBotMode(inlineRouter, rateLimiter, firstStart);
    } else {
      this.wireUserMode(inlineRouter, rateLimiter, firstStart);
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

    this.cacheInvalidationWatcher = new CacheInvalidationWatcher(this.configPath);
    this.cacheInvalidationWatcher.start();

    // Display startup summary
    log.info(`SOUL.md loaded`);
    log.info(`Knowledge: ${indexResult.indexed} files, ${ftsResult.knowledge} chunks indexed`);
    log.info(`Telegram: @${username} connected`);
    log.info(`TON Blockchain: connected`);
    if (this.config.tonapi_key) {
      log.info(`TonAPI key configured`);
    }
    log.info(`DEXs: STON.fi, DeDust connected`);
    log.info(`Wallet: ${walletAddress || "not configured"}`);
    log.info(`Model: ${provider}/${this.config.agent.model}`);
    log.info(`Admins: ${this.config.telegram.admin_ids.join(", ")}`);
    log.info(
      `Policy: DM ${this.config.telegram.dm_policy}, Groups ${this.config.telegram.group_policy}, Debounce ${this.config.telegram.debounce_ms}ms\n`
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
        provider,
        model: this.config.agent.model,
        pluginCount: pluginNames.length,
        toolCount: this.toolCount,
        timestamp: Date.now(),
      };
      await this.hookRunner.runObservingHook("agent:start", agentStartEvent);
    }

    // Start workflow scheduler
    this.workflowScheduler = new WorkflowScheduler(getDatabase().getDb(), this.bridge);
    this.workflowScheduler.start();
    const scheduler = this.workflowScheduler;
    this.agent.setOnToolCompleteCallback((_toolName: string) => {
      void scheduler.fireEvent("tool.complete").catch((err: unknown) => {
        log.warn({ err }, "Workflow tool.complete event failed");
      });
    });
    void this.workflowScheduler.fireEvent("agent.start").catch((err: unknown) => {
      log.warn({ err }, "Workflow agent.start event failed");
    });

    // Start DB-backed task scheduler — picks up tasks whose scheduled_for has
    // elapsed and executes them, independent of any Telegram delivery.
    this.taskScheduler = new TaskScheduler({
      db: getDatabase().getDb(),
      executeTask: (task) => this.executeScheduledTaskFromScheduler(task),
    });
    this.taskScheduler.start();

    // Start heartbeat timer if enabled
    if (this.config.heartbeat.enabled) {
      const adminChatId = this.config.telegram.admin_ids[0];
      if (adminChatId) {
        this.heartbeatRunner.start(adminChatId, this.config.heartbeat.interval_ms);
      } else {
        // Explicit warning instead of a silent skip (AUDIT-H6 / issue #270):
        // heartbeat is enabled in the config but has nowhere to send alerts.
        log.warn(
          "Heartbeat enabled but config.telegram.admin_ids is empty — " +
            "heartbeat timer will not start. Configure at least one admin id to receive alerts."
        );
      }
    }

    // Initialize message debouncer
    this.debouncer = new MessageDebouncer(
      { debounceMs: this.config.telegram.debounce_ms },
      (msg) => {
        if (!msg.isGroup) return false;
        if (msg.text.startsWith("/")) {
          const adminCmd = this.adminHandler.parseCommand(msg.text);
          if (adminCmd && this.adminHandler.isAdmin(msg.senderId)) return false;
        }
        return true;
      },
      async (messages) => {
        for (const message of messages) {
          await this.handleSingleMessage(message);
        }
      },
      (error, messages) => {
        log.error({ err: error }, `Error processing batch of ${messages.length} messages`);
      }
    );

    // Register common message handler ONCE (survive agent restart via WebUI)
    if (!this.messageHandlersRegistered) {
      const ownUserId = this.bridge.getOwnUserId();
      if (!this.scheduledTaskMessageHandlerRegistered && ownUserId) {
        this.bridge.onNewMessage(
          async (message) => {
            try {
              await this.handleScheduledTaskTrigger(message);
            } catch (error) {
              log.error({ err: error }, "Error handling scheduled task trigger");
            }
          },
          {
            incoming: true,
            chats: [ownUserId.toString()],
          }
        );
        this.scheduledTaskMessageHandlerRegistered = true;
      }

      this.bridge.onNewMessage(async (message) => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- debouncer always initialized before handlers register
          await this.debouncer!.enqueue(message);
        } catch (error) {
          log.error({ err: error }, "Error enqueueing message");
        }
      });
      this.messageHandlersRegistered = true;
    }
  }

  // ─── Mode-specific wiring ──────────────────────────────────────────────

  /**
   * Wire bot-mode SDK deps, callback handler, and Grammy polling.
   */
  private wireBotMode(
    inlineRouter: InlineRouter,
    rateLimiter: PluginRateLimiter,
    firstStart: boolean
  ): void {
    this.sdkDeps.inlineRouter = inlineRouter;
    this.sdkDeps.gramjsBot = null;
    this.sdkDeps.rateLimiter = rateLimiter;
    log.info("Bot mode: using main Grammy bridge (no DealBot)");

    if (isBotBridge(this.bridge)) {
      this.bridge.setCallbackHandler((msg) => {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- debouncer initialized before wireBotMode
        void this.debouncer!.enqueue(msg);
      });
      if (firstStart) {
        this.bridge.onGuestMessage(async (msg) => {
          if (!this.config.telegram.guest_mode) return "";
          if (this.adminHandler.isPaused()) return "";
          const response = await this.agent.processMessage({
            chatId: `telegram:guest:${msg.chatId}`,
            userMessage: msg.text,
            userName: msg.senderFirstName,
            senderUsername: msg.senderUsername,
            isGroup: true,
            timestamp: msg.timestamp.getTime(),
            messageId: msg.id,
            toolContext: {
              bridge: this.bridge,
              db: getDatabase().getDb(),
              senderId: msg.senderId,
              config: this.config,
            },
          });
          return response.content;
        });
        this.bridge.startPolling();
      }
      void this.bridge.syncCommands();
    }
  }

  /**
   * Wire user-mode SDK deps from DealBot and register service message handler.
   */
  private wireUserMode(
    inlineRouter: InlineRouter,
    rateLimiter: PluginRateLimiter,
    firstStart: boolean
  ): void {
    const activeDealBot = getDealBot();
    if (activeDealBot) {
      this.sdkDeps.inlineRouter = inlineRouter;
      this.sdkDeps.gramjsBot = activeDealBot.getGramJSBot();
      this.sdkDeps.grammyBot = activeDealBot.getBot();
      this.sdkDeps.rateLimiter = rateLimiter;
      inlineRouter.setGramJSBot(activeDealBot.getGramJSBot());
      log.info("Bot SDK: inline router installed");
    }

    if (firstStart && isUserBridge(this.bridge)) {
      this.bridge.onServiceMessage(async (message) => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- debouncer always initialized before handlers register
          await this.debouncer!.enqueue(message);
        } catch (error) {
          log.error({ err: error }, "Error enqueueing service message");
        }
      });
    }
  }

  /**
   * Register provider-specific models (gocoon / local LLM).
   */
  private async initializeProviders(): Promise<void> {
    if (this.config.agent.provider === "gocoon") {
      const port = this.config.gocoon?.port ?? 10000;
      const autoStart = this.config.gocoon?.auto_start ?? true;
      try {
        if (autoStart) {
          const {
            ensureGocoonBinaries,
            GocoonSupervisor,
            runnerBaseUrl,
            clientConfigPath,
            walletInfo,
          } = await import("./gocoon/index.js");
          if (!existsSync(clientConfigPath())) {
            throw new Error(
              "gocoon is not set up yet; run `teleton gocoon init` (or use the Gocoon page) first"
            );
          }
          await ensureGocoonBinaries();
          // Opening the channel needs free TON on-chain; fail clearly instead of a health timeout.
          const wallet = await walletInfo();
          if (wallet.balanceNano < 2_000_000_000n) {
            throw new Error(
              `COCOON wallet has ${wallet.balanceTon} TON; gocoon needs at least 2 TON free to open the channel. ` +
                `Fund ${wallet.fundAddress} (Gocoon page or \`teleton gocoon init\`), then restart.`
            );
          }
          this.gocoonSupervisor = new GocoonSupervisor({
            configPath: clientConfigPath(),
            healthUrl: `${runnerBaseUrl(port)}/v1/models`,
            startGraceMs: 60_000, // first on-chain channel registration can take ~60s
          });
          await this.gocoonSupervisor.start();
          log.info(`Gocoon runner started on port ${port}`);
        }
        // pi-ai always streams and only parses SSE; the gocoon runner returns a
        // single JSON document. Front the runner with a local proxy that frames
        // its reply as SSE so streaming clients parse it. Keeps gocoon untouched.
        const { GocoonSseProxy } = await import("./gocoon/index.js");
        this.gocoonProxy = new GocoonSseProxy({ runnerPort: port });
        await this.gocoonProxy.start();
        const { registerGocoonModels } = await import("./agent/client.js");
        const models = await registerGocoonModels(this.gocoonProxy.port);
        if (models.length === 0) {
          throw new Error(`No models found on port ${port}`);
        }
        log.info(
          `Gocoon ready: ${models.length} model(s) (runner ${port}, sse-proxy ${this.gocoonProxy.port})`
        );
      } catch (error: unknown) {
        // Non-fatal: keep the agent and WebUI alive so gocoon can be installed and
        // funded from the Gocoon page, then a restart activates it.
        log.warn(`Gocoon not ready: ${getErrorMessage(error)}`);
        log.warn(
          "Agent is up but can't chat until gocoon is funded. Open the Gocoon page (or run `teleton gocoon init`), then restart."
        );
      }
    }

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
      } catch (error: unknown) {
        log.error(
          `Local LLM server unavailable at ${this.config.agent.base_url}: ${getErrorMessage(error)}`
        );
        log.error("Start the LLM server first (e.g. ollama serve)");
        throw new Error(`Local LLM server unavailable: ${getErrorMessage(error)}`);
      }
    }
  }

  /**
   * Start module background jobs with timeout. Skips deals module in bot mode.
   */
  private async startModules(): Promise<PluginContext> {
    const moduleDb = getDatabase().getDb();
    const pluginContext: PluginContext = {
      bridge: this.bridge,
      db: moduleDb,
      config: this.config,
    };
    const startedModules: typeof this.modules = [];
    try {
      for (const mod of this.modules) {
        if (isBotBridge(this.bridge) && mod.name === "deals") {
          log.info("Bot mode: skipping deals module (uses separate Grammy polling)");
          continue;
        }
        await Promise.race([
          mod.start?.(pluginContext),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`Plugin "${mod.name}" start() timed out after 30s`)),
              PLUGIN_START_TIMEOUT_MS
            )
          ),
        ]);
        startedModules.push(mod);
      }
    } catch (error) {
      log.error({ err: error }, "Module start failed, cleaning up started modules");
      for (const mod of startedModules.reverse()) {
        try {
          await Promise.race([
            mod.stop?.(),
            new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new Error(`Plugin "${mod.name}" stop() timed out after 30s`)),
                PLUGIN_STOP_TIMEOUT_MS
              )
            ),
          ]);
        } catch (innerError: unknown) {
          log.error({ err: innerError }, `Module "${mod.name}" cleanup failed`);
        }
      }
      throw error;
    }
    return pluginContext;
  }

  /**
   * Resolve owner name and username from Telegram API if not already configured.
   * Persists resolved values to the config file so this only happens once.
   */
  private async resolveOwnerInfo(): Promise<void> {
    try {
      if (this.agentMode !== "personal") {
        return;
      }

      // Skip if both are already set
      if (this.config.telegram.owner_name && this.config.telegram.owner_username) {
        return;
      }

      // Can't resolve without an owner ID
      if (!this.config.telegram.owner_id) {
        return;
      }

      if (!isUserBridge(this.bridge)) return;
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
        log.info(`Owner resolved: ${displayName}${displayUsername}`);
      }
    } catch (error) {
      log.warn(`Could not resolve owner info: ${getErrorMessage(error)}`);
    }
  }

  /**
   * Handle a single message (extracted for debouncer callback)
   */
  private async handleSingleMessage(message: TelegramMessage): Promise<void> {
    this.messagesProcessed++;
    try {
      if (await this.handleScheduledTaskTrigger(message)) {
        return;
      }

      // Check if this is an admin command
      const adminCmd = this.adminHandler.parseCommand(message.text);
      const commandAllowed = adminCmd
        ? this.adminHandler.isCommandAllowed(message.senderId, message.chatId)
        : false;
      if (adminCmd && commandAllowed) {
        if (!this.adminHandler.isPrivilegedCommandAllowed(adminCmd.command, message.senderId)) {
          await this.bridge.sendMessage({
            chatId: message.chatId,
            text: "⛔ Admin access required",
            replyToId: message.id,
          });
          return;
        }
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
            `Task: ${JSON.stringify(taskDescription)}`;
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

  private isScheduledTaskTrigger(message: TelegramMessage): boolean {
    if (!message.text.startsWith("[TASK:")) {
      return false;
    }

    const ownUserId = this.bridge.getOwnUserId();
    if (!ownUserId) {
      return false;
    }

    const ownUserIdText = ownUserId.toString();
    return message.chatId === ownUserIdText || message.senderId === Number(ownUserId);
  }

  private async handleScheduledTaskTrigger(message: TelegramMessage): Promise<boolean> {
    if (!this.isScheduledTaskTrigger(message)) {
      return false;
    }

    const dedupKey = `${message.chatId}:${message.id}`;
    if (this.scheduledTaskTriggerMessages.has(dedupKey)) {
      return true;
    }
    this.scheduledTaskTriggerMessages.add(dedupKey);

    log.info(
      { chatId: message.chatId, messageId: message.id },
      "Scheduled task trigger detected in Saved Messages"
    );

    await this.handleScheduledTask(message);
    return true;
  }

  /**
   * Handle scheduled task message
   */
  private async handleScheduledTask(message: TelegramMessage): Promise<void> {
    // Hoist all dynamic imports to top of function
    const { getTaskStore } = await import("./memory/agent/tasks.js");
    const { TaskDependencyResolver } = await import("./telegram/task-dependency-resolver.js");
    const { getDatabase } = await import("./memory/index.js");

    const db = getDatabase().getDb();
    const taskStore = getTaskStore(db);

    // Extract task ID from format: [TASK:uuid] description
    const match = message.text.match(/^\[TASK:([^\]]+)\]/);
    if (!match) {
      log.warn(`Invalid task format: ${message.text}`);
      await this.deleteScheduledTaskTriggerMessage(message);
      return;
    }

    const taskId = match[1];
    let shouldDeleteTriggerMessage = false;

    try {
      const task = taskStore.getTask(taskId);

      if (!task) {
        log.warn(`Task ${taskId} not found in database`);
        shouldDeleteTriggerMessage = true;
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
        shouldDeleteTriggerMessage = true;
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

      // Execute via the shared core (claims the task, runs the agent,
      // persists the result, fires dependents, reschedules recurrence).
      await this.executeTaskRecord(task, {
        chatId: message.chatId,
        isGroup: message.isGroup,
        senderId: message.senderId,
        messageId: message.id,
        timestamp: message.timestamp.getTime(),
      });
      shouldDeleteTriggerMessage = true;
    } catch (error) {
      log.error({ err: error }, "Error handling scheduled task");
      shouldDeleteTriggerMessage = true;

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
    } finally {
      if (shouldDeleteTriggerMessage) {
        await this.deleteScheduledTaskTriggerMessage(message);
      }
    }
  }

  /**
   * Shared execution core for a single scheduled task record.
   *
   * Atomically claims the task (preventing double execution when both the Saved
   * Messages `[TASK:]` trigger and the DB-backed {@link TaskScheduler} fire),
   * runs it through the agent loop, persists the result, fires dependent tasks,
   * and reschedules recurring tasks.
   *
   * @returns true if this caller claimed and executed the task; false if it was
   *          already claimed/terminal and skipped.
   * @throws on execution error so the caller can mark the task failed.
   */
  private async executeTaskRecord(
    task: Task,
    ctx: {
      chatId: string;
      isGroup?: boolean;
      senderId?: number;
      messageId?: number;
      timestamp?: number;
    }
  ): Promise<boolean> {
    const { getTaskStore } = await import("./memory/agent/tasks.js");
    const { executeScheduledTask } = await import("./telegram/task-executor.js");
    const { TaskDependencyResolver } = await import("./telegram/task-dependency-resolver.js");
    const { getDatabase } = await import("./memory/index.js");

    const db = getDatabase().getDb();
    const taskStore = getTaskStore(db);

    // Atomic claim — only one caller can flip pending → in_progress.
    if (!taskStore.claimTask(task.id)) {
      log.info(`⏭️ Task ${task.id} already claimed or not pending, skipping`);
      return false;
    }

    // Get parent task results for context
    const parentResults = taskStore.getParentResults(task.id);

    // Build tool context
    const toolContext = {
      bridge: this.bridge,
      db,
      chatId: ctx.chatId,
      isGroup: ctx.isGroup ?? false,
      senderId: ctx.senderId ?? 0,
      config: this.config,
    };

    // Get tool registry from agent runtime
    const toolRegistry = this.agent.getToolRegistry();
    if (!toolRegistry) {
      log.warn(`⏭️ Task ${task.id} skipped: tool registry not initialized`);
      return false;
    }

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
      chatId: ctx.chatId,
      userMessage: agentPrompt,
      userName: "self-scheduled-task",
      timestamp: ctx.timestamp ?? Date.now(),
      isGroup: false,
      toolContext,
      messageId: ctx.messageId,
      taskId: task.id,
    });

    // Send agent response
    if (response.content && response.content.trim().length > 0) {
      await this.bridge.sendMessage({
        chatId: ctx.chatId,
        text: response.content,
        replyToId: ctx.messageId,
      });
    }

    // Mark task as done if agent responded successfully
    taskStore.completeTask(task.id, response.content);

    log.info(`✅ Executed scheduled task ${task.id}: ${task.description}`);

    // Initialize dependency resolver if needed
    if (!this.dependencyResolver) {
      this.dependencyResolver = new TaskDependencyResolver(taskStore, this.bridge);
    }

    // Trigger any dependent tasks
    await this.dependencyResolver.onTaskComplete(task.id);

    // Reschedule recurring tasks
    if (task.recurrenceInterval && task.recurrenceInterval > 0) {
      await this.rescheduleRecurringTask(task, taskStore);
    }

    return true;
  }

  /**
   * Execute a task picked up by the DB-backed {@link TaskScheduler}.
   *
   * Unlike the Saved Messages trigger there is no incoming message — results go
   * to the owner's Saved Messages chat. On failure the task is marked failed and
   * the failure cascades to dependents.
   */
  private async executeScheduledTaskFromScheduler(task: Task): Promise<void> {
    const { getTaskStore } = await import("./memory/agent/tasks.js");
    const { TaskDependencyResolver } = await import("./telegram/task-dependency-resolver.js");
    const { getDatabase } = await import("./memory/index.js");

    const ownId = this.bridge.getOwnUserId();
    const chatId = ownId !== undefined ? String(ownId) : "";
    const senderId = ownId !== undefined ? Number(ownId) : 0;

    try {
      await this.executeTaskRecord(task, {
        chatId,
        isGroup: false,
        senderId,
        timestamp: Date.now(),
      });
    } catch (error) {
      log.error({ err: error, taskId: task.id }, "Scheduler failed to execute task");
      try {
        const db = getDatabase().getDb();
        const taskStore = getTaskStore(db);
        taskStore.failTask(task.id, getErrorMessage(error));
        if (!this.dependencyResolver) {
          this.dependencyResolver = new TaskDependencyResolver(taskStore, this.bridge);
        }
        await this.dependencyResolver.onTaskFail(task.id);
      } catch {
        // Ignore if we can't update task
      }
    }
  }

  private async deleteScheduledTaskTriggerMessage(message: TelegramMessage): Promise<void> {
    try {
      const { Api } = await import("telegram");
      const gramJsClient = this.bridge.getClient().getClient();
      await gramJsClient.invoke(
        new Api.messages.DeleteMessages({
          id: [message.id],
          revoke: true,
        })
      );
      log.info(
        { chatId: message.chatId, messageId: message.id },
        "Deleted scheduled task trigger message"
      );
    } catch (error) {
      log.warn(
        { err: error, chatId: message.chatId, messageId: message.id },
        "Failed to delete scheduled task trigger message"
      );
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
      const { computeNextRecurrence } = await import("./services/task-scheduler.js");

      // Stop recurring if recurrenceUntil has passed (or interval is invalid)
      const nextRunDate = computeNextRecurrence(completedTask);
      if (!nextRunDate) {
        log.info(
          `⏹️ Recurrence for task "${completedTask.description}" has ended (recurrenceUntil passed)`
        );
        return;
      }

      const nextRunAt = Math.floor(nextRunDate.getTime() / 1000);

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
            } catch (error: unknown) {
              log.error(`❌ [${mod.name}] onMessage error: ${getErrorMessage(error)}`);
            }
          }
        }
      },
    ]);

    const hookCount = this.modules.filter((m) => (m as PluginModuleWithHooks).onMessage).length;
    if (hookCount > 0) {
      log.info(`${hookCount} plugin onMessage hook(s) registered`);
    }

    const dispatchCallbackEvent = async (event: PluginCallbackEvent): Promise<void> => {
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
    };

    // Callback query handler: register ONCE, dispatch dynamically
    if (!this.callbackHandlerRegistered) {
      if (this.agentMode === "bot" && this.bridge instanceof TelegramBotBridge) {
        const botBridge = this.bridge;
        botBridge.onCallbackQuery(async (update) => {
          const parts = update.data.split(":");
          const action = parts[0];
          const params = parts.slice(1);

          const answer = async (text?: string, alert = false): Promise<void> => {
            try {
              await botBridge.answerCallbackQuery(update.queryId, { message: text, alert });
            } catch (err) {
              log.error(
                `❌ Failed to answer bot callback query: ${err instanceof Error ? err.message : err}`
              );
            }
          };

          await dispatchCallbackEvent({
            data: update.data,
            action,
            params,
            chatId: update.chatId,
            messageId: update.messageId,
            userId: update.userId,
            answer,
          });
        });
      } else {
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

          await dispatchCallbackEvent({
            data,
            action,
            params,
            chatId,
            messageId,
            userId,
            answer,
          });
        });
      }
      this.callbackHandlerRegistered = true;

      const cbCount = this.modules.filter(
        (m) => (m as PluginModuleWithHooks).onCallbackQuery
      ).length;
      if (cbCount > 0) {
        log.info(`${cbCount} plugin onCallbackQuery hook(s) registered`);
      }
    } else if (!this.callbackHandlerRegistered && this.bridge.getMode() === "bot") {
      // In bot mode, callback queries are handled by GrammyBotBridge's callback_query:data handler
      // TODO: dispatch plugin onCallbackQuery hooks from Grammy callback handler
      this.callbackHandlerRegistered = true;
    }
  }

  private requireBotToken(): string {
    const token = this.config.telegram.bot_token?.trim();
    if (!token) {
      throw new Error("Bot-mode runtime requires telegram.bot_token");
    }
    return token;
  }

  /**
   * Stop the agent
   */
  async stop(): Promise<void> {
    log.info("Stopping Teleton AI...");

    // Stop agent subsystems via lifecycle
    await this.lifecycle.stop(() => this.stopAgent());

    // Stop WebUI server (if running)
    if (this.webuiServer) {
      try {
        await this.webuiServer.stop();
      } catch (error: unknown) {
        log.error({ err: error }, "WebUI stop failed");
      }
    }

    // Stop Management API server (if running)
    if (this.apiServer) {
      try {
        await this.apiServer.stop();
      } catch (error: unknown) {
        log.error({ err: error }, "Management API stop failed");
      }
    }

    try {
      await this.agentManager.stopAll();
    } catch (e) {
      log.error({ err: e }, "⚠️ Managed agent shutdown failed");
    }

    // Close database last (shared with WebUI)
    this.memory.scheduler.stop();
    try {
      closeDatabase();
    } catch (error: unknown) {
      log.error({ err: error }, "Database close failed");
    }
  }

  /**
   * Stop agent subsystems (watcher, MCP, debouncer, handler, modules, bridge).
   * Called by lifecycle.stop() — do NOT call directly.
   */
  private async stopAgent(): Promise<void> {
    // Fire workflow agent.stop event and stop scheduler
    if (this.workflowScheduler) {
      try {
        await this.workflowScheduler.fireEvent("agent.stop");
      } catch (err) {
        log.warn({ err }, "Workflow agent.stop event failed");
      }
      this.workflowScheduler.stop();
      this.workflowScheduler = null;
      this.agent.setOnToolCompleteCallback(undefined);
    }

    // Stop DB-backed task scheduler
    if (this.taskScheduler) {
      this.taskScheduler.stop();
      this.taskScheduler = null;
    }

    // Stop heartbeat timer
    this.heartbeatRunner.stop();

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
      } catch (error: unknown) {
        log.error({ err: error }, "agent:stop hook failed");
      }
    }

    // Stop plugin watcher first
    if (this.pluginWatcher) {
      try {
        await this.pluginWatcher.stop();
      } catch (error: unknown) {
        log.error({ err: error }, "Plugin watcher stop failed");
      }
    }

    if (this.cacheInvalidationWatcher) {
      try {
        await this.cacheInvalidationWatcher.stop();
      } catch (e) {
        log.error({ err: e }, "⚠️ Cache invalidation watcher stop failed");
      }
    }

    // Stop the gocoon SSE proxy and runner (when teleton supervises them)
    if (this.gocoonProxy) {
      try {
        this.gocoonProxy.stop();
      } catch (error: unknown) {
        log.error({ err: error }, "gocoon sse-proxy stop failed");
      }
    }
    if (this.gocoonSupervisor) {
      try {
        this.gocoonSupervisor.stop();
      } catch (error: unknown) {
        log.error({ err: error }, "gocoon supervisor stop failed");
      }
    }

    // Close MCP connections
    if (this.mcpConnections.length > 0) {
      try {
        await closeMcpServers(this.mcpConnections);
      } catch (error: unknown) {
        log.error({ err: error }, "MCP close failed");
      }
    }

    // Each step is isolated so a failure in one doesn't skip the rest
    if (this.debouncer) {
      try {
        await this.debouncer.flushAll();
      } catch (error: unknown) {
        log.error({ err: error }, "Debouncer flush failed");
      }
    }

    // Drain in-flight message processing before disconnecting
    try {
      await this.messageHandler.drain();
    } catch (error: unknown) {
      log.error({ err: error }, "Message queue drain failed");
    }

    // Flush any pending offset writes (deferred disk writes from writeOffset)
    try {
      flushOffsets();
    } catch (e) {
      log.error({ err: e }, "⚠️ Offset flush failed");
    }

    for (const mod of this.modules) {
      try {
        await Promise.race([
          mod.stop?.(),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`Plugin "${mod.name}" stop() timed out after 30s`)),
              PLUGIN_STOP_TIMEOUT_MS
            )
          ),
        ]);
      } catch (error: unknown) {
        log.error({ err: error }, `Module "${mod.name}" stop failed`);
      }
    }

    // Drain autonomous task loops before bridge/DB are torn down so their
    // in-flight SQLite writes don't race a closed database (AUDIT-C2).
    if (this.autonomousManager) {
      try {
        await this.autonomousManager.stopAllAndWait();
      } catch (e) {
        log.error({ err: e }, "⚠️ Autonomous manager stop failed");
      }
    }

    this.callbackHandlerRegistered = false;
    // messageHandlersRegistered stays true — Grammy Bot instance retains its middleware tree
    // across stop/start cycles; re-registering would throw "registering listeners from within listeners"
    try {
      await this.bridge.disconnect();
    } catch (error: unknown) {
      log.error({ err: error }, "Bridge disconnect failed");
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
    log.error(`Failed to initialize: ${getErrorMessage(error)}`);
    process.exit(1);
  }

  // Handle uncaught errors - log and keep running
  process.on("unhandledRejection", (reason) => {
    log.error({ err: reason }, "Unhandled promise rejection");
  });

  process.on("uncaughtException", (error) => {
    log.error({ err: error }, "Uncaught exception");
    // Exit on uncaught exceptions - state may be corrupted
    process.exit(1);
  });

  // Handle graceful shutdown with timeout safety net
  let shutdownInProgress = false;
  const gracefulShutdown = async () => {
    if (shutdownInProgress) return;
    shutdownInProgress = true;

    clearKeyPair();

    const forceExit = setTimeout(() => {
      log.error("Shutdown timed out, forcing exit");
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
