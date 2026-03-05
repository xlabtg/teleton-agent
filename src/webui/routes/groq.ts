import { Hono } from "hono";
import type { WebUIServerDeps, APIResponse } from "../types.js";
import {
  GROQ_MODEL_REGISTRY,
  getGroqModelsByType,
  type GroqModelType,
} from "../../providers/groq/modelRegistry.js";
import { testGroqApiKey, groqListModels } from "../../providers/groq/GroqTextProvider.js";
import { GROQ_API_BASE, groqTranscribe } from "../../providers/groq/GroqSTTProvider.js";
import { groqSpeak, GROQ_TTS_VOICES } from "../../providers/groq/GroqTTSProvider.js";
import { getGroqSttModels, getGroqTtsModels } from "../../config/model-catalog.js";
import { getNestedValue, readRawConfig } from "../../config/configurable-keys.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("GroqRoutes");

/** Retrieve the Groq API key from the current config */
function getGroqApiKey(deps: WebUIServerDeps): string {
  try {
    const raw = readRawConfig(deps.configPath);
    return (getNestedValue(raw, "agent.api_key") as string) ?? "";
  } catch {
    return "";
  }
}

export function createGroqRoutes(deps: WebUIServerDeps) {
  const app = new Hono();

  // GET /api/groq/models — list models from the static registry
  app.get("/models", (c) => {
    const typeFilter = c.req.query("type") as GroqModelType | undefined;
    const models = typeFilter ? getGroqModelsByType(typeFilter) : GROQ_MODEL_REGISTRY;
    return c.json({ success: true, data: models } as APIResponse);
  });

  // GET /api/groq/models/live — list models dynamically from the Groq API
  app.get("/models/live", async (c) => {
    const apiKey = getGroqApiKey(deps);
    if (!apiKey) {
      return c.json({ success: false, error: "No Groq API key configured" } as APIResponse, 400);
    }

    try {
      const models = await groqListModels(apiKey);
      return c.json({ success: true, data: models } as APIResponse);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`Failed to fetch live Groq models: ${msg}`);
      return c.json({ success: false, error: msg } as APIResponse, 502);
    }
  });

  // GET /api/groq/models/stt — list STT model options
  app.get("/models/stt", (c) => {
    return c.json({ success: true, data: getGroqSttModels() } as APIResponse);
  });

  // GET /api/groq/models/tts — list TTS model options
  app.get("/models/tts", (c) => {
    return c.json({ success: true, data: getGroqTtsModels() } as APIResponse);
  });

  // GET /api/groq/tts/voices — list available TTS voices
  app.get("/tts/voices", (c) => {
    return c.json({ success: true, data: GROQ_TTS_VOICES } as APIResponse);
  });

  // POST /api/groq/test — test API key connectivity
  // Returns 200 on success, 400 for missing key, 401 for auth errors, 429 for rate limits, 502 for server errors.
  app.post("/test", async (c) => {
    let body: { apiKey?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, error: "Invalid JSON body" } as APIResponse, 400);
    }

    const apiKey = body.apiKey ?? getGroqApiKey(deps);
    if (!apiKey) {
      return c.json({ success: false, error: "No API key provided" } as APIResponse, 400);
    }

    const result = await testGroqApiKey(apiKey);
    if (!result.valid) {
      // Map Groq API status codes to appropriate HTTP responses
      const httpStatus =
        result.statusCode === 401
          ? 401
          : result.statusCode === 403
            ? 403
            : result.statusCode === 429
              ? 429
              : result.statusCode != null && result.statusCode >= 500
                ? 502
                : 400;

      return c.json(
        {
          success: false,
          error: result.error,
          hint: result.hint,
        } as APIResponse & { hint: string | null },
        httpStatus
      );
    }

    return c.json({ success: true, data: { valid: true } } as APIResponse);
  });

  // GET /api/groq/debug — diagnostic info (baseURL, headers shape, configured model)
  // Does not expose the API key value.
  app.get("/debug", (c) => {
    const apiKey = getGroqApiKey(deps);
    const keyValid = apiKey.startsWith("gsk_") && apiKey.length >= 20;
    return c.json({
      success: true,
      data: {
        baseURL: GROQ_API_BASE,
        authHeaderShape: apiKey
          ? "Authorization: Bearer gsk_***"
          : "Authorization: Bearer <not set>",
        apiKeyConfigured: !!apiKey,
        apiKeyPrefix: apiKey ? apiKey.slice(0, 4) : null,
        apiKeyLength: apiKey ? apiKey.length : 0,
        apiKeyFormatValid: keyValid,
        registeredModels: {
          text: GROQ_MODEL_REGISTRY.filter((m) => m.type === "text").length,
          stt: GROQ_MODEL_REGISTRY.filter((m) => m.type === "stt").length,
          tts: GROQ_MODEL_REGISTRY.filter((m) => m.type === "tts").length,
        },
        troubleshooting: !apiKey
          ? "No API key configured. Set agent.api_key in config."
          : !keyValid
            ? "API key format invalid. Groq keys should start with 'gsk_' and be at least 20 characters."
            : null,
      },
    } as APIResponse);
  });

  // GET /api/groq/health — comprehensive health check with live API validation
  app.get("/health", async (c) => {
    const apiKey = getGroqApiKey(deps);
    const checks: Record<string, { status: "ok" | "warn" | "error"; message: string }> = {};

    // Check 1: API key configuration
    if (!apiKey) {
      checks.apiKey = { status: "error", message: "No API key configured" };
    } else if (!apiKey.startsWith("gsk_")) {
      checks.apiKey = { status: "error", message: "API key must start with 'gsk_'" };
    } else if (apiKey.length < 20) {
      checks.apiKey = { status: "error", message: "API key appears too short" };
    } else {
      checks.apiKey = { status: "ok", message: "API key format valid" };
    }

    // Check 2: Live API connectivity (only if key is configured)
    if (apiKey && checks.apiKey.status === "ok") {
      const result = await testGroqApiKey(apiKey);
      if (result.valid) {
        checks.connectivity = { status: "ok", message: "Successfully connected to Groq API" };
      } else {
        checks.connectivity = {
          status: "error",
          message: result.hint || result.error || "Connection failed",
        };
      }
    } else {
      checks.connectivity = { status: "warn", message: "Skipped - fix API key first" };
    }

    // Check 3: Model registry
    const textModels = GROQ_MODEL_REGISTRY.filter((m) => m.type === "text").length;
    const sttModels = GROQ_MODEL_REGISTRY.filter((m) => m.type === "stt").length;
    const ttsModels = GROQ_MODEL_REGISTRY.filter((m) => m.type === "tts").length;
    if (textModels > 0 && sttModels > 0 && ttsModels > 0) {
      checks.modelRegistry = {
        status: "ok",
        message: `${textModels} text, ${sttModels} STT, ${ttsModels} TTS models registered`,
      };
    } else {
      checks.modelRegistry = { status: "warn", message: "Model registry incomplete" };
    }

    const overallStatus = Object.values(checks).some((c) => c.status === "error")
      ? "error"
      : Object.values(checks).some((c) => c.status === "warn")
        ? "warn"
        : "ok";

    return c.json({
      success: overallStatus !== "error",
      data: {
        status: overallStatus,
        checks,
        baseURL: GROQ_API_BASE,
        timestamp: new Date().toISOString(),
      },
    } as APIResponse);
  });

  // POST /api/groq/transcribe — STT: transcribe audio buffer
  // Expects multipart/form-data with "file" field
  app.post("/transcribe", async (c) => {
    const apiKey = getGroqApiKey(deps);
    if (!apiKey) {
      return c.json({ success: false, error: "No Groq API key configured" } as APIResponse, 400);
    }

    let formData: FormData;
    try {
      formData = await c.req.formData();
    } catch {
      return c.json(
        { success: false, error: "Expected multipart/form-data with audio file" } as APIResponse,
        400
      );
    }

    const fileEntry = formData.get("file");
    if (!fileEntry || !(fileEntry instanceof File)) {
      return c.json(
        { success: false, error: "Missing 'file' field in form data" } as APIResponse,
        400
      );
    }

    const model = (formData.get("model") as string) || "whisper-large-v3-turbo";
    const language = (formData.get("language") as string) || undefined;

    try {
      const arrayBuffer = await fileEntry.arrayBuffer();
      const audioBuffer = Buffer.from(arrayBuffer);

      const result = await groqTranscribe(audioBuffer, fileEntry.name, {
        apiKey,
        model,
        language,
      });

      return c.json({ success: true, data: result } as APIResponse);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`STT transcription failed: ${msg}`);
      return c.json({ success: false, error: msg } as APIResponse, 502);
    }
  });

  // POST /api/groq/tts — TTS: synthesize text to audio
  app.post("/tts", async (c) => {
    const apiKey = getGroqApiKey(deps);
    if (!apiKey) {
      return c.json({ success: false, error: "No Groq API key configured" } as APIResponse, 400);
    }

    let body: {
      text?: string;
      model?: string;
      voice?: string;
      responseFormat?: string;
      speed?: number;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, error: "Invalid JSON body" } as APIResponse, 400);
    }

    if (!body.text || typeof body.text !== "string" || body.text.trim().length === 0) {
      return c.json({ success: false, error: "Missing or empty 'text' field" } as APIResponse, 400);
    }

    try {
      const audioBuffer = await groqSpeak(body.text, {
        apiKey,
        model: body.model || "canopylabs/orpheus-v1-english",
        voice: body.voice || "tara",
        responseFormat: (body.responseFormat as "mp3") || "mp3",
        speed: body.speed,
      });

      const format = body.responseFormat || "mp3";
      const mimeTypes: Record<string, string> = {
        mp3: "audio/mpeg",
        opus: "audio/ogg; codecs=opus",
        aac: "audio/aac",
        flac: "audio/flac",
        wav: "audio/wav",
        pcm: "audio/pcm",
      };

      // Convert Buffer to a proper Uint8Array<ArrayBuffer> for Hono compatibility
      const arrayBuf = audioBuffer.buffer.slice(
        audioBuffer.byteOffset,
        audioBuffer.byteOffset + audioBuffer.byteLength
      ) as ArrayBuffer;
      return c.body(new Uint8Array(arrayBuf), 200, {
        "Content-Type": mimeTypes[format] || "audio/mpeg",
        "Content-Length": String(audioBuffer.length),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`TTS synthesis failed: ${msg}`);
      return c.json({ success: false, error: msg } as APIResponse, 502);
    }
  });

  return app;
}
