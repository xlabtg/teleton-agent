import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { parse, stringify } from "yaml";
import { homedir } from "os";
import { dirname, join } from "path";
import { ConfigSchema, type Config } from "./schema.js";
import { getProviderMetadata, type SupportedProvider } from "./providers.js";
import { TELETON_ROOT } from "../workspace/paths.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("Config");

const DEFAULT_CONFIG_PATH = join(TELETON_ROOT, "config.yaml");
const NORMAL_DEFAULT_CONFIG_PATH = join(homedir(), ".teleton", "config.yaml");

/**
 * Turn a Zod validation error into a human-readable, actionable message.
 *
 * The raw `ZodError.message` is a JSON dump of the issue array which is hard to
 * read in a terminal (see issue #628 — users only saw a wall of JSON and the
 * agent silently exited). This formats each issue as `path: message` and appends
 * a hint pointing at the offending config file and `teleton setup`.
 */
export function formatConfigIssues(error: {
  issues: Array<{ path: PropertyKey[]; message: string }>;
}): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.map(String).join(".") : "(root)";
      return `  • ${path}: ${issue.message}`;
    })
    .join("\n");
}

export function formatConfigError(
  error: { issues: Array<{ path: PropertyKey[]; message: string }> },
  configPath?: string
): string {
  const where = configPath ? ` in ${configPath}` : "";
  return (
    `Invalid config${where}:\n${formatConfigIssues(error)}\n\n` +
    "Fix the field(s) above, or run 'teleton setup' to (re)create the configuration."
  );
}

export function parseEnvPort(name: string, value: string): number {
  const port = parseInt(value, 10);
  if (isNaN(port) || String(port) !== value.trim()) {
    throw new Error(`Invalid ${name} environment variable: "${value}" is not a valid integer`);
  }
  if (port < 1 || port > 65535) {
    throw new Error(
      `Invalid ${name} environment variable: ${port} is out of valid port range (1–65535)`
    );
  }
  return port;
}

export function expandPath(path: string): string {
  if (path.startsWith("~")) {
    return join(homedir(), path.slice(1));
  }
  return path;
}

/**
 * Known placeholder strings that appear in config.example.yaml.
 * If any of these values are found in the loaded config, a warning is emitted
 * so users know they forgot to replace example secrets with real ones.
 */
const PLACEHOLDER_PATTERNS = [
  /^YOUR_/i,
  /^your_/,
  /^\+1234567890$/,
  /^0$/, // telegram.api_id = 0 is the example default
];

interface PlaceholderCheck {
  field: string;
  value: string | number | undefined | null;
}

function isPlaceholder(value: string | number | undefined | null): boolean {
  if (value === null || value === undefined) return false;
  const str = String(value);
  return PLACEHOLDER_PATTERNS.some((re) => re.test(str));
}

/**
 * Emit warnings for any config fields that still contain placeholder values
 * from config.example.yaml. Does not throw — the config is still usable,
 * but the agent will likely fail to connect with placeholder credentials.
 */
function warnPlaceholders(config: Config): void {
  const checks: PlaceholderCheck[] = [
    { field: "agent.api_key", value: config.agent.api_key },
    { field: "telegram.api_hash", value: config.telegram.api_hash },
    { field: "telegram.phone", value: config.telegram.phone },
    { field: "telegram.api_id", value: config.telegram.api_id },
  ];

  for (const { field, value } of checks) {
    if (isPlaceholder(value)) {
      log.warn(
        { field },
        `Config field '${field}' still contains a placeholder value. ` +
          "Replace it with a real value or run 'teleton setup'."
      );
    }
  }
}

export function readConfigFile(configPath: string = DEFAULT_CONFIG_PATH): Config {
  const fullPath = expandPath(configPath);

  if (!existsSync(fullPath)) {
    throw new Error(`Config file not found: ${fullPath}\nRun 'teleton setup' to create one.`);
  }

  let content: string;
  try {
    content = readFileSync(fullPath, "utf-8");
  } catch (error) {
    throw new Error(`Cannot read config file ${fullPath}: ${(error as Error).message}`);
  }

  let raw: unknown;
  try {
    raw = parse(content);
  } catch (error) {
    throw new Error(`Invalid YAML in ${fullPath}: ${(error as Error).message}`);
  }

  // Backward compatibility: remove deprecated market key before parsing
  if (raw && typeof raw === "object" && "market" in (raw as Record<string, unknown>)) {
    log.warn("config.market is deprecated and ignored. Use market-api plugin instead.");
    delete (raw as Record<string, unknown>).market;
  }

  // Backward compatibility: the 'cocoon' provider (a proxy to an external
  // cocoon-cli) was replaced by the native 'gocoon' provider in 0.9.0. Migrate
  // so existing configs keep loading. gocoon runs its own channel, so the user
  // must run `teleton gocoon init` and fund it before use.
  const rawAgent = (raw as { agent?: { provider?: unknown } } | null)?.agent;
  if (rawAgent && rawAgent.provider === "cocoon") {
    log.warn(
      "Provider 'cocoon' was removed in 0.9.0; migrating to the native 'gocoon' provider. " +
        "Run 'teleton gocoon init' and fund the channel before use."
    );
    rawAgent.provider = "gocoon";
    // Carry a custom port from the old top-level cocoon block (the schema is
    // non-strict and would otherwise drop it).
    const rawObj = raw as Record<string, unknown>;
    const oldCocoon = rawObj.cocoon as { port?: number } | undefined;
    if (oldCocoon?.port != null) {
      const gocoon = (rawObj.gocoon as Record<string, unknown> | undefined) ?? {};
      if (gocoon.port == null) gocoon.port = oldCocoon.port;
      rawObj.gocoon = gocoon;
    }
  }

  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(formatConfigError(result.error, fullPath));
  }

  const config = result.data;
  const provider = config.agent.provider as SupportedProvider;
  if (
    provider !== "anthropic" &&
    provider !== "claude-code" &&
    !(raw as Record<string, Record<string, unknown>>).agent?.model
  ) {
    const meta = getProviderMetadata(provider);
    config.agent.model = meta.defaultModel;
  }

  config.telegram.session_path = expandPath(config.telegram.session_path);
  config.storage.sessions_file = expandPath(config.storage.sessions_file);
  config.storage.memory_file = expandPath(config.storage.memory_file);

  // Warn when example-file placeholder values are still present in the config.
  // These indicate the user copied config.example.yaml without filling in real values.
  warnPlaceholders(config);

  return config;
}

export function loadConfig(configPath: string = DEFAULT_CONFIG_PATH): Config {
  return applyEnvOverrides(readConfigFile(configPath));
}

export function applyEnvOverrides(config: Config): Config {
  if (process.env.TELETON_API_KEY) {
    config.agent.api_key = process.env.TELETON_API_KEY;
  }
  if (process.env.TELETON_TG_API_ID) {
    const apiId = parseInt(process.env.TELETON_TG_API_ID, 10);
    if (isNaN(apiId)) {
      throw new Error(
        `Invalid TELETON_TG_API_ID environment variable: "${process.env.TELETON_TG_API_ID}" is not a valid integer`
      );
    }
    config.telegram.api_id = apiId;
  }
  if (process.env.TELETON_TG_API_HASH) {
    config.telegram.api_hash = process.env.TELETON_TG_API_HASH;
  }
  if (process.env.TELETON_TG_PHONE) {
    config.telegram.phone = process.env.TELETON_TG_PHONE;
  }
  if (process.env.TELETON_TG_BOT_TOKEN) {
    config.telegram.bot_token = process.env.TELETON_TG_BOT_TOKEN;
  }

  // WebUI environment variable overrides
  if (process.env.TELETON_WEBUI_ENABLED) {
    config.webui.enabled = process.env.TELETON_WEBUI_ENABLED === "true";
  }
  if (process.env.TELETON_WEBUI_PORT) {
    config.webui.port = parseEnvPort("TELETON_WEBUI_PORT", process.env.TELETON_WEBUI_PORT);
  }
  if (process.env.TELETON_WEBUI_HOST) {
    config.webui.host = process.env.TELETON_WEBUI_HOST;
    if (!["127.0.0.1", "localhost", "::1"].includes(config.webui.host)) {
      log.warn(
        { host: config.webui.host },
        "WebUI bound to non-loopback address — ensure auth_token is set"
      );
    }
  }

  // Management API environment variable overrides
  if (process.env.TELETON_API_ENABLED) {
    if (!config.api)
      config.api = {
        enabled: false,
        port: 7778,
        host: "127.0.0.1",
        key_hash: "",
        allowed_ips: [],
        docs_enabled: false,
      };
    config.api.enabled = process.env.TELETON_API_ENABLED === "true";
  }
  if (process.env.TELETON_API_PORT) {
    const port = parseEnvPort("TELETON_API_PORT", process.env.TELETON_API_PORT);
    if (!config.api)
      config.api = {
        enabled: false,
        port: 7778,
        host: "127.0.0.1",
        key_hash: "",
        allowed_ips: [],
        docs_enabled: false,
      };
    config.api.port = port;
  }

  // Local LLM base URL override
  if (process.env.TELETON_BASE_URL) {
    try {
      new URL(process.env.TELETON_BASE_URL);
      config.agent.base_url = process.env.TELETON_BASE_URL;
    } catch {
      throw new Error(
        `Invalid TELETON_BASE_URL: "${process.env.TELETON_BASE_URL}" is not a valid URL`
      );
    }
  }

  // Optional API key overrides
  if (process.env.TELETON_TAVILY_API_KEY) {
    config.tavily_api_key = process.env.TELETON_TAVILY_API_KEY;
  }
  if (process.env.TELETON_TONAPI_KEY) {
    config.tonapi_key = process.env.TELETON_TONAPI_KEY;
  }
  if (process.env.TELETON_TONCENTER_API_KEY) {
    config.toncenter_api_key = process.env.TELETON_TONCENTER_API_KEY;
  }

  // Upstash Vector semantic memory overrides
  if (process.env.UPSTASH_VECTOR_REST_URL) {
    config.vector_memory.upstash_rest_url = process.env.UPSTASH_VECTOR_REST_URL;
  }
  if (process.env.UPSTASH_VECTOR_REST_TOKEN) {
    config.vector_memory.upstash_rest_token = process.env.UPSTASH_VECTOR_REST_TOKEN;
  }
  if (process.env.UPSTASH_VECTOR_NAMESPACE) {
    config.vector_memory.namespace = process.env.UPSTASH_VECTOR_NAMESPACE;
  }
  if (process.env.TELETON_TIMEZONE) {
    config.temporal_context.timezone = process.env.TELETON_TIMEZONE;
  }

  return config;
}

export function saveConfig(config: Config, configPath: string = DEFAULT_CONFIG_PATH): void {
  const result = ConfigSchema.safeParse(config);
  if (!result.success) {
    throw new Error(`Refusing to save invalid config:\n${formatConfigIssues(result.error)}`);
  }

  const fullPath = expandPath(configPath);
  const dir = dirname(fullPath);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  config.meta.last_modified_at = new Date().toISOString();
  writeFileSync(fullPath, stringify(config), { encoding: "utf-8", mode: 0o600 });
}

export function configExists(configPath: string = DEFAULT_CONFIG_PATH): boolean {
  return existsSync(expandPath(configPath));
}

export function getDefaultConfigPath(): string {
  return DEFAULT_CONFIG_PATH;
}

export function getNormalDefaultConfigPath(): string {
  return NORMAL_DEFAULT_CONFIG_PATH;
}
