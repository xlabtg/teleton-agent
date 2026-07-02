import { z } from "zod";
import { TELEGRAM_MAX_MESSAGE_LENGTH } from "../constants/limits.js";
import pkg from "../../package.json" with { type: "json" };
import { SUPPORTED_PROVIDER_IDS } from "./providers.js";

export const DMPolicy = z.enum(["allowlist", "open", "admin-only", "disabled"]);
export const GroupPolicy = z.enum(["open", "allowlist", "admin-only", "disabled"]);

// Exec enums exported so the UI whitelist (configurable-keys.ts) reuses them
// instead of re-listing the literals.
// "allowlist" (fork) restricts exec to a vetted set of command prefixes; it sits
// between "off" and "yolo" (full system access).
export const ExecMode = z.enum(["off", "allowlist", "yolo"]);
export const ExecScope = z.enum(["admin-only", "allowlist", "all"]);

export const SessionResetPolicySchema = z.object({
  daily_reset_enabled: z.boolean().default(true).describe("Enable daily session reset"),
  daily_reset_hour: z
    .number()
    .min(0)
    .max(23)
    .default(4)
    .describe("Hour of day (0-23) to reset sessions"),
  idle_expiry_enabled: z.boolean().default(true).describe("Enable session reset after idle period"),
  idle_expiry_minutes: z
    .number()
    .default(1440)
    .describe("Minutes of inactivity before session reset (default: 24h)"),
});

export const CompactionConfigSchema = z.object({
  enabled: z.boolean().default(true).describe("Enable automatic context compaction"),
  max_messages: z
    .number()
    .int()
    .min(10)
    .optional()
    .describe(
      "Trigger compaction after N messages (overrides model-derived default). " +
        "Lower values compact more aggressively; higher values keep more history."
    ),
  keep_recent: z
    .number()
    .int()
    .min(5)
    .optional()
    .describe(
      "Number of recent messages always preserved during compaction (overrides default). " +
        "These messages are never summarised away."
    ),
  log_compaction: z
    .boolean()
    .default(true)
    .describe(
      "Write a compaction audit entry to the daily log before discarding old messages. " +
        "Preserves an audit trail of what was compacted even when the original messages are gone."
    ),
  auto_preserve: z
    .boolean()
    .default(true)
    .describe(
      "Extract and preserve critical identifiers (wallet addresses, transaction hashes, numbers) " +
        "from messages before compaction so they survive the summarisation step."
    ),
});

export const AgentConfigSchema = z.object({
  provider: z.enum(SUPPORTED_PROVIDER_IDS).default("anthropic"),
  api_key: z.string().default(""),
  base_url: z
    .string()
    .url()
    .optional()
    .describe("Base URL for local LLM server (e.g. http://localhost:11434/v1)"),
  model: z.string().default("claude-opus-4-8"),
  utility_model: z
    .string()
    .optional()
    .describe("Cheap model for summarization (auto-detected if omitted)"),
  max_tokens: z.number().default(4096),
  temperature: z.number().default(0.7),
  system_prompt: z.string().nullable().default(null),
  max_agentic_iterations: z
    .number()
    .default(5)
    .describe("Maximum number of agentic loop iterations (tool call → result → tool call cycles)"),
  max_rag_chars: z
    .number()
    .int()
    .min(500)
    .optional()
    .describe(
      "Max characters of RAG context (knowledge + feed) injected per request. " +
        "Reduces token cost and speeds up responses for smaller/cheaper providers. " +
        "Unset = no limit. Recommended: 4000-8000 for ZAI/budget providers."
    ),
  session_reset_policy: SessionResetPolicySchema.default(SessionResetPolicySchema.parse({})),
  compaction: CompactionConfigSchema.default(CompactionConfigSchema.parse({})).describe(
    "Context compaction settings — controls when and how old messages are summarised"
  ),
});

const _SelfCorrectionObject = z.object({
  enabled: z
    .boolean()
    .default(false)
    .describe("Enable LLM self-evaluation and regeneration before responding"),
  threshold: z
    .number()
    .min(0)
    .max(1)
    .default(0.7)
    .describe("Minimum quality score required to accept the generated response"),
  max_iterations: z
    .number()
    .int()
    .min(1)
    .max(5)
    .default(3)
    .describe("Maximum evaluate/reflect/regenerate cycles per response"),
  min_input_chars: z
    .number()
    .int()
    .min(0)
    .default(40)
    .describe("Skip LLM self-correction for shorter user messages"),
  skip_simple_messages: z
    .boolean()
    .default(true)
    .describe("Skip LLM self-correction for trivial acknowledgements and short replies"),
  model: z
    .string()
    .optional()
    .describe("Optional model override for self-correction calls; defaults to agent.utility_model"),
  tool_recovery_enabled: z
    .boolean()
    .default(true)
    .describe("Add deterministic recovery guidance after failed tool calls"),
});
export const SelfCorrectionConfigSchema = _SelfCorrectionObject.default(
  _SelfCorrectionObject.parse({})
);

export const CommandAccessSchema = z.object({
  commands_enabled: z
    .boolean()
    .default(true)
    .describe("Globally enable or disable all Telegram command handling"),
  admin_only_commands: z
    .boolean()
    .default(true)
    .describe("Restrict all commands to admin users only (admins always bypass this)"),
  allowed_user_ids: z
    .array(z.number())
    .default([])
    .describe("User IDs allowed to run commands (empty = no extra restriction)"),
  allowed_chat_ids: z
    .array(z.number())
    .default([])
    .describe("Chat IDs where commands are allowed (empty = no extra restriction)"),
  unknown_command_reply: z
    .boolean()
    .default(false)
    .describe("Send 'Use /help for available commands.' reply for unrecognized commands"),
});

export const TelegramConfigSchema = z
  .object({
    mode: z.enum(["user", "bot"]).default("user"),
    api_id: z.number(),
    api_hash: z.string(),
    phone: z.string(),
    session_name: z.string().default("teleton_session"),
    session_path: z.string().default("~/.teleton"),
    dm_policy: DMPolicy.default("allowlist"),
    allow_from: z.array(z.number()).default([]),
    group_policy: GroupPolicy.default("open"),
    group_allow_from: z.array(z.number()).default([]),
    require_mention: z.boolean().default(true),
    max_message_length: z
      .number()
      .min(1)
      .max(TELEGRAM_MAX_MESSAGE_LENGTH)
      .default(TELEGRAM_MAX_MESSAGE_LENGTH)
      .describe(
        "Maximum incoming message length in characters. Messages exceeding this limit are rejected early " +
          "(DoS/context-overflow defense). Also controls outgoing message splitting. " +
          "Admins are exempt. Default: 4096 (Telegram max). Reduce for stricter limits."
      ),
    typing_simulation: z.boolean().default(true),
    rate_limit_messages_per_second: z.number().default(1.0),
    rate_limit_groups_per_minute: z.number().default(20),
    admin_ids: z.array(z.number()).default([]),
    agent_channel: z.string().nullable().default(null),
    owner_name: z.string().optional().describe("Owner's first name (e.g., 'Alex')"),
    owner_username: z.string().optional().describe("Owner's Telegram username (without @)"),
    owner_id: z.number().optional().describe("Owner's Telegram user ID"),
    debounce_ms: z
      .number()
      .default(1500)
      .describe("Debounce delay in milliseconds for group messages (0 = disabled)"),
    bot_token: z
      .string()
      .optional()
      .describe("Telegram Bot token from @BotFather for inline deal buttons"),
    bot_username: z
      .string()
      .optional()
      .describe("Bot username without @ (e.g., 'teleton_deals_bot')"),
    stream_mode: z
      .enum(["all", "replace", "off"])
      .default("replace")
      .describe(
        "Bot streaming mode: replace=each iteration replaces draft (default), all=concatenate all iterations, off=no streaming"
      ),
    guest_mode: z
      .boolean()
      .default(false)
      .describe("Allow the bot to answer guest queries in chats it is not a member of"),
    command_access: CommandAccessSchema.default(CommandAccessSchema.parse({})).describe(
      "Configurable command access control settings"
    ),
  })
  .superRefine((data, ctx) => {
    if (data.mode === "user") {
      if (!data.api_id)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "api_id is required in user mode",
          path: ["api_id"],
        });
      if (!data.api_hash)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "api_hash is required in user mode",
          path: ["api_hash"],
        });
      if (!data.phone)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "phone is required in user mode",
          path: ["phone"],
        });
    }
    if (data.mode === "bot") {
      if (!data.bot_token)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "bot_token is required in bot mode",
          path: ["bot_token"],
        });
      if (!data.owner_id)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "owner_id is required in bot mode",
          path: ["owner_id"],
        });
    }
  });

export const StorageConfigSchema = z.object({
  sessions_file: z.string().default("~/.teleton/sessions.json"),
  memory_file: z.string().default("~/.teleton/memory.json"),
  history_limit: z.number().default(100),
});

export const MetaConfigSchema = z.object({
  version: z.string().default(pkg.version),
  created_at: z.string().optional(),
  last_modified_at: z.string().optional(),
  onboard_command: z.string().default("teleton setup"),
});

const _DealsObject = z.object({
  enabled: z.boolean().default(true),
  expiry_seconds: z.number().default(120),
  buy_max_floor_percent: z.number().default(95),
  sell_min_floor_percent: z.number().default(105),
  poll_interval_ms: z.number().default(5000),
  max_verification_retries: z.number().default(12),
  expiry_check_interval_ms: z.number().default(60000),
});
export const DealsConfigSchema = _DealsObject.default(_DealsObject.parse({}));

const _WebUIObject = z.object({
  enabled: z.boolean().default(false).describe("Enable WebUI server"),
  port: z.number().default(7777).describe("HTTP server port"),
  host: z.string().default("127.0.0.1").describe("Bind address (localhost only for security)"),
  auth_token: z
    .string()
    .optional()
    .describe("Bearer token for API auth (auto-generated if omitted)"),
  auth_token_hash: z
    .string()
    .optional()
    .describe(
      "Scrypt hash of the auth token (format: scrypt$<salt-hex>$<hash-hex>). When set, takes precedence over auth_token so the raw token is never persisted."
    ),
  cors_origins: z
    .array(z.string())
    .default(["http://localhost:5173", "http://localhost:7777"])
    .describe("Allowed CORS origins for development"),
  log_requests: z.boolean().default(false).describe("Log all HTTP requests"),
});
export const WebUIConfigSchema = _WebUIObject.default(_WebUIObject.parse({}));

const _EmbeddingObject = z.object({
  provider: z
    .enum(["local", "anthropic", "none"])
    .default("local")
    .describe("Embedding provider: local (ONNX), anthropic (API), or none (FTS5-only)"),
  model: z
    .string()
    .optional()
    .describe("Model override (default: Xenova/all-MiniLM-L6-v2 for local)"),
});
export const EmbeddingConfigSchema = _EmbeddingObject.default(_EmbeddingObject.parse({}));

const _VectorMemoryObject = z.object({
  upstash_rest_url: z
    .string()
    .default("")
    .describe("Upstash Vector REST URL for primary semantic memory storage"),
  upstash_rest_token: z
    .string()
    .default("")
    .describe("Upstash Vector REST token for primary semantic memory storage"),
  namespace: z
    .string()
    .default("teleton-memory")
    .describe("Upstash Vector namespace used for Teleton memory chunks"),
});
export const VectorMemoryConfigSchema = _VectorMemoryObject.default(_VectorMemoryObject.parse({}));

const _MemoryPrioritizationWeightsObject = z.object({
  recency: z.number().min(0).default(0.35),
  frequency: z.number().min(0).default(0.2),
  impact: z.number().min(0).default(0.2),
  explicit: z.number().min(0).default(0.15),
  centrality: z.number().min(0).default(0.1),
});

const _MemoryPrioritizationObject = z.object({
  enabled: z.boolean().default(true).describe("Enable periodic memory score recalculation"),
  interval_minutes: z
    .number()
    .min(1)
    .default(60)
    .describe("How often memory importance scores are recalculated"),
  recency_half_life_days: z
    .number()
    .min(1)
    .default(30)
    .describe("Age, in days, where the recency score decays to 0.5"),
  weights: _MemoryPrioritizationWeightsObject.default(_MemoryPrioritizationWeightsObject.parse({})),
});

const _MemoryRetentionObject = z.object({
  min_score: z
    .number()
    .min(0)
    .max(1)
    .default(0.1)
    .describe("Memories below this importance score are cleanup candidates"),
  max_age_days: z
    .number()
    .min(1)
    .default(90)
    .describe("Non-protected memories older than this are cleanup candidates"),
  max_entries: z
    .number()
    .int()
    .min(1)
    .default(10_000)
    .describe("Maximum number of active knowledge memory entries to retain"),
  archive_days: z
    .number()
    .min(1)
    .default(30)
    .describe("How long archived memories are retained before permanent deletion"),
  auto_cleanup: z
    .boolean()
    .default(false)
    .describe("Automatically archive cleanup candidates during the scheduler run"),
  checkpoint_retention_days: z
    .number()
    .min(1)
    .default(7)
    .describe(
      "Days to retain task_checkpoints for inactive autonomous tasks (active tasks are skipped)"
    ),
});

const _MemoryObject = z.object({
  prioritization: _MemoryPrioritizationObject.default(_MemoryPrioritizationObject.parse({})),
  retention: _MemoryRetentionObject.default(_MemoryRetentionObject.parse({})),
});
export const MemoryConfigSchema = _MemoryObject.default(_MemoryObject.parse({}));

const _FeedObject = z.object({
  retention_days: z
    .number()
    .int()
    .min(1)
    .default(90)
    .describe("Days to retain Telegram feed messages in tg_messages before pruning"),
  max_messages: z
    .number()
    .int()
    .min(1)
    .default(100_000)
    .describe("Maximum Telegram feed messages to keep after age-based pruning"),
});
export const FeedConfigSchema = _FeedObject.default(_FeedObject.parse({}));

const _TemporalWeightingObject = z.object({
  enabled: z.boolean().default(true).describe("Enable temporal relevance weighting for RAG"),
  decay_curve: z
    .enum(["exponential", "linear", "step"])
    .default("exponential")
    .describe("Freshness decay curve used by temporal retrieval scoring"),
  recency_half_life_days: z
    .number()
    .min(1)
    .default(30)
    .describe("Age, in days, where exponential temporal freshness decays to 0.5"),
  temporal_relevance_weight: z
    .number()
    .min(0)
    .max(1)
    .default(0.2)
    .describe("Blend weight for temporal relevance in retrieval result scores"),
});

const _TemporalContextObject = z.object({
  enabled: z.boolean().default(true).describe("Enable time-aware context and pattern analysis"),
  timezone: z
    .string()
    .default("UTC")
    .describe("IANA timezone used for local day, hour, and greeting context"),
  pattern_min_frequency: z
    .number()
    .int()
    .min(1)
    .default(2)
    .describe("Minimum observations required before storing a temporal pattern"),
  pattern_confidence_threshold: z
    .number()
    .min(0)
    .max(1)
    .default(0.5)
    .describe("Minimum pattern confidence before it is surfaced"),
  context_patterns_limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(5)
    .describe("Maximum active temporal patterns injected into prompt context"),
  weighting: _TemporalWeightingObject.default(_TemporalWeightingObject.parse({})),
});
export const TemporalContextConfigSchema = _TemporalContextObject.default(
  _TemporalContextObject.parse({})
);

const _LoggingObject = z.object({
  level: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal"])
    .default("info")
    .describe("Log level (trace/debug/info/warn/error/fatal)"),
  pretty: z
    .boolean()
    .default(true)
    .describe("Enable pino-pretty formatting (human-readable, colored output)"),
});
export const LoggingConfigSchema = _LoggingObject.default(_LoggingObject.parse({}));

const _AuditTrailObject = z.object({
  enabled: z.boolean().default(true).describe("Enable comprehensive tamper-evident audit events"),
  retention_days: z
    .number()
    .int()
    .min(1)
    .default(90)
    .describe("Default audit event retention period in days"),
  compliance_retention_days: z
    .number()
    .int()
    .min(1)
    .default(2555)
    .describe("Long retention period for compliance mode, defaulting to seven years"),
  payload_max_bytes: z
    .number()
    .int()
    .min(1024)
    .max(1_000_000)
    .default(16 * 1024)
    .describe("Maximum serialized payload size stored per audit event before truncation"),
});
export const AuditTrailConfigSchema = _AuditTrailObject.default(_AuditTrailObject.parse({}));

const _TonProxyObject = z.object({
  enabled: z
    .boolean()
    .default(false)
    .describe("Enable TON Proxy (Tonutils-Proxy) for .ton site access"),
  port: z.number().min(1).max(65535).default(8080).describe("HTTP proxy port (default: 8080)"),
  binary_path: z
    .string()
    .optional()
    .describe("Custom path to tonutils-proxy-cli binary (auto-downloaded if omitted)"),
});
export const TonProxyConfigSchema = _TonProxyObject.default(_TonProxyObject.parse({}));

const _DevObject = z.object({
  hot_reload: z
    .boolean()
    .default(false)
    .describe("Enable plugin hot-reload (watches ~/.teleton/plugins/ for changes)"),
});
export const DevConfigSchema = _DevObject.default(_DevObject.parse({}));

const _MarketplaceSourceObject = z.object({
  url: z
    .string()
    .url()
    .describe(
      "Registry JSON URL (e.g. https://raw.githubusercontent.com/owner/repo/main/registry.json)"
    ),
  label: z.string().optional().describe("Human-readable label shown in the UI"),
  enabled: z.boolean().default(true).describe("Enable or disable this source"),
});

const _MarketplaceObject = z.object({
  extra_sources: z
    .array(_MarketplaceSourceObject)
    .default([])
    .describe("Additional plugin registry sources beyond the built-in official registry"),
});
export const MarketplaceConfigSchema = _MarketplaceObject.default(_MarketplaceObject.parse({}));

const _ApiObject = z.object({
  enabled: z.boolean().default(false).describe("Enable HTTPS Management API server"),
  port: z.number().min(1).max(65535).default(7778).describe("HTTPS server port"),
  host: z
    .string()
    .default("127.0.0.1")
    .describe("Bind address — use 127.0.0.1 (localhost only) or 0.0.0.0 (all interfaces)"),
  key_hash: z
    .string()
    .default("")
    .describe("SHA-256 hash of the API key (auto-generated if empty)"),
  allowed_ips: z
    .array(z.string())
    .default([])
    .describe("IP whitelist (empty = allow all authenticated requests)"),
  docs_enabled: z
    .boolean()
    .default(false)
    .describe(
      "Serve interactive Swagger UI at /api/docs (also enabled automatically when NODE_ENV != production)"
    ),
});
export const ApiConfigSchema = _ApiObject.default(_ApiObject.parse({}));

const _EventBusObject = z.object({
  enabled: z.boolean().default(true).describe("Enable internal event bus logging and dispatch"),
  max_log_entries: z
    .number()
    .int()
    .min(100)
    .max(100_000)
    .default(1_000)
    .describe("Maximum recent events retained in SQLite for query and replay"),
});
export const EventBusConfigSchema = _EventBusObject.default(_EventBusObject.parse({}));

const _WebhooksObject = z.object({
  enabled: z.boolean().default(true).describe("Enable outgoing and incoming webhook routes"),
  default_max_retries: z
    .number()
    .int()
    .min(1)
    .max(10)
    .default(5)
    .describe("Default webhook delivery attempts before a delivery is marked failed"),
  delivery_timeout_ms: z
    .number()
    .int()
    .min(1_000)
    .max(60_000)
    .default(5_000)
    .describe("HTTP timeout for each outgoing webhook delivery attempt"),
});
export const WebhooksConfigSchema = _WebhooksObject.default(_WebhooksObject.parse({}));

const _NetworkObject = z.object({
  enabled: z.boolean().default(false).describe("Enable signed inter-agent network protocol"),
  agent_id: z.string().default("primary").describe("Local agent id advertised to remote agents"),
  agent_name: z.string().default("Primary Agent").describe("Local agent name for discovery"),
  endpoint: z
    .string()
    .url()
    .nullable()
    .default(null)
    .describe("Public HTTPS endpoint for this agent's /api/agent-network ingress route"),
  discovery_mode: z
    .enum(["central", "peer-to-peer", "dns"])
    .default("central")
    .describe("Agent discovery mode used by the network layer"),
  registry_url: z
    .string()
    .url()
    .nullable()
    .default(null)
    .describe("Central registry endpoint for network discovery"),
  known_peers: z
    .array(z.string().url())
    .default([])
    .describe("Peer endpoints for manual discovery"),
  public_key: z
    .string()
    .nullable()
    .default(null)
    .describe("PEM encoded Ed25519 public key advertised to remote agents"),
  private_key: z
    .string()
    .nullable()
    .default(null)
    .describe("PEM encoded Ed25519 private key used to sign outbound network messages"),
  allowlist: z
    .array(z.string())
    .default([])
    .describe(
      "Agent ids allowed to send privileged network messages; empty allows any registered agent"
    ),
  blocklist: z.array(z.string()).default([]).describe("Agent ids blocked from network messaging"),
  default_trust_level: z
    .enum(["trusted", "verified", "untrusted"])
    .default("untrusted")
    .describe("Trust level assigned to newly registered remote agents"),
  message_timeout_ms: z
    .number()
    .int()
    .min(1000)
    .max(120000)
    .default(15000)
    .describe("Timeout for outbound network messages"),
  max_clock_skew_seconds: z
    .number()
    .int()
    .min(30)
    .max(3600)
    .default(300)
    .describe("Allowed timestamp skew for signed inbound network messages"),
});
export const NetworkConfigSchema = _NetworkObject.default(_NetworkObject.parse({}));

const _IntegrationsRateLimitObject = z.object({
  requests_per_minute: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Global outbound integration requests per minute"),
  requests_per_hour: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Global outbound integration requests per hour"),
});

const _IntegrationsObject = z.object({
  enabled: z.boolean().default(true).describe("Enable the unified integration registry"),
  credential_key: z
    .string()
    .optional()
    .describe(
      "Key material for encrypting integration credentials. Required before credentials can " +
        "be stored or read; may also be supplied via TELETON_INTEGRATIONS_KEY."
    ),
  health_check_interval_minutes: z
    .number()
    .int()
    .min(1)
    .default(5)
    .describe("Default interval for future background integration health checks"),
  global_rate_limit: _IntegrationsRateLimitObject.default(_IntegrationsRateLimitObject.parse({})),
});
export const IntegrationsConfigSchema = _IntegrationsObject.default(_IntegrationsObject.parse({}));
export type IntegrationsConfig = z.infer<typeof _IntegrationsObject>;

const McpServerSchema = z
  .object({
    command: z
      .string()
      .optional()
      .describe("Stdio command (e.g. 'npx @modelcontextprotocol/server-filesystem /tmp')"),
    args: z
      .array(z.string())
      .optional()
      .describe("Explicit args array (overrides command splitting)"),
    env: z
      .record(z.string(), z.string())
      .optional()
      .describe("Environment variables for stdio server"),
    url: z.string().url().optional().describe("SSE/HTTP endpoint URL (alternative to command)"),
    scope: z
      .enum(["always", "dm-only", "group-only", "admin-only", "open", "allowlist", "disabled"])
      .default("always")
      .describe("Tool scope"),
    enabled: z.boolean().default(true).describe("Enable/disable this server"),
  })
  .refine((s) => s.command || s.url, {
    message: "Each MCP server needs either 'command' (stdio) or 'url' (SSE/HTTP)",
  });

const _McpObject = z.object({
  servers: z.record(z.string(), McpServerSchema).default({}),
});
export const McpConfigSchema = _McpObject.default(_McpObject.parse({}));

const _ToolSearchObject = z.object({
  enabled: z
    .boolean()
    .default(true)
    .describe("Enable ToolSearch mode: core tools + meta-tool replaces RAG pre-selection"),
});
export const ToolSearchConfigSchema = _ToolSearchObject.default(_ToolSearchObject.parse({}));

const _ToolRagObject = z.object({
  enabled: z.boolean().default(true).describe("Enable semantic tool retrieval (Tool RAG)"),
  top_k: z.number().default(35).describe("Max tools to retrieve per LLM call"),
  always_include: z
    .array(z.string())
    .default([
      "telegram_send_message",
      "telegram_quote_reply",
      "telegram_send_photo",
      "journal_*",
      "workspace_*",
    ])
    .describe("Tool name patterns always included (prefix glob with *)"),
  skip_unlimited_providers: z
    .boolean()
    .default(false)
    .describe("Skip Tool RAG for providers with no tool limit (e.g. Anthropic)"),
});
export const ToolRagConfigSchema = _ToolRagObject.default(_ToolRagObject.parse({}));

const _CacheTtlObject = z.object({
  tools_ms: z
    .number()
    .int()
    .min(1_000)
    .default(5 * 60 * 1000)
    .describe("TTL for cached tool schema/context selections"),
  prompts_ms: z
    .number()
    .int()
    .min(1_000)
    .default(60 * 1000)
    .describe("TTL for cached prompt and soul file reads"),
  embeddings_ms: z
    .number()
    .int()
    .min(1_000)
    .default(30 * 60 * 1000)
    .describe("TTL for in-memory embedding vectors"),
  api_responses_ms: z
    .number()
    .int()
    .min(1_000)
    .default(5 * 60 * 1000)
    .describe("TTL for opt-in cached external API responses"),
});

const _CacheObject = z.object({
  enabled: z.boolean().default(true).describe("Enable predictive in-memory resource caching"),
  max_entries: z
    .number()
    .int()
    .min(10)
    .max(100_000)
    .default(512)
    .describe("Maximum number of in-memory resource cache entries"),
  ttl: _CacheTtlObject.default(_CacheTtlObject.parse({})),
});
export const CacheConfigSchema = _CacheObject.default(_CacheObject.parse({}));

const _ExecLimitsObject = z.object({
  timeout: z.number().min(1).max(3600).default(120).describe("Max seconds per command execution"),
  max_output: z
    .number()
    .min(1000)
    .max(500000)
    .default(50000)
    .describe("Max chars of stdout/stderr captured per command"),
});

const _ExecAuditObject = z.object({
  log_commands: z.boolean().default(true).describe("Log every command to SQLite audit table"),
});

const _ExecObject = z.object({
  mode: ExecMode.default("off").describe(
    "Exec mode: off (disabled), allowlist (only permitted commands), or yolo (full system access — dangerous)"
  ),
  scope: ExecScope.default("admin-only").describe("Who can trigger exec tools"),
  allowlist: z
    .array(z.number())
    .default([])
    .describe("Telegram user IDs allowed to use exec (when scope = allowlist)"),
  command_allowlist: z
    .array(z.string())
    .default([])
    .describe(
      "Allowed program names when mode = allowlist (e.g. 'git', 'ls', 'npm'). " +
        "A command is permitted when its first token (the program name) exactly matches an entry. " +
        "Shell operators (pipes, &&, redirects, command substitution) are always rejected in allowlist mode. " +
        "Empty list blocks all commands."
    ),
  sandbox_mode: z
    .enum(["unrestricted", "sandboxed", "dry-run"])
    .default("unrestricted")
    .describe(
      "Execution isolation for exec tools: unrestricted (current behavior), sandboxed (temporary cwd and minimal env), or dry-run (validate/audit without spawning)."
    ),
  limits: _ExecLimitsObject.default(_ExecLimitsObject.parse({})),
  audit: _ExecAuditObject.default(_ExecAuditObject.parse({})),
});

const _CapabilitiesObject = z.object({
  exec: _ExecObject.default(_ExecObject.parse({})),
});
export const CapabilitiesConfigSchema = _CapabilitiesObject.default(_CapabilitiesObject.parse({}));

const _MtprotoProxyObject = z.object({
  server: z.string().describe("Proxy server hostname or IP address"),
  port: z.number().min(1).max(65535).describe("Proxy server port"),
  secret: z
    .string()
    .describe(
      "MTProto proxy secret (16-byte hex/base64url, 17-byte transport-prefixed secret, or ee TLS-emulation secret with domain)"
    ),
});
export type MtprotoProxyEntry = z.infer<typeof _MtprotoProxyObject>;

const _MtprotoObject = z.object({
  enabled: z.boolean().default(false).describe("Enable MTProto proxy for Telegram connection"),
  proxies: z
    .array(_MtprotoProxyObject)
    .default([])
    .describe("List of MTProto proxy servers (tried in order, failover to next on error)"),
  bot_api_proxy: z
    .string()
    .url()
    .optional()
    .describe(
      "HTTP/HTTPS or SOCKS5 proxy URL for Telegram Bot API HTTPS calls to api.telegram.org. " +
        "MTProto proxies cannot tunnel HTTPS, so set this when api.telegram.org is also blocked. " +
        "Examples: http://user:pass@host:8080, socks5://host:1080"
    ),
});
export const MtprotoConfigSchema = _MtprotoObject.default(_MtprotoObject.parse({}));
export type MtprotoConfig = z.infer<typeof _MtprotoObject>;

const _HeartbeatObject = z.object({
  enabled: z.boolean().default(true).describe("Enable periodic heartbeat timer"),
  interval_ms: z
    .number()
    .min(60_000)
    .default(3_600_000)
    .describe("Heartbeat interval in milliseconds (min 60s, default 60min)"),
  prompt: z
    .string()
    .default("Execute your HEARTBEAT.md checklist now. Work through each item using tool calls.")
    .describe("Prompt sent to agent on each heartbeat tick"),
  self_configurable: z
    .boolean()
    .default(false)
    .describe("Allow agent to modify heartbeat config via config_set"),
});
export const HeartbeatConfigSchema = _HeartbeatObject.default(_HeartbeatObject.parse({}));

const _PredictionsObject = z.object({
  enabled: z.boolean().default(true).describe("Enable behavior tracking and prediction APIs"),
  confidence_threshold: z
    .number()
    .min(0)
    .max(1)
    .default(0.6)
    .describe("Minimum confidence required before surfacing predictions"),
  proactive_suggestions: z
    .boolean()
    .default(false)
    .describe("Append high-confidence suggestions to agent replies"),
  max_suggestions: z
    .number()
    .int()
    .min(1)
    .max(10)
    .default(5)
    .describe("Maximum predictions returned by API endpoints"),
  history_limit: z
    .number()
    .int()
    .min(100)
    .max(100000)
    .default(5000)
    .describe("Maximum behavior events retained for prediction analysis"),
});
export const PredictionsConfigSchema = _PredictionsObject.default(_PredictionsObject.parse({}));

const _FeedbackObject = z.object({
  enabled: z.boolean().default(true).describe("Enable feedback capture and analytics"),
  implicit_signals: z
    .boolean()
    .default(true)
    .describe("Infer feedback from corrections, rephrasing, and delayed follow-ups"),
  prompt_adjustments: z
    .boolean()
    .default(true)
    .describe("Inject conservative learned preferences into future prompts"),
  min_feedback_for_prompt: z
    .number()
    .int()
    .min(1)
    .default(2)
    .describe("Minimum repeated feedback theme count before prompt adjustments use it"),
  correction_window_seconds: z
    .number()
    .int()
    .min(10)
    .default(600)
    .describe("Window for treating a follow-up correction as negative implicit feedback"),
  acceptance_delay_seconds: z
    .number()
    .int()
    .min(10)
    .default(300)
    .describe("Delay before a non-corrective follow-up is treated as accepted output"),
});
export const FeedbackConfigSchema = _FeedbackObject.default(_FeedbackObject.parse({}));

const _AdaptivePromptingObject = z.object({
  enabled: z.boolean().default(true).describe("Enable adaptive prompt variants and experiments"),
  default_traffic_percentage: z
    .number()
    .int()
    .min(1)
    .max(99)
    .default(20)
    .describe("Default candidate traffic percentage for prompt A/B tests"),
  min_samples: z
    .number()
    .int()
    .min(2)
    .default(30)
    .describe("Minimum samples per variant before an experiment can auto-promote a winner"),
  auto_promote: z
    .boolean()
    .default(true)
    .describe("Automatically activate statistically better prompt variants"),
});
export const AdaptivePromptingConfigSchema = _AdaptivePromptingObject.default(
  _AdaptivePromptingObject.parse({})
);

const _AnomalyAlertingObject = z.object({
  in_app: z.boolean().default(true).describe("Create in-app notifications for anomalies"),
  telegram: z.boolean().default(false).describe("Send anomaly alerts to Telegram admin chat IDs"),
  telegram_chat_ids: z
    .array(z.string())
    .default([])
    .describe("Optional Telegram chat IDs for alerts; empty uses configured admin IDs"),
  webhook_url: z
    .string()
    .url()
    .nullable()
    .default(null)
    .describe("Optional webhook URL for anomaly alerts"),
});

const _AnomalyDetectionObject = z.object({
  enabled: z.boolean().default(true).describe("Enable rolling baseline anomaly detection"),
  sensitivity: z
    .number()
    .min(0.5)
    .default(2.5)
    .describe("Z-score threshold in standard deviations"),
  baseline_days: z
    .number()
    .int()
    .min(1)
    .max(30)
    .default(7)
    .describe("Rolling baseline window in days"),
  min_samples: z
    .number()
    .int()
    .min(1)
    .default(24)
    .describe("Minimum hourly samples required before alerting on a metric"),
  cooldown_minutes: z
    .number()
    .int()
    .min(1)
    .default(15)
    .describe("Cooldown before re-alerting on the same anomaly type and metric"),
  alerting: _AnomalyAlertingObject.default(_AnomalyAlertingObject.parse({})),
});
export const AnomalyDetectionConfigSchema = _AnomalyDetectionObject.default(
  _AnomalyDetectionObject.parse({})
);

const _AutonomousObject = z.object({
  pause_timeout_hours: z
    .number()
    .min(1)
    .default(24)
    .describe(
      "Hours a task may remain paused before the retention job auto-cancels it with reason 'timeout-paused'"
    ),
});
export const AutonomousConfigSchema = _AutonomousObject.default(_AutonomousObject.parse({}));
export type AutonomousConfig = z.infer<typeof _AutonomousObject>;

export const ConfigSchema = z.object({
  meta: MetaConfigSchema.default(MetaConfigSchema.parse({})),
  agent: AgentConfigSchema,
  telegram: TelegramConfigSchema,
  storage: StorageConfigSchema.default(StorageConfigSchema.parse({})),
  embedding: EmbeddingConfigSchema,
  vector_memory: VectorMemoryConfigSchema,
  memory: MemoryConfigSchema,
  feed: FeedConfigSchema,
  audit_trail: AuditTrailConfigSchema,
  temporal_context: TemporalContextConfigSchema,
  self_correction: SelfCorrectionConfigSchema,
  autonomous: AutonomousConfigSchema,
  deals: DealsConfigSchema,
  webui: WebUIConfigSchema,
  logging: LoggingConfigSchema,
  dev: DevConfigSchema,
  marketplace: MarketplaceConfigSchema,
  tool_rag: ToolRagConfigSchema,
  cache: CacheConfigSchema,
  tool_search: ToolSearchConfigSchema,
  capabilities: CapabilitiesConfigSchema,
  api: ApiConfigSchema.optional(),
  integrations: IntegrationsConfigSchema,
  event_bus: EventBusConfigSchema,
  webhooks: WebhooksConfigSchema,
  network: NetworkConfigSchema,
  ton_proxy: TonProxyConfigSchema,
  heartbeat: HeartbeatConfigSchema,
  predictions: PredictionsConfigSchema,
  feedback: FeedbackConfigSchema,
  adaptive_prompting: AdaptivePromptingConfigSchema,
  anomaly_detection: AnomalyDetectionConfigSchema,
  mtproto: MtprotoConfigSchema,
  mcp: McpConfigSchema,
  plugins: z
    .record(z.string(), z.unknown())
    .default({})
    .describe("Per-plugin config (key = plugin name with underscores)"),
  gocoon: z
    .object({
      port: z
        .number()
        .min(1)
        .max(65535)
        .default(10000)
        .describe("HTTP port of the gocoon-runner OpenAI-compatible API"),
      auto_start: z
        .boolean()
        .optional()
        .describe("Auto-install and supervise the gocoon-runner on start (default: true)"),
    })
    .optional()
    .describe("Gocoon: pure-Go COCOON client (decentralized LLM on TON)"),
  tonapi_key: z
    .string()
    .optional()
    .describe("TonAPI key for higher rate limits (from @tonapi_bot)"),
  toncenter_api_key: z
    .string()
    .optional()
    .describe("TonCenter API key for dedicated RPC endpoint (free at https://toncenter.com)"),
  tavily_api_key: z
    .string()
    .optional()
    .describe("Tavily API key for web search & extract (free at https://tavily.com)"),
  wallet_encryption_key: z
    .string()
    .optional()
    .describe(
      "AES-256-GCM encryption key for wallet.json mnemonic (hex, 64 chars). " +
        "Generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\" " +
        "or set TELETON_WALLET_KEY env var."
    ),
  groq: z
    .object({
      api_key: z
        .string()
        .optional()
        .describe(
          "Groq API key for STT/TTS when using a different primary LLM provider (falls back to agent.api_key when agent.provider is 'groq')"
        ),
      stt_model: z
        .string()
        .default("whisper-large-v3-turbo")
        .describe("Groq STT model (e.g. whisper-large-v3, whisper-large-v3-turbo)"),
      tts_model: z
        .string()
        .default("canopylabs/orpheus-v1-english")
        .describe(
          "Groq TTS model (e.g. canopylabs/orpheus-v1-english, canopylabs/orpheus-arabic-saudi)"
        ),
      tts_voice: z
        .string()
        .default("autumn")
        .describe("Groq TTS voice name (e.g. autumn, diana, hannah, austin, daniel, troy)"),
      tts_format: z
        .enum(["mp3", "opus", "aac", "flac", "wav", "pcm"])
        .default("wav")
        .describe(
          "Groq TTS output audio format. Groq Orpheus currently supports only wav; legacy values are coerced to wav at runtime."
        ),
      tts_mode: z
        .enum(["voice_calls_only", "always", "use_primary_text"])
        .default("voice_calls_only")
        .describe(
          "When to respond with Groq TTS: voice_calls_only (only reply with voice when user sends voice), always (always respond with voice), use_primary_text (use primary provider for text, Groq only for STT)"
        ),
      stt_language: z
        .string()
        .optional()
        .describe("STT language hint (e.g. 'en'). Auto-detected if omitted."),
      rate_limit_mode: z
        .enum(["auto", "strict", "off"])
        .default("auto")
        .describe(
          "Rate limit handling: auto (retry 429s), strict (queue to avoid 429s), off (no retry)"
        ),
    })
    .optional()
    .describe(
      "Groq multi-modal configuration (STT, TTS, rate limits). Can be used alongside any primary LLM provider."
    ),
});

export type Config = z.infer<typeof ConfigSchema>;
export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type CompactionConfig = z.infer<typeof CompactionConfigSchema>;
export type TelegramConfig = z.infer<typeof TelegramConfigSchema>;
export type CommandAccessConfig = z.infer<typeof CommandAccessSchema>;
export type StorageConfig = z.infer<typeof StorageConfigSchema>;
export type SessionResetPolicy = z.infer<typeof SessionResetPolicySchema>;
export type DealsConfig = z.infer<typeof DealsConfigSchema>;
export type WebUIConfig = z.infer<typeof WebUIConfigSchema>;
export type EmbeddingConfig = z.infer<typeof EmbeddingConfigSchema>;
export type VectorMemoryConfig = z.infer<typeof VectorMemoryConfigSchema>;
export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;
export type FeedConfig = z.infer<typeof _FeedObject>;
export type AuditTrailConfig = z.infer<typeof _AuditTrailObject>;
export type SelfCorrectionConfig = z.infer<typeof _SelfCorrectionObject>;
export type MemoryPrioritizationConfig = z.infer<typeof _MemoryPrioritizationObject>;
export type MemoryRetentionConfig = z.infer<typeof _MemoryRetentionObject>;
export type TemporalContextConfig = z.infer<typeof _TemporalContextObject>;
export type TemporalWeightingConfig = z.infer<typeof _TemporalWeightingObject>;
export type LoggingConfig = z.infer<typeof LoggingConfigSchema>;
export type DevConfig = z.infer<typeof DevConfigSchema>;
export type McpConfig = z.infer<typeof McpConfigSchema>;
export type ToolRagConfig = z.infer<typeof ToolRagConfigSchema>;
export type CacheConfig = z.infer<typeof CacheConfigSchema>;
export type ToolSearchConfig = z.infer<typeof ToolSearchConfigSchema>;
export type McpServerConfig = z.infer<typeof McpServerSchema>;
export type TonProxyConfig = z.infer<typeof TonProxyConfigSchema>;
export type ApiConfig = z.infer<typeof _ApiObject>;
export type EventBusConfig = z.infer<typeof _EventBusObject>;
export type WebhooksConfig = z.infer<typeof _WebhooksObject>;
export type NetworkConfig = z.infer<typeof _NetworkObject>;
export type ExecConfig = z.infer<typeof _ExecObject>;
export type GroqConfig = NonNullable<z.infer<typeof ConfigSchema>["groq"]>;
export type HeartbeatConfig = z.infer<typeof _HeartbeatObject>;
export type PredictionsConfig = z.infer<typeof _PredictionsObject>;
export type AnomalyDetectionConfig = z.infer<typeof _AnomalyDetectionObject>;
export type AnomalyAlertingConfig = z.infer<typeof _AnomalyAlertingObject>;
export type MarketplaceConfig = z.infer<typeof _MarketplaceObject>;
export type MarketplaceSourceConfig = z.infer<typeof _MarketplaceSourceObject>;
