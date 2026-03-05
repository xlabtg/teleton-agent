/**
 * Groq Text-to-Speech Provider
 *
 * Sends text to Groq's /audio/speech endpoint (PlayAI TTS models).
 * Supports: playai-tts, playai-tts-arabic.
 */

import { createLogger } from "../../utils/logger.js";
import { withGroqRateLimit, parseGroqErrorType } from "./rateLimiter.js";
import { GROQ_API_BASE } from "./GroqSTTProvider.js";

const log = createLogger("GroqTTS");

/** Available voices for PlayAI TTS */
export const GROQ_TTS_VOICES = [
  "Arista-PlayAI",
  "Atlas-PlayAI",
  "Basil-PlayAI",
  "Brixton-PlayAI",
  "Calum-PlayAI",
  "Celeste-PlayAI",
  "Cheyenne-PlayAI",
  "Chip-PlayAI",
  "Cillian-PlayAI",
  "Deedee-PlayAI",
  "Eleanor-PlayAI",
  "Fritz-PlayAI",
  "Gail-PlayAI",
  "George-PlayAI",
  "Jasper-PlayAI",
  "Jennifer-PlayAI",
  "Judy-PlayAI",
  "Mamaw-PlayAI",
  "Mason-PlayAI",
  "Mikail-PlayAI",
  "Mitch-PlayAI",
  "Quinn-PlayAI",
  "Thunder-PlayAI",
] as const;

export type GroqTTSVoice = (typeof GROQ_TTS_VOICES)[number];

/** Supported output formats for Groq TTS */
export type GroqTTSFormat = "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm";

export interface GroqSpeechOptions {
  /** API key for Groq */
  apiKey: string;
  /** TTS model ID (e.g. "playai-tts") */
  model?: string;
  /** Voice to use */
  voice?: string;
  /** Output audio format */
  responseFormat?: GroqTTSFormat;
  /** Playback speed (0.25–4.0) */
  speed?: number;
}

/**
 * Synthesize speech using Groq's TTS endpoint.
 *
 * @param text - Text to synthesize
 * @param options - Groq API options
 * @returns Raw audio buffer
 */
export async function groqSpeak(text: string, options: GroqSpeechOptions): Promise<Buffer> {
  const {
    apiKey,
    model = "playai-tts",
    voice = "Fritz-PlayAI",
    responseFormat = "mp3",
    speed,
  } = options;

  if (!apiKey) {
    throw new Error("Groq API key is required for TTS");
  }

  return withGroqRateLimit(async () => {
    const body: Record<string, unknown> = {
      model,
      input: text,
      voice,
      response_format: responseFormat,
    };

    if (speed != null) body.speed = speed;

    const response = await fetch(`${GROQ_API_BASE}/audio/speech`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorType = parseGroqErrorType(response.status);
      const errorBody = await response.text().catch(() => "");
      const msg = `Groq TTS error (${response.status} ${errorType}): ${errorBody}`;
      log.error(msg);
      throw new Error(msg);
    }

    const arrayBuffer = await response.arrayBuffer();
    log.debug(`TTS synthesized ${text.length} chars using ${model}/${voice}`);
    return Buffer.from(arrayBuffer);
  });
}
