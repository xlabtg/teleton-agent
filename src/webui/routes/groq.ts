import { Hono } from "hono";
import type { WebUIServerDeps, APIResponse } from "../types.js";
import {
  GROQ_MODEL_REGISTRY,
  getGroqModelsByType,
  type GroqModelType,
} from "../../providers/groq/modelRegistry.js";
import { testGroqApiKey, groqListModels } from "../../providers/groq/GroqTextProvider.js";
import { groqTranscribe } from "../../providers/groq/GroqSTTProvider.js";
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

    const error = await testGroqApiKey(apiKey);
    if (error) {
      return c.json({ success: false, error } as APIResponse, 422);
    }

    return c.json({ success: true, data: { valid: true } } as APIResponse);
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
        model: body.model || "playai-tts",
        voice: body.voice || "Fritz-PlayAI",
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
