/**
 * Groq Speech-to-Text Provider
 *
 * Sends audio to Groq's /audio/transcriptions endpoint (Whisper models).
 * Supports all Groq STT models: whisper-large-v3, whisper-large-v3-turbo,
 * distil-whisper-large-v3-en.
 */

import { createLogger } from "../../utils/logger.js";
import { withGroqRateLimit, parseGroqErrorType } from "./rateLimiter.js";

const log = createLogger("GroqSTT");

export const GROQ_API_BASE = "https://api.groq.com/openai/v1";

export interface GroqTranscribeOptions {
  /** API key for Groq */
  apiKey: string;
  /** Whisper model ID (e.g. "whisper-large-v3") */
  model?: string;
  /** Language hint (e.g. "en") — optional, Groq auto-detects if omitted */
  language?: string;
  /** Response format: "json" | "text" | "verbose_json" */
  responseFormat?: "json" | "text" | "verbose_json";
  /** Temperature (0–1) */
  temperature?: number;
}

export interface GroqTranscribeResult {
  text: string;
  language?: string;
  duration?: number;
  segments?: Array<{
    id: number;
    start: number;
    end: number;
    text: string;
  }>;
}

/**
 * Transcribe audio using Groq's Whisper endpoint.
 *
 * @param audioBuffer - Raw audio bytes (mp3, wav, m4a, ogg, webm, flac, etc.)
 * @param filename - Original filename (used to hint mime type to the API)
 * @param options - Groq API options
 */
export async function groqTranscribe(
  audioBuffer: Buffer,
  filename: string,
  options: GroqTranscribeOptions
): Promise<GroqTranscribeResult> {
  const {
    apiKey,
    model = "whisper-large-v3-turbo",
    language,
    responseFormat = "json",
    temperature,
  } = options;

  if (!apiKey) {
    throw new Error("Groq API key is required for STT");
  }

  return withGroqRateLimit(async () => {
    const formData = new FormData();
    // Slice the underlying buffer to get a plain ArrayBuffer for Blob compatibility
    const arrayBuf = audioBuffer.buffer.slice(
      audioBuffer.byteOffset,
      audioBuffer.byteOffset + audioBuffer.byteLength
    ) as ArrayBuffer;
    const blob = new Blob([arrayBuf]);
    formData.append("file", blob, filename);
    formData.append("model", model);
    formData.append("response_format", responseFormat);

    if (language) formData.append("language", language);
    if (temperature != null) formData.append("temperature", String(temperature));

    const response = await fetch(`${GROQ_API_BASE}/audio/transcriptions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const errorType = parseGroqErrorType(response.status);
      const errorBody = await response.text().catch(() => "");
      const msg = `Groq STT error (${response.status} ${errorType}): ${errorBody}`;
      log.error(msg);
      throw new Error(msg);
    }

    if (responseFormat === "text") {
      const text = await response.text();
      return { text: text.trim() };
    }

    const result = (await response.json()) as {
      text: string;
      language?: string;
      duration?: number;
      segments?: Array<{ id: number; start: number; end: number; text: string }>;
    };

    log.debug(`STT transcribed ${result.text.length} chars using ${model}`);
    return {
      text: result.text,
      language: result.language,
      duration: result.duration,
      segments: result.segments,
    };
  });
}
