import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import {
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { WriteStream } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { loadConfig, saveConfig } from "../config/loader.js";
import type { Config } from "../config/schema.js";
import { TELETON_ROOT } from "../workspace/paths.js";
import { loadTemplate } from "../workspace/manager.js";
import { getErrorMessage } from "../utils/errors.js";
import { validateBotTokenFormat } from "../telegram/bot-token.js";
import {
  DEFAULT_AGENT_REGISTRY_CONFIG,
  getBuiltInAgentArchetype,
  listBuiltInAgentArchetypes,
} from "./archetypes.js";
import { MANAGED_AGENT_MESSAGE_RESULT_STATUSES } from "./types.js";
import type {
  ManagedAgentArchetype,
  CreateManagedAgentInput,
  ManagedAgentCommand,
  ManagedAgentDefinition,
  ManagedAgentMessage,
  ManagedAgentMemoryPolicy,
  ManagedAgentMode,
  ManagedAgentPersonalAuthTarget,
  ManagedAgentPersonalConnectionInput,
  ManagedAgentRuntimeStatus,
  ManagedAgentSnapshot,
  ManagedAgentState,
  ManagedAgentHealth,
  ManagedAgentMessageResult,
  ManagedAgentMessageResultInput,
  ManagedAgentMessageResultStatus,
  ManagedAgentMessagingPolicy,
  ManagedAgentRegistryConfig,
  ManagedAgentResourcePolicy,
  UpdateManagedAgentInput,
  WaitForManagedAgentMessageResultOptions,
} from "./types.js";

const MANAGED_AGENTS_DIRNAME = "agents";
const LOG_LINES_FALLBACK = 200;
const STOP_GRACE_MS = 15_000;
const MESSAGE_LINES_FALLBACK = 100;
const MESSAGE_RETENTION_LIMIT = 1_000;
const MESSAGE_RESULT_POLL_INTERVAL_MS = 250;
const STARTUP_READY_TIMEOUT_MS = 120_000;
const RESTART_STABILITY_WINDOW_MS = 60_000;
const SECRET_KEY_FILENAME = ".secret-key";
const CREDENTIALS_FILENAME = "credentials.json";

const DEFAULT_RESOURCES: ManagedAgentResourcePolicy = {
  maxMemoryMb: 512,
  maxConcurrentTasks: 10,
  rateLimitPerMinute: 60,
  llmRateLimitPerMinute: 30,
  restartOnCrash: true,
  maxRestarts: 3,
  restartBackoffMs: 5_000,
};

const DEFAULT_MESSAGING: ManagedAgentMessagingPolicy = {
  enabled: false,
  allowlist: [],
  maxMessagesPerMinute: 30,
};

const TEMPLATE_FILES = [
  "SOUL.md",
  "MEMORY.md",
  "IDENTITY.md",
  "USER.md",
  "STRATEGY.md",
  "SECURITY.md",
  "HEARTBEAT.md",
] as const;

type ManagedAgentChildProcess = ChildProcessByStdio<null, Readable, Readable>;

interface ManagedAgentProcessRecord {
  child: ManagedAgentChildProcess | null;
  logStream: WriteStream | null;
  state: ManagedAgentState;
  stopRequested: boolean;
  startedAt: number | null;
  lastError: string | null;
  stopTimer: ReturnType<typeof setTimeout> | null;
  restartCount: number;
  lastExitAt: string | null;
  lastExitCode: number | null;
  lastExitSignal: string | null;
  messageTimestamps: number[];
  startupTimer: ReturnType<typeof setTimeout> | null;
  restartStabilityTimer: ReturnType<typeof setTimeout> | null;
}

interface EncryptedSecret {
  encrypted: true;
  algorithm: "aes-256-gcm";
  iv: string;
  tag: string;
  ciphertext: string;
  updatedAt: string;
}

interface ManagedAgentCredentials {
  version: 1;
  botToken?: EncryptedSecret;
}

export interface ManagedAgentServiceOptions {
  rootDir?: string;
  primaryConfigPath: string;
  resolveCommand?: (configPath: string) => ManagedAgentCommand;
  restartStabilityWindowMs?: number;
}

function slugifyAgentId(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function nowIso(): string {
  return new Date().toISOString();
}

function isMessageResultStatus(value: unknown): value is ManagedAgentMessageResultStatus {
  return MANAGED_AGENT_MESSAGE_RESULT_STATUSES.includes(value as ManagedAgentMessageResultStatus);
}

function getAbortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new Error(signal.reason ? String(signal.reason) : "Operation aborted");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(getAbortError(signal));
  }
  return new Promise((resolve, reject) => {
    const abortSignal = signal;
    let onAbort: (() => void) | undefined;
    const cleanup = () => {
      if (abortSignal && onAbort) {
        abortSignal.removeEventListener("abort", onAbort);
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    timer.unref?.();
    if (abortSignal) {
      onAbort = () => {
        clearTimeout(timer);
        cleanup();
        reject(getAbortError(abortSignal));
      };
      abortSignal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function tailLines(text: string, lines: number): string[] {
  const normalized = text.replace(/\r\n/g, "\n").split("\n");
  if (normalized.length <= lines) return normalized;
  return normalized.slice(-lines);
}

function retainLatest<T>(items: T[], limit = MESSAGE_RETENTION_LIMIT): T[] {
  return items.length > limit ? items.slice(-limit) : items;
}

function mergeResources(input?: Partial<ManagedAgentResourcePolicy>): ManagedAgentResourcePolicy {
  return {
    ...DEFAULT_RESOURCES,
    ...input,
  };
}

function mergeMessaging(input?: Partial<ManagedAgentMessagingPolicy>): ManagedAgentMessagingPolicy {
  return {
    ...DEFAULT_MESSAGING,
    ...input,
    allowlist: input?.allowlist
      ? [...new Set(input.allowlist.filter(Boolean))]
      : DEFAULT_MESSAGING.allowlist,
  };
}

function normalizeTools(input?: string[]): string[] | undefined {
  if (!input) return undefined;
  return [...new Set(input.map((tool) => tool.trim()).filter(Boolean))];
}

function mergeRegistryConfig(
  base?: ManagedAgentRegistryConfig,
  input?: Partial<ManagedAgentRegistryConfig>
): ManagedAgentRegistryConfig {
  const next: ManagedAgentRegistryConfig = {
    ...DEFAULT_AGENT_REGISTRY_CONFIG,
    ...base,
    hookRules: base?.hookRules ? [...base.hookRules] : [],
  };

  if (!input) return next;

  if (input.hookRules !== undefined) {
    next.hookRules = [...new Set(input.hookRules.map((rule) => rule.trim()).filter(Boolean))];
  }
  if (input.provider !== undefined) {
    next.provider = input.provider?.trim() || null;
  }
  if (input.model !== undefined) {
    next.model = input.model?.trim() || null;
  }
  if (input.temperature !== undefined) {
    next.temperature = Number.isFinite(input.temperature) ? input.temperature : null;
  }
  if (input.maxTokens !== undefined) {
    next.maxTokens =
      Number.isFinite(input.maxTokens) && input.maxTokens !== null
        ? Math.max(1, Math.floor(input.maxTokens))
        : null;
  }
  if (input.maxToolCallsPerTurn !== undefined) {
    next.maxToolCallsPerTurn =
      Number.isFinite(input.maxToolCallsPerTurn) && input.maxToolCallsPerTurn !== null
        ? Math.max(1, Math.floor(input.maxToolCallsPerTurn))
        : null;
  }

  return next;
}

function resolveRegistryType(
  input: CreateManagedAgentInput | UpdateManagedAgentInput,
  sourceDefinition?: ManagedAgentDefinition | null
): {
  type: string;
  archetype: ManagedAgentArchetype | null;
} {
  const type = input.type?.trim() || sourceDefinition?.type || "CustomAgent";
  return {
    type,
    archetype: getBuiltInAgentArchetype(type),
  };
}

function maskPhone(phone: string | undefined): string | null {
  if (!phone) return null;
  const trimmed = phone.trim();
  if (trimmed.length <= 4) return "***";
  const prefix = trimmed.startsWith("+") ? "+" : "";
  return `${prefix}${"*".repeat(Math.max(3, trimmed.length - prefix.length - 2))}${trimmed.slice(-2)}`;
}

function normalizePersonalConnection(
  input?: ManagedAgentPersonalConnectionInput
): ManagedAgentPersonalConnectionInput | undefined {
  if (!input) return undefined;
  const apiId = Number(input.apiId);
  const apiHash = input.apiHash?.trim();
  const phone = input.phone?.trim();

  if (!apiId && !apiHash && !phone) return undefined;
  return {
    apiId: Number.isFinite(apiId) ? apiId : undefined,
    apiHash: apiHash || undefined,
    phone: phone || undefined,
  };
}

export class ManagedAgentService {
  private readonly rootDir: string;
  private readonly agentsRoot: string;
  private readonly primaryConfigPath: string;
  private readonly resolveCommand: (configPath: string) => ManagedAgentCommand;
  private readonly restartStabilityWindowMs: number;
  private readonly processes = new Map<string, ManagedAgentProcessRecord>();

  constructor(options: ManagedAgentServiceOptions) {
    this.rootDir = options.rootDir ?? TELETON_ROOT;
    this.agentsRoot = join(this.rootDir, MANAGED_AGENTS_DIRNAME);
    this.primaryConfigPath = options.primaryConfigPath;
    this.resolveCommand = options.resolveCommand ?? this.defaultResolveCommand;
    this.restartStabilityWindowMs = Math.max(
      0,
      options.restartStabilityWindowMs ?? RESTART_STABILITY_WINDOW_MS
    );
  }

  listArchetypes(): ManagedAgentArchetype[] {
    return listBuiltInAgentArchetypes();
  }

  listAgentSnapshots(): ManagedAgentSnapshot[] {
    return this.listDefinitions().map((definition) => this.toSnapshot(definition));
  }

  getAgentSnapshot(id: string): ManagedAgentSnapshot {
    return this.toSnapshot(this.readDefinition(id));
  }

  createAgent(input: CreateManagedAgentInput): ManagedAgentSnapshot {
    const name = input.name.trim();
    if (!name) {
      throw new Error("Agent name is required");
    }

    const id = this.resolveUniqueId(input.id ?? name);
    const homePath = join(this.agentsRoot, id);
    const configPath = join(homePath, "config.yaml");
    const workspacePath = join(homePath, "workspace");
    const logPath = join(homePath, "logs", "agent.log");
    const sourceId = input.cloneFromId ?? null;
    const sourceDefinition = sourceId ? this.readDefinition(sourceId) : null;
    const sourceConfigPath = sourceDefinition?.configPath ?? this.primaryConfigPath;
    const sourceRoot = sourceDefinition?.homePath ?? this.rootDir;
    const mode: ManagedAgentMode = input.mode ?? sourceDefinition?.mode ?? "personal";
    const sourceConfig = loadConfig(sourceConfigPath);
    const { type, archetype } = resolveRegistryType(input, sourceDefinition);
    const typeProvided = Boolean(input.type?.trim());
    const description =
      input.description?.trim() ||
      (typeProvided ? archetype?.description : sourceDefinition?.description) ||
      archetype?.description ||
      "";
    const soulTemplate =
      input.soulTemplate?.trim() ||
      (typeProvided ? archetype?.soulTemplate : sourceDefinition?.soulTemplate) ||
      archetype?.soulTemplate ||
      sourceConfig.agent.system_prompt ||
      "";
    const tools =
      normalizeTools(input.tools) ??
      (typeProvided
        ? archetype?.tools
          ? [...archetype.tools]
          : undefined
        : sourceDefinition?.tools
          ? [...sourceDefinition.tools]
          : undefined) ??
      (archetype?.tools ? [...archetype.tools] : []);
    const registryConfig = mergeRegistryConfig(
      typeProvided ? archetype?.config : (sourceDefinition?.config ?? archetype?.config),
      input.config
    );
    const personalConnection = normalizePersonalConnection(input.personalConnection);
    const explicitBotToken = input.botToken?.trim();
    const inheritedBotToken = sourceDefinition
      ? this.resolveBotToken(sourceDefinition, sourceConfig)
      : sourceConfig.telegram.bot_token?.trim();
    const botToken = explicitBotToken || inheritedBotToken || undefined;
    const botUsername =
      input.botUsername?.trim() ||
      sourceDefinition?.connection.botUsername ||
      sourceConfig.telegram.bot_username ||
      null;
    const memoryPolicy: ManagedAgentMemoryPolicy =
      input.memoryPolicy ?? sourceDefinition?.memoryPolicy ?? archetype?.memoryPolicy ?? "isolated";
    const resources = mergeResources({
      ...(archetype?.resources ?? {}),
      ...(sourceDefinition?.resources ?? {}),
      ...(input.resources ?? {}),
    });
    const messaging = mergeMessaging({
      ...(archetype?.messaging ?? {}),
      ...(sourceDefinition?.messaging ?? {}),
      ...(input.messaging ?? {}),
    });
    const personalAccountAccessConfirmedAt =
      mode === "personal"
        ? input.acknowledgePersonalAccountAccess
          ? nowIso()
          : (sourceDefinition?.security.personalAccountAccessConfirmedAt ?? null)
        : null;

    if (mode === "bot" && !botToken) {
      throw new Error("Bot-mode managed agents require a bot token");
    }
    if (mode === "bot" && botToken) {
      const tokenFormatError = validateBotTokenFormat(botToken);
      if (tokenFormatError) {
        throw new Error(`Invalid bot token: ${tokenFormatError}`);
      }
    }
    if (mode === "personal" && !personalAccountAccessConfirmedAt) {
      throw new Error(
        "Personal-mode managed agents require explicit private-account access consent"
      );
    }

    mkdirSync(homePath, { recursive: true, mode: 0o700 });
    mkdirSync(join(homePath, "logs"), { recursive: true, mode: 0o700 });
    mkdirSync(join(homePath, "messages"), { recursive: true, mode: 0o700 });

    this.bootstrapWorkspace(sourceRoot, homePath);
    this.writeSoulTemplate(homePath, soulTemplate);

    const managedConfig = this.prepareManagedConfig(sourceConfig, homePath, {
      mode,
      botUsername,
      personalConnection,
      resources,
      registryConfig,
      soulTemplate,
    });
    if (mode === "personal") {
      this.validatePersonalConnectionConfig(managedConfig);
    }
    saveConfig(managedConfig, configPath);

    const timestamp = nowIso();
    const definition: ManagedAgentDefinition = {
      id,
      name,
      type,
      description,
      mode,
      soulTemplate,
      tools,
      config: registryConfig,
      memoryPolicy,
      resources,
      messaging,
      security: {
        personalAccountAccessConfirmedAt,
      },
      connection: {
        botUsername,
      },
      homePath,
      configPath,
      workspacePath,
      logPath,
      createdAt: timestamp,
      updatedAt: timestamp,
      sourceId,
    };

    this.writeDefinition(definition);
    if (mode === "bot" && botToken) {
      this.writeBotToken(definition, botToken);
    }
    writeFileSync(
      logPath,
      `[${timestamp}] Created ${mode} managed agent "${name}" from ${sourceId ?? "primary"}\n`,
      "utf-8"
    );
    this.writeMessages(definition, []);
    this.writeMessageResults(definition, []);

    return this.toSnapshot(definition);
  }

  deleteAgent(id: string): void {
    const record = this.processes.get(id);
    if (
      record &&
      (record.state === "starting" || record.state === "running" || record.state === "stopping")
    ) {
      throw new Error("Stop the agent before deleting it");
    }

    const definition = this.readDefinition(id);
    this.processes.delete(id);
    rmSync(definition.homePath, { recursive: true, force: true });
  }

  startAgent(id: string): ManagedAgentRuntimeStatus {
    const definition = this.readDefinition(id);
    const record = this.ensureProcessRecord(id);
    const config = loadConfig(definition.configPath);
    const botToken =
      definition.mode === "bot" ? this.resolveBotToken(definition, config) : undefined;

    if (record.state === "starting" || record.state === "running") {
      throw new Error("Agent is already running");
    }
    if (record.state === "stopping") {
      throw new Error("Agent is currently stopping");
    }
    if (definition.memoryPolicy !== "isolated") {
      throw new Error(
        `Managed agent "${definition.id}" uses memory policy "${definition.memoryPolicy}", but only "isolated" is startable today`
      );
    }
    if (definition.mode === "bot" && !botToken) {
      throw new Error("Bot-mode managed agents require telegram.bot_token before they can start");
    }
    if (definition.mode === "bot" && botToken) {
      const tokenFormatError = validateBotTokenFormat(botToken);
      if (tokenFormatError) {
        throw new Error(`Invalid bot token: ${tokenFormatError}`);
      }
    }
    if (definition.mode === "personal") {
      this.validatePersonalConnectionConfig(config);
      if (!this.hasPersonalSession(config)) {
        throw new Error(
          "Personal-mode managed agents require a verified Telegram auth session before they can start"
        );
      }
    }

    mkdirSync(join(definition.homePath, "logs"), { recursive: true, mode: 0o700 });
    const logStream = createWriteStream(definition.logPath, { flags: "a" });
    const command = this.resolveCommand(definition.configPath);
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      TELETON_HOME: definition.homePath,
      TELETON_WEBUI_ENABLED: "false",
      TELETON_API_ENABLED: "false",
      TELETON_JSON_CREDENTIALS: "false",
      TELETON_MANAGED_AGENT_MODE: definition.mode,
      TELETON_AGENT_MAX_CONCURRENT_TASKS: String(definition.resources.maxConcurrentTasks),
      TELETON_AGENT_RATE_LIMIT_PER_MINUTE: String(definition.resources.rateLimitPerMinute),
      TELETON_AGENT_LLM_RATE_LIMIT_PER_MINUTE: String(definition.resources.llmRateLimitPerMinute),
    };
    const nodeOptions = this.buildNodeOptions(definition.resources);
    if (nodeOptions) {
      childEnv.NODE_OPTIONS = nodeOptions;
    }
    if (botToken) {
      childEnv.TELETON_TG_BOT_TOKEN = botToken;
    }

    const child = spawn(command.command, command.args, {
      cwd: definition.homePath,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    record.child = child;
    record.logStream = logStream;
    record.state = "starting";
    record.stopRequested = false;
    record.startedAt = null;
    record.lastError = null;
    record.lastExitAt = null;
    record.lastExitCode = null;
    record.lastExitSignal = null;

    this.appendLog(logStream, `\n[${nowIso()}] Starting managed agent "${definition.name}"\n`);

    record.startupTimer = setTimeout(() => {
      if (record.state === "starting" && record.child) {
        record.state = "error";
        record.lastError = `Agent did not report readiness within ${STARTUP_READY_TIMEOUT_MS}ms`;
        this.appendLog(logStream, `[${nowIso()}] ${record.lastError}\n`);
        record.child.kill("SIGTERM");
      }
    }, STARTUP_READY_TIMEOUT_MS);
    record.startupTimer.unref();

    child.stdout.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      this.appendLog(logStream, text);
      if (record.state === "starting" && text.includes("Teleton Agent is running!")) {
        record.state = "running";
        record.startedAt = Date.now();
        this.clearStartupTimer(record);
        this.scheduleRestartCountReset(record, logStream);
      }
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      this.appendLog(logStream, chunk.toString());
    });

    child.once("error", (error) => {
      record.lastError = getErrorMessage(error);
      record.state = "error";
      record.child = null;
      record.startedAt = null;
      this.clearStopTimer(record);
      this.clearStartupTimer(record);
      this.clearRestartStabilityTimer(record);
      this.closeLogStream(record);
    });

    child.once("exit", (code, signal) => {
      const expectedStop = record.stopRequested;
      record.child = null;
      record.stopRequested = false;
      record.startedAt = null;
      this.clearStopTimer(record);
      this.clearStartupTimer(record);
      this.clearRestartStabilityTimer(record);

      if (expectedStop || code === 0) {
        record.state = "stopped";
        record.lastError = null;
      } else {
        record.state = "error";
        record.lastError = `Process exited with code ${code ?? "null"}${signal ? ` (${signal})` : ""}`;
      }
      record.lastExitAt = nowIso();
      record.lastExitCode = code ?? null;
      record.lastExitSignal = signal ?? null;

      this.appendLog(
        logStream,
        `\n[${nowIso()}] Managed agent exited: ${record.lastError ?? "clean shutdown"}\n`
      );

      if (
        !expectedStop &&
        code !== 0 &&
        definition.resources.restartOnCrash &&
        record.restartCount < definition.resources.maxRestarts
      ) {
        record.restartCount += 1;
        const restartDelay = Math.max(0, definition.resources.restartBackoffMs);
        this.appendLog(
          logStream,
          `[${nowIso()}] Restarting managed agent in ${restartDelay}ms ` +
            `(attempt ${record.restartCount}/${definition.resources.maxRestarts})\n`
        );
        setTimeout(() => {
          try {
            this.startAgent(id);
          } catch (error) {
            record.lastError = getErrorMessage(error);
          }
        }, restartDelay).unref();
      }

      this.closeLogStream(record);
    });

    return this.getRuntimeStatus(id);
  }

  stopAgent(id: string): ManagedAgentRuntimeStatus {
    const record = this.ensureProcessRecord(id);

    if (record.state === "stopped" || record.state === "error" || !record.child) {
      throw new Error("Agent is not running");
    }
    if (record.state === "stopping") {
      throw new Error("Agent is already stopping");
    }

    record.stopRequested = true;
    record.state = "stopping";
    record.child.kill("SIGTERM");
    record.stopTimer = setTimeout(() => {
      if (record.child && !record.child.killed) {
        record.child.kill("SIGKILL");
      }
    }, STOP_GRACE_MS);
    record.stopTimer.unref();

    return this.getRuntimeStatus(id);
  }

  async stopAll(): Promise<void> {
    const activeIds = [...this.processes.entries()]
      .filter(([, record]) => record.child)
      .map(([id]) => id);

    for (const id of activeIds) {
      try {
        this.stopAgent(id);
      } catch {
        // Ignore agents that are already down.
      }
    }

    if (activeIds.length === 0) return;

    await Promise.all(
      activeIds.map(
        (id) =>
          new Promise<void>((resolve) => {
            const interval = setInterval(() => {
              const state = this.getRuntimeStatus(id).state;
              if (state === "stopped" || state === "error") {
                clearInterval(interval);
                resolve();
              }
            }, 100);
            interval.unref();
          })
      )
    );
  }

  getRuntimeStatus(id: string): ManagedAgentRuntimeStatus {
    const definition = this.readDefinition(id);
    const record = this.ensureProcessRecord(id);
    const uptimeMs = record.startedAt ? Math.max(0, Date.now() - record.startedAt) : null;
    const pendingMessages = this.readMessagesFile(definition).length;
    return {
      state: record.state,
      pid: record.child?.pid ?? null,
      startedAt: record.startedAt ? new Date(record.startedAt).toISOString() : null,
      uptimeMs,
      lastError: record.lastError,
      transport: definition.mode === "bot" ? "bot-api" : "mtproto",
      health: this.deriveHealth(record, pendingMessages),
      restartCount: record.restartCount,
      lastExitAt: record.lastExitAt,
      lastExitCode: record.lastExitCode,
      lastExitSignal: record.lastExitSignal,
      pendingMessages,
    };
  }

  readLogs(id: string, lines = LOG_LINES_FALLBACK): { lines: string[]; path: string } {
    const definition = this.readDefinition(id);
    if (!existsSync(definition.logPath)) {
      return { lines: [], path: definition.logPath };
    }

    const raw = readFileSync(definition.logPath, "utf-8");
    return {
      lines: tailLines(raw, Math.max(1, Math.min(lines, 2_000))).filter(Boolean),
      path: definition.logPath,
    };
  }

  updateAgent(id: string, input: UpdateManagedAgentInput): ManagedAgentSnapshot {
    const definition = this.readDefinition(id);
    const record = this.ensureProcessRecord(id);

    if (record.state === "starting" || record.state === "running" || record.state === "stopping") {
      throw new Error("Stop the managed agent before editing its configuration");
    }

    const { type, archetype } = resolveRegistryType(input, definition);
    const typeChanged = type !== definition.type;
    const description =
      input.description !== undefined
        ? input.description.trim()
        : typeChanged
          ? (archetype?.description ?? definition.description)
          : definition.description;
    const soulTemplate =
      input.soulTemplate !== undefined
        ? input.soulTemplate.trim()
        : typeChanged
          ? (archetype?.soulTemplate ?? definition.soulTemplate)
          : definition.soulTemplate;
    const tools =
      normalizeTools(input.tools) ??
      (typeChanged && archetype?.tools ? [...archetype.tools] : [...definition.tools]);
    const registryConfig = mergeRegistryConfig(
      typeChanged ? (archetype?.config ?? definition.config) : definition.config,
      input.config
    );
    const nextDefinition: ManagedAgentDefinition = {
      ...definition,
      name: input.name?.trim() || definition.name,
      type,
      description,
      soulTemplate,
      tools,
      config: registryConfig,
      memoryPolicy: input.memoryPolicy ?? definition.memoryPolicy,
      resources: mergeResources({ ...definition.resources, ...input.resources }),
      messaging: mergeMessaging({ ...definition.messaging, ...input.messaging }),
      security: {
        personalAccountAccessConfirmedAt:
          definition.mode === "personal"
            ? input.acknowledgePersonalAccountAccess
              ? nowIso()
              : definition.security.personalAccountAccessConfirmedAt
            : null,
      },
      connection: {
        botUsername:
          input.botUsername === null
            ? null
            : input.botUsername?.trim() || definition.connection.botUsername,
      },
      updatedAt: nowIso(),
    };

    if (
      nextDefinition.mode === "personal" &&
      !nextDefinition.security.personalAccountAccessConfirmedAt
    ) {
      throw new Error(
        "Personal-mode managed agents require explicit private-account access consent"
      );
    }

    const config = loadConfig(definition.configPath);
    this.applyResourcePolicyToConfig(config, nextDefinition.resources);
    this.applyRegistryConfigToConfig(config, registryConfig, soulTemplate);
    let nextBotToken: string | undefined;
    if (nextDefinition.mode === "bot") {
      nextBotToken =
        input.botToken === null
          ? ""
          : input.botToken?.trim() || this.resolveBotToken(definition, config) || "";
      if (!nextBotToken) {
        throw new Error("Bot-mode managed agents require a bot token");
      }
      const tokenFormatError = validateBotTokenFormat(nextBotToken);
      if (tokenFormatError) {
        throw new Error(`Invalid bot token: ${tokenFormatError}`);
      }
      config.telegram.bot_token = undefined;
      config.telegram.bot_username = nextDefinition.connection.botUsername ?? undefined;
      config.deals.enabled = false;
    } else if (input.botToken === null) {
      config.telegram.bot_token = undefined;
      config.telegram.bot_username = undefined;
    } else {
      if (input.botToken?.trim()) {
        config.telegram.bot_token = input.botToken.trim();
      }
      if (input.botUsername !== undefined) {
        config.telegram.bot_username = nextDefinition.connection.botUsername ?? undefined;
      }
    }
    const personalConnection = normalizePersonalConnection(input.personalConnection);
    if (nextDefinition.mode === "personal") {
      const personalConnectionChanged = this.applyPersonalConnectionToConfig(
        config,
        personalConnection
      );
      this.validatePersonalConnectionConfig(config);
      if (personalConnectionChanged) {
        this.invalidatePersonalAuth(config);
      }
    }

    saveConfig(config, definition.configPath);
    this.writeSoulTemplate(definition.homePath, soulTemplate);
    this.writeDefinition(nextDefinition);
    if (nextDefinition.mode === "bot" && nextBotToken) {
      this.writeBotToken(nextDefinition, nextBotToken);
    }
    return this.toSnapshot(nextDefinition);
  }

  readMessages(id: string, limit = MESSAGE_LINES_FALLBACK): { messages: ManagedAgentMessage[] } {
    const definition = this.readDefinition(id);
    const messages = this.readMessagesFile(definition);
    return {
      messages: messages.slice(-Math.max(1, Math.min(limit, 500))),
    };
  }

  readMessageResult(agentId: string, messageId: string): ManagedAgentMessageResult | null {
    const definition = this.readDefinition(agentId);
    return (
      this.readMessageResultsFile(definition).find((result) => result.messageId === messageId) ??
      null
    );
  }

  recordMessageResult(
    agentId: string,
    messageId: string,
    input: ManagedAgentMessageResultInput = {}
  ): ManagedAgentMessageResult {
    const definition = this.readDefinition(agentId);
    const message = this.readMessagesFile(definition).find((item) => item.id === messageId);
    if (!message) {
      throw new Error(`Managed agent message not found: ${messageId}`);
    }

    const status = input.status ?? (input.error ? "failed" : "completed");
    if (!isMessageResultStatus(status)) {
      throw new Error(
        `Managed agent message result status must be one of: ${MANAGED_AGENT_MESSAGE_RESULT_STATUSES.join(
          ", "
        )}`
      );
    }

    const error =
      input.error ?? (status === "cancelled" ? "Managed agent message cancelled" : null);
    if (status === "failed" && !error) {
      throw new Error("Failed managed agent message results require an error");
    }

    const result: ManagedAgentMessageResult = {
      messageId,
      fromId: definition.id,
      toId: message.fromId,
      status,
      content: input.content ?? null,
      error: status === "completed" ? null : error,
      completedAt: nowIso(),
    };

    const existing = this.readMessageResultsFile(definition).filter(
      (item) => item.messageId !== messageId
    );
    existing.push(result);
    this.writeMessageResults(definition, existing);
    return result;
  }

  async waitForMessageResult(
    messageId: string,
    options: WaitForManagedAgentMessageResultOptions = {}
  ): Promise<ManagedAgentMessageResult> {
    const timeoutSeconds =
      options.timeoutSeconds !== undefined && options.timeoutSeconds > 0
        ? options.timeoutSeconds
        : undefined;
    const deadline = timeoutSeconds ? Date.now() + timeoutSeconds * 1000 : null;
    const pollIntervalMs = Math.max(
      10,
      Math.min(options.pollIntervalMs ?? MESSAGE_RESULT_POLL_INTERVAL_MS, 5_000)
    );

    while (true) {
      if (options.signal?.aborted) {
        throw getAbortError(options.signal);
      }

      const result = this.findMessageResult(messageId, options.agentId);
      if (result) return result;

      if (deadline && Date.now() >= deadline) {
        throw new Error(
          `Managed agent message ${messageId} timed out after ${timeoutSeconds} seconds`
        );
      }

      const remainingMs = deadline ? Math.max(0, deadline - Date.now()) : pollIntervalMs;
      await sleep(Math.min(pollIntervalMs, Math.max(10, remainingMs)), options.signal);
    }
  }

  sendMessage(fromId: string, toId: string, text: string): ManagedAgentMessage {
    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error("Inter-agent messages cannot be empty");
    }
    if (fromId === toId) {
      throw new Error("Managed agents cannot send messages to themselves");
    }

    const target = this.readDefinition(toId);
    if (!target.messaging.enabled) {
      throw new Error(`Managed agent "${toId}" has inter-agent messaging disabled`);
    }
    if (target.messaging.allowlist.length > 0 && !target.messaging.allowlist.includes(fromId)) {
      throw new Error(`Managed agent "${fromId}" is not allowed to message "${toId}"`);
    }

    const senderPolicy =
      fromId === "primary" ? DEFAULT_MESSAGING : this.readDefinition(fromId).messaging;
    const timestamps = this.getMessageTimestamps(fromId);
    const cutoff = Date.now() - 60_000;
    const recent = timestamps.filter((timestamp) => timestamp > cutoff);
    if (recent.length >= senderPolicy.maxMessagesPerMinute) {
      throw new Error(`Managed agent "${fromId}" exceeded its inter-agent message rate limit`);
    }
    recent.push(Date.now());
    this.setMessageTimestamps(fromId, recent);

    const message: ManagedAgentMessage = {
      id: randomUUID(),
      fromId,
      toId,
      text: trimmed,
      createdAt: nowIso(),
      deliveredAt: null,
    };

    const existing = this.readMessagesFile(target);
    existing.push(message);
    this.writeMessages(target, existing);
    return message;
  }

  resolvePersonalAuthTarget(
    id: string,
    input?: ManagedAgentPersonalConnectionInput
  ): ManagedAgentPersonalAuthTarget & {
    apiId: number;
    apiHash: string;
    phone: string;
  } {
    const definition = this.readDefinition(id);
    if (definition.mode !== "personal") {
      throw new Error("Telegram personal auth is only available for personal-mode agents");
    }
    if (!definition.security.personalAccountAccessConfirmedAt) {
      throw new Error(
        "Personal-mode managed agents require explicit private-account access consent"
      );
    }

    const config = loadConfig(definition.configPath);
    const overrides = normalizePersonalConnection(input);
    const personalConnectionChanged = this.applyPersonalConnectionToConfig(config, overrides);
    this.validatePersonalConnectionConfig(config);
    if (personalConnectionChanged) {
      this.invalidatePersonalAuth(config);
    }
    saveConfig(config, definition.configPath);
    const mtprotoProxies =
      config.mtproto?.enabled && config.mtproto.proxies.length > 0
        ? config.mtproto.proxies
        : undefined;

    return {
      configPath: definition.configPath,
      sessionPath: config.telegram.session_path,
      apiId: config.telegram.api_id,
      apiHash: config.telegram.api_hash,
      phone: config.telegram.phone,
      mtprotoProxies,
    };
  }

  recordPersonalAuth(id: string): ManagedAgentSnapshot {
    const definition = this.readDefinition(id);
    if (definition.mode !== "personal") {
      throw new Error("Telegram personal auth is only available for personal-mode agents");
    }

    const nextDefinition: ManagedAgentDefinition = {
      ...definition,
      updatedAt: nowIso(),
    };
    this.writeDefinition(nextDefinition);
    return this.toSnapshot(nextDefinition);
  }

  private listDefinitions(): ManagedAgentDefinition[] {
    if (!existsSync(this.agentsRoot)) return [];

    return readdirSync(this.agentsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(this.agentsRoot, entry.name, "manifest.json"))
      .filter((manifestPath) => existsSync(manifestPath))
      .map((manifestPath) =>
        this.normalizeDefinition(readJsonFile<ManagedAgentDefinition>(manifestPath))
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  private readDefinition(id: string): ManagedAgentDefinition {
    const manifestPath = join(this.agentsRoot, id, "manifest.json");
    if (!existsSync(manifestPath)) {
      throw new Error(`Managed agent "${id}" does not exist`);
    }
    return this.normalizeDefinition(readJsonFile<ManagedAgentDefinition>(manifestPath));
  }

  private writeDefinition(definition: ManagedAgentDefinition): void {
    mkdirSync(definition.homePath, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(definition.homePath, "manifest.json"),
      JSON.stringify(definition, null, 2),
      "utf-8"
    );
  }

  private toSnapshot(definition: ManagedAgentDefinition): ManagedAgentSnapshot {
    const config = loadConfig(definition.configPath);
    const status = this.getRuntimeStatus(definition.id);
    return {
      ...definition,
      ...status,
      status: status.state,
      provider: config.agent.provider,
      model: config.agent.model,
      ownerId: config.telegram.owner_id ?? null,
      adminIds: config.telegram.admin_ids ?? [],
      hasBotToken: Boolean(this.resolveBotToken(definition, config)),
      hasPersonalCredentials:
        definition.mode === "personal" ? this.hasPersonalCredentials(config) : false,
      hasPersonalSession: definition.mode === "personal" ? this.hasPersonalSession(config) : false,
      personalPhoneMasked: definition.mode === "personal" ? maskPhone(config.telegram.phone) : null,
    };
  }

  private resolveUniqueId(base: string): string {
    const initial = slugifyAgentId(base) || "agent";
    let candidate = initial;
    let counter = 2;

    while (existsSync(join(this.agentsRoot, candidate))) {
      candidate = `${initial}-${counter}`;
      counter += 1;
    }

    return candidate;
  }

  private prepareManagedConfig(
    sourceConfig: Config,
    homePath: string,
    options: {
      mode: ManagedAgentMode;
      botUsername?: string | null;
      personalConnection?: ManagedAgentPersonalConnectionInput;
      resources: ManagedAgentResourcePolicy;
      registryConfig: ManagedAgentRegistryConfig;
      soulTemplate: string;
    }
  ): Config {
    const next = structuredClone(sourceConfig);
    next.telegram.session_path = join(homePath, "telegram_session.txt");
    next.storage.sessions_file = join(homePath, "sessions.json");
    next.storage.memory_file = join(homePath, "memory.json");
    this.applyResourcePolicyToConfig(next, options.resources);
    this.applyRegistryConfigToConfig(next, options.registryConfig, options.soulTemplate);
    if (options.mode === "bot") {
      next.telegram.bot_token = undefined;
      next.telegram.bot_username = options.botUsername ?? undefined;
      next.deals.enabled = false;
    } else {
      this.applyPersonalConnectionToConfig(next, options.personalConnection);
    }
    next.webui.enabled = false;
    if (next.api) {
      next.api.enabled = false;
    }
    if (next.ton_proxy) {
      next.ton_proxy.enabled = false;
    }
    next.dev.hot_reload = false;
    next.meta.created_at = next.meta.created_at ?? nowIso();
    next.meta.last_modified_at = nowIso();
    return next;
  }

  private bootstrapWorkspace(sourceRoot: string, targetRoot: string): void {
    const sourceWorkspace = join(sourceRoot, "workspace");
    const targetWorkspace = join(targetRoot, "workspace");
    const sourcePlugins = join(sourceRoot, "plugins");
    const targetPlugins = join(targetRoot, "plugins");

    if (existsSync(sourceWorkspace)) {
      cpSync(sourceWorkspace, targetWorkspace, { recursive: true, force: true });
    } else {
      mkdirSync(targetWorkspace, { recursive: true, mode: 0o700 });
      for (const filename of TEMPLATE_FILES) {
        writeFileSync(join(targetWorkspace, filename), loadTemplate(filename), "utf-8");
      }
      mkdirSync(join(targetWorkspace, "memory"), { recursive: true, mode: 0o700 });
      mkdirSync(join(targetWorkspace, "downloads"), { recursive: true, mode: 0o700 });
      mkdirSync(join(targetWorkspace, "uploads"), { recursive: true, mode: 0o700 });
      mkdirSync(join(targetWorkspace, "temp"), { recursive: true, mode: 0o700 });
      mkdirSync(join(targetWorkspace, "memes"), { recursive: true, mode: 0o700 });
    }

    if (existsSync(sourcePlugins)) {
      mkdirSync(targetPlugins, { recursive: true, mode: 0o700 });
      for (const entry of readdirSync(sourcePlugins, { withFileTypes: true })) {
        if (entry.name === "data") continue;
        cpSync(join(sourcePlugins, entry.name), join(targetPlugins, entry.name), {
          recursive: true,
          force: true,
        });
      }
    }
  }

  private writeSoulTemplate(homePath: string, soulTemplate: string): void {
    const trimmed = soulTemplate.trim();
    if (!trimmed) return;
    const workspacePath = join(homePath, "workspace");
    mkdirSync(workspacePath, { recursive: true, mode: 0o700 });
    writeFileSync(join(workspacePath, "SOUL.md"), `${trimmed}\n`, "utf-8");
  }

  private applyRegistryConfigToConfig(
    config: Config,
    registryConfig: ManagedAgentRegistryConfig,
    soulTemplate: string
  ): void {
    if (registryConfig.provider) {
      config.agent.provider = registryConfig.provider as Config["agent"]["provider"];
    }
    if (registryConfig.model) {
      config.agent.model = registryConfig.model;
    }
    if (registryConfig.temperature !== null) {
      config.agent.temperature = registryConfig.temperature;
    }
    if (registryConfig.maxTokens !== null) {
      config.agent.max_tokens = registryConfig.maxTokens;
    }
    if (registryConfig.maxToolCallsPerTurn !== null) {
      config.agent.max_agentic_iterations = registryConfig.maxToolCallsPerTurn;
    }
    if (soulTemplate.trim()) {
      config.agent.system_prompt = soulTemplate.trim();
    }
  }

  private applyResourcePolicyToConfig(config: Config, resources: ManagedAgentResourcePolicy): void {
    config.telegram.rate_limit_groups_per_minute = Math.max(
      1,
      Math.floor(resources.rateLimitPerMinute)
    );
    config.telegram.rate_limit_messages_per_second = Math.max(
      0.1,
      resources.rateLimitPerMinute / 60
    );
  }

  private applyPersonalConnectionToConfig(
    config: Config,
    input?: ManagedAgentPersonalConnectionInput
  ): boolean {
    if (!input) return false;
    let changed = false;
    if (input.apiId !== undefined && config.telegram.api_id !== input.apiId) {
      config.telegram.api_id = input.apiId;
      changed = true;
    }
    if (input.apiHash !== undefined && config.telegram.api_hash !== input.apiHash) {
      config.telegram.api_hash = input.apiHash;
      changed = true;
    }
    if (input.phone !== undefined && config.telegram.phone !== input.phone) {
      config.telegram.phone = input.phone;
      changed = true;
    }
    return changed;
  }

  private invalidatePersonalAuth(config: Config): void {
    if (config.telegram.session_path) {
      rmSync(config.telegram.session_path, { force: true });
    }
    delete config.telegram.owner_id;
    delete config.telegram.owner_name;
    delete config.telegram.owner_username;
    config.telegram.admin_ids = [];
  }

  private validatePersonalConnectionConfig(config: Config): void {
    if (!this.hasPersonalCredentials(config)) {
      throw new Error(
        "Personal-mode managed agents require phone, api_id, and api_hash credentials"
      );
    }
  }

  private hasPersonalCredentials(config: Config): boolean {
    return Boolean(
      Number.isFinite(config.telegram.api_id) &&
      config.telegram.api_id > 0 &&
      config.telegram.api_hash?.trim() &&
      config.telegram.phone?.trim()
    );
  }

  private hasPersonalSession(config: Config): boolean {
    return existsSync(config.telegram.session_path);
  }

  private buildNodeOptions(resources: ManagedAgentResourcePolicy): string {
    const existing = process.env.NODE_OPTIONS?.trim();
    if (existing?.includes("--max-old-space-size")) {
      return existing;
    }

    const memoryMb = Math.max(64, Math.floor(resources.maxMemoryMb));
    return [existing, `--max-old-space-size=${memoryMb}`].filter(Boolean).join(" ");
  }

  private credentialsPath(definition: ManagedAgentDefinition): string {
    return join(definition.homePath, CREDENTIALS_FILENAME);
  }

  private readCredentials(definition: ManagedAgentDefinition): ManagedAgentCredentials {
    const path = this.credentialsPath(definition);
    if (!existsSync(path)) {
      return { version: 1 };
    }
    const parsed = readJsonFile<ManagedAgentCredentials>(path);
    return { ...parsed, version: 1 };
  }

  private writeCredentials(
    definition: ManagedAgentDefinition,
    credentials: ManagedAgentCredentials
  ): void {
    writeFileSync(this.credentialsPath(definition), JSON.stringify(credentials, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
  }

  private writeBotToken(definition: ManagedAgentDefinition, botToken: string): void {
    const credentials = this.readCredentials(definition);
    credentials.botToken = this.encryptSecret(botToken);
    this.writeCredentials(definition, credentials);
  }

  private resolveBotToken(definition: ManagedAgentDefinition, config: Config): string | undefined {
    const credentials = this.readCredentials(definition);
    if (credentials.botToken) {
      return this.decryptSecret(credentials.botToken);
    }
    return config.telegram.bot_token?.trim() || undefined;
  }

  private encryptSecret(value: string): EncryptedSecret {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.getSecretKey(), iv);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return {
      encrypted: true,
      algorithm: "aes-256-gcm",
      iv: iv.toString("hex"),
      tag: cipher.getAuthTag().toString("hex"),
      ciphertext: ciphertext.toString("hex"),
      updatedAt: nowIso(),
    };
  }

  private decryptSecret(secret: EncryptedSecret): string {
    const decipher = createDecipheriv(
      secret.algorithm,
      this.getSecretKey(),
      Buffer.from(secret.iv, "hex")
    );
    decipher.setAuthTag(Buffer.from(secret.tag, "hex"));
    return Buffer.concat([
      decipher.update(Buffer.from(secret.ciphertext, "hex")),
      decipher.final(),
    ]).toString("utf8");
  }

  private getSecretKey(): Buffer {
    mkdirSync(this.agentsRoot, { recursive: true, mode: 0o700 });
    const keyPath = join(this.agentsRoot, SECRET_KEY_FILENAME);
    try {
      const keyHex = readFileSync(keyPath, "utf-8").trim();
      if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) {
        throw new Error("Managed agent secret key is invalid");
      }
      return Buffer.from(keyHex, "hex");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const keyHex = randomBytes(32).toString("hex");
    try {
      writeFileSync(keyPath, `${keyHex}\n`, {
        encoding: "utf-8",
        mode: 0o600,
        flag: "wx",
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return this.getSecretKey();
    }
    return Buffer.from(keyHex, "hex");
  }

  private ensureProcessRecord(id: string): ManagedAgentProcessRecord {
    let record = this.processes.get(id);
    if (!record) {
      record = {
        child: null,
        logStream: null,
        state: "stopped",
        stopRequested: false,
        startedAt: null,
        lastError: null,
        stopTimer: null,
        restartCount: 0,
        lastExitAt: null,
        lastExitCode: null,
        lastExitSignal: null,
        messageTimestamps: [],
        startupTimer: null,
        restartStabilityTimer: null,
      };
      this.processes.set(id, record);
    }
    return record;
  }

  private appendLog(stream: WriteStream, text: string): void {
    stream.write(text);
  }

  private closeLogStream(record: ManagedAgentProcessRecord): void {
    record.logStream?.end();
    record.logStream = null;
  }

  private clearStopTimer(record: ManagedAgentProcessRecord): void {
    if (record.stopTimer) {
      clearTimeout(record.stopTimer);
      record.stopTimer = null;
    }
  }

  private clearStartupTimer(record: ManagedAgentProcessRecord): void {
    if (record.startupTimer) {
      clearTimeout(record.startupTimer);
      record.startupTimer = null;
    }
  }

  private scheduleRestartCountReset(
    record: ManagedAgentProcessRecord,
    logStream: WriteStream
  ): void {
    this.clearRestartStabilityTimer(record);
    if (record.restartCount === 0) return;

    record.restartStabilityTimer = setTimeout(() => {
      if (record.state !== "running" || !record.child) return;
      record.restartCount = 0;
      record.restartStabilityTimer = null;
      this.appendLog(
        logStream,
        `[${nowIso()}] Managed agent remained stable; restart budget reset\n`
      );
    }, this.restartStabilityWindowMs);
    record.restartStabilityTimer.unref();
  }

  private clearRestartStabilityTimer(record: ManagedAgentProcessRecord): void {
    if (record.restartStabilityTimer) {
      clearTimeout(record.restartStabilityTimer);
      record.restartStabilityTimer = null;
    }
  }

  private normalizeDefinition(definition: ManagedAgentDefinition): ManagedAgentDefinition {
    return {
      ...definition,
      type: definition.type ?? "CustomAgent",
      description: definition.description ?? "",
      soulTemplate: definition.soulTemplate ?? "",
      tools: normalizeTools(definition.tools) ?? [],
      config: mergeRegistryConfig(undefined, definition.config),
      memoryPolicy: definition.memoryPolicy ?? "isolated",
      resources: mergeResources(definition.resources),
      messaging: mergeMessaging(definition.messaging),
      security: {
        personalAccountAccessConfirmedAt:
          definition.security?.personalAccountAccessConfirmedAt ?? null,
      },
      connection: {
        botUsername: definition.connection?.botUsername ?? null,
      },
    };
  }

  private deriveHealth(
    record: ManagedAgentProcessRecord,
    pendingMessages: number
  ): ManagedAgentHealth {
    if (record.state === "error") return "error";
    if (record.state === "starting" || record.state === "stopping") return "starting";
    if (record.state === "stopped") return "stopped";
    return pendingMessages > 0 || record.restartCount > 0 ? "degraded" : "healthy";
  }

  private messagesPath(definition: ManagedAgentDefinition): string {
    return join(definition.homePath, "messages", "inbox.json");
  }

  private messageResultsPath(definition: ManagedAgentDefinition): string {
    return join(definition.homePath, "messages", "results.json");
  }

  private readMessagesFile(definition: ManagedAgentDefinition): ManagedAgentMessage[] {
    const path = this.messagesPath(definition);
    if (!existsSync(path)) return [];
    return readJsonFile<ManagedAgentMessage[]>(path);
  }

  private writeMessages(definition: ManagedAgentDefinition, messages: ManagedAgentMessage[]): void {
    mkdirSync(join(definition.homePath, "messages"), { recursive: true, mode: 0o700 });
    writeFileSync(
      this.messagesPath(definition),
      JSON.stringify(retainLatest(messages), null, 2),
      "utf-8"
    );
  }

  private readMessageResultsFile(definition: ManagedAgentDefinition): ManagedAgentMessageResult[] {
    const path = this.messageResultsPath(definition);
    if (!existsSync(path)) return [];
    return readJsonFile<ManagedAgentMessageResult[]>(path);
  }

  private writeMessageResults(
    definition: ManagedAgentDefinition,
    results: ManagedAgentMessageResult[]
  ): void {
    mkdirSync(join(definition.homePath, "messages"), { recursive: true, mode: 0o700 });
    writeFileSync(
      this.messageResultsPath(definition),
      JSON.stringify(retainLatest(results), null, 2),
      "utf-8"
    );
  }

  private findMessageResult(messageId: string, agentId?: string): ManagedAgentMessageResult | null {
    if (agentId) {
      return this.readMessageResult(agentId, messageId);
    }
    for (const definition of this.listDefinitions()) {
      const result = this.readMessageResultsFile(definition).find(
        (item) => item.messageId === messageId
      );
      if (result) return result;
    }
    return null;
  }

  private getMessageTimestamps(id: string): number[] {
    if (id === "primary") {
      return this.ensureProcessRecord("primary").messageTimestamps;
    }
    return this.ensureProcessRecord(id).messageTimestamps;
  }

  private setMessageTimestamps(id: string, timestamps: number[]): void {
    this.ensureProcessRecord(id).messageTimestamps = timestamps;
  }

  private defaultResolveCommand(configPath: string): ManagedAgentCommand {
    const scriptPath = process.argv[1];
    if (!scriptPath) {
      throw new Error("Cannot resolve the Teleton CLI entrypoint for managed agents");
    }
    return {
      command: process.execPath,
      args: [...process.execArgv, scriptPath, "start", "-c", configPath],
    };
  }
}
