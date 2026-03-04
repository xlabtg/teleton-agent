import pino from "pino";
import { Writable } from "node:stream";

// ── Types ─────────────────────────────────────────────────────────────
export type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace";

export interface LogListener {
  (entry: { level: "log" | "warn" | "error"; message: string; timestamp: number }): void;
}

// ── Log listener registry (replaces LogInterceptor monkey-patch) ──────
const listeners = new Set<LogListener>();

export function addLogListener(fn: LogListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function removeLogListener(fn: LogListener): void {
  listeners.delete(fn);
}

export function clearLogListeners(): void {
  listeners.clear();
}

// ── Pino level → WebUI LogEntry level mapping ─────────────────────────
const LEVEL_MAP: Record<number, "log" | "warn" | "error"> = {
  10: "log", // trace  → log
  20: "log", // debug  → log
  30: "log", // info   → log
  40: "warn", // warn   → warn
  50: "error", // error  → error
  60: "error", // fatal  → error
};

// ── Custom writable stream for WebUI SSE ──────────────────────────────
class WebUILogStream extends Writable {
  _write(chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void): void {
    if (listeners.size === 0) {
      callback();
      return;
    }

    try {
      const obj = JSON.parse(chunk.toString());
      const entry = {
        level: LEVEL_MAP[obj.level] ?? "log",
        message: obj.msg ?? "",
        timestamp: obj.time ?? Date.now(),
      };

      for (const fn of listeners) {
        try {
          fn(entry);
        } catch {
          // Don't let listener errors break logging
        }
      }
    } catch {
      // Malformed JSON — skip silently
    }

    callback();
  }
}

// ── Valid log levels ──────────────────────────────────────────────────
const VALID_LEVELS: readonly string[] = ["fatal", "error", "warn", "info", "debug", "trace"];

function isValidLevel(s: string): s is LogLevel {
  return VALID_LEVELS.includes(s);
}

// ── Resolve log level ─────────────────────────────────────────────────
function resolveLevel(): LogLevel {
  // TELETON_LOG_LEVEL takes priority
  const explicit = process.env.TELETON_LOG_LEVEL?.toLowerCase();
  if (explicit && isValidLevel(explicit)) {
    return explicit;
  }

  // Backward compat: TELETON_LOG=verbose → debug
  if (process.env.TELETON_LOG === "verbose") {
    return "debug";
  }

  return "info";
}

// ── Build pino multistream ────────────────────────────────────────────
const webUIStream = new WebUILogStream();

const usePretty = process.env.TELETON_LOG_PRETTY !== "false";

const stdoutStream = usePretty
  ? pino.transport({
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "HH:MM:ss",
        ignore: "pid,hostname,module",
        messageFormat: "{if module}[{module}] {end}{msg}",
      },
    })
  : pino.destination(1); // raw JSON to stdout

// Keep reference to multistream for runtime level updates
const initialLevel = resolveLevel();
const multiStream = pino.multistream([
  { stream: stdoutStream, level: initialLevel },
  { stream: webUIStream, level: "trace" }, // WebUI gets everything
]);

// ── Root logger instance ──────────────────────────────────────────────
const rootLogger = pino(
  {
    level: initialLevel,
    timestamp: pino.stdTimeFunctions.isoTime,
    base: null, // no pid/hostname noise
    redact: {
      paths: [
        "apiKey",
        "api_key",
        "password",
        "secret",
        "token",
        "mnemonic",
        "*.apiKey",
        "*.api_key",
        "*.password",
        "*.secret",
        "*.token",
        "*.mnemonic",
      ],
      censor: "[REDACTED]",
    },
  },
  multiStream
);

// ── Public API ────────────────────────────────────────────────────────

/**
 * Create a child logger with a module prefix.
 *
 * @example
 * const log = createLogger("Bot");
 * log.info("Deal accepted");       // [Bot] Deal accepted
 * log.error({ dealId }, "Failed"); // [Bot] Failed { dealId: 123 }
 */
export function createLogger(module: string): pino.Logger {
  return rootLogger.child({ module });
}

/** The root pino logger (no module prefix). */
export const logger = rootLogger;

/**
 * Apply logging config from YAML (called after config load in TonnetApp).
 * Wires config.logging.level to the live logger.
 * Note: pretty mode is controlled by TELETON_LOG_PRETTY env var only
 * (pino transport is fixed at module load time before config is available).
 */
export function initLoggerFromConfig(logging: { level?: string }): void {
  // Config level applies only if no env var override
  if (!process.env.TELETON_LOG_LEVEL && !process.env.TELETON_LOG) {
    const level = logging.level?.toLowerCase();
    if (level && isValidLevel(level)) {
      setLogLevel(level);
    }
  }
}

/**
 * Change log level at runtime (e.g. from admin /verbose command).
 * Updates both the root logger and the stdout multistream entry.
 */
export function setLogLevel(level: LogLevel): void {
  rootLogger.level = level;
  // Update stdout stream level so more-permissive changes actually take effect
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pino multistream internal API
  const streams = (multiStream as any).streams;
  if (Array.isArray(streams) && streams[0]) {
    streams[0].level = pino.levels.values[level] ?? 30;
  }
  _verbose = level === "debug" || level === "trace";
}

/**
 * Get current log level.
 */
export function getLogLevel(): string {
  return rootLogger.level;
}

// ── Backward compatibility ────────────────────────────────────────────

let _verbose = rootLogger.isLevelEnabled("debug");

/** @deprecated Use createLogger(module).debug() instead */
export function verbose(...args: unknown[]): void {
  if (_verbose) rootLogger.debug(args.map(String).join(" "));
}

/** @deprecated Use setLogLevel("debug") / setLogLevel("info") instead */
export function setVerbose(v: boolean): void {
  setLogLevel(v ? "debug" : "info");
}

/** @deprecated Use rootLogger.isLevelEnabled("debug") instead */
export function isVerbose(): boolean {
  return _verbose;
}
