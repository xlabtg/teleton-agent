/**
 * Shared model catalog used by WebUI setup, CLI onboard, and config routes.
 * To add a model, add it here — it will appear in all UIs automatically.
 * Models must exist in pi-ai's registry (or be entered as custom).
 */

export interface ModelOption {
  value: string;
  name: string;
  description: string;
}

/** Extended model option with modal type classification (for multi-modal providers) */
export interface GroqModelOption extends ModelOption {
  type: "text" | "stt" | "tts";
}

/** Groq text models for LLM chat completions */
export const GROQ_TEXT_MODELS: ModelOption[] = [
  // Production models
  {
    value: "meta-llama/llama-4-maverick-17b-128e-instruct",
    name: "Llama 4 Maverick",
    description: "Vision, 131K ctx, $0.20/M",
  },
  {
    value: "llama-3.3-70b-versatile",
    name: "Llama 3.3 70B",
    description: "General purpose, 131K ctx, $0.59/M",
  },
  {
    value: "llama-3.1-8b-instant",
    name: "Llama 3.1 8B",
    description: "Fast & cheap, 131K ctx, $0.05/M",
  },
  {
    value: "openai/gpt-oss-120b",
    name: "GPT OSS 120B",
    description: "Fast reasoning, 131K ctx, $0.90/M",
  },
  {
    value: "openai/gpt-oss-20b",
    name: "GPT OSS 20B",
    description: "Ultra-fast, 131K ctx, $0.10/M",
  },
  // Preview models (available but not for production)
  {
    value: "qwen/qwen3-32b",
    name: "Qwen3 32B (Preview)",
    description: "Reasoning, 131K ctx, $0.29/M",
  },
  {
    value: "meta-llama/llama-4-scout-17b-16e-instruct",
    name: "Llama 4 Scout 17B (Preview)",
    description: "Fast, 131K ctx",
  },
  {
    value: "moonshotai/kimi-k2-instruct",
    name: "Kimi K2 (Preview)",
    description: "Long context, 262K ctx",
  },
];

/** Groq STT (Speech-to-Text) models — Whisper variants */
export const GROQ_STT_MODELS: ModelOption[] = [
  {
    value: "whisper-large-v3",
    name: "Whisper Large v3",
    description: "Best accuracy, multilingual, $0.111/hr",
  },
  {
    value: "whisper-large-v3-turbo",
    name: "Whisper Large v3 Turbo",
    description: "Fast + accurate, multilingual, $0.04/hr",
  },
  {
    value: "distil-whisper-large-v3-en",
    name: "Distil Whisper v3 (EN)",
    description: "English-only, fastest, $0.02/hr",
  },
];

/** Groq TTS (Text-to-Speech) models — Orpheus variants */
export const GROQ_TTS_MODELS: ModelOption[] = [
  {
    value: "canopylabs/orpheus-v1-english",
    name: "Orpheus TTS English",
    description: "English TTS, Orpheus v1, multiple voices",
  },
  {
    value: "canopylabs/orpheus-arabic-saudi",
    name: "Orpheus TTS Arabic (Saudi)",
    description: "Arabic (Saudi) TTS, Orpheus model",
  },
];

export const MODEL_OPTIONS: Record<string, ModelOption[]> = {
  anthropic: [
    {
      value: "claude-opus-4-8",
      name: "Claude Opus 4.8",
      description: "Current default, 1M ctx, $5/$25",
    },
    {
      value: "claude-opus-4-7",
      name: "Claude Opus 4.7",
      description: "Previous gen, 1M ctx, reasoning, $5/$25",
    },
    {
      value: "claude-opus-4-6",
      name: "Claude Opus 4.6",
      description: "Legacy, may be retired, 1M ctx, $5/$25",
    },
    {
      value: "claude-opus-4-5-20251101",
      name: "Claude Opus 4.5",
      description: "Older gen, 200K ctx, $5/$25",
    },
    {
      value: "claude-sonnet-4-6",
      name: "Claude Sonnet 4.6",
      description: "Balanced, 1M ctx, reasoning, $3/$15",
    },
    {
      value: "claude-haiku-4-5-20251001",
      name: "Claude Haiku 4.5",
      description: "Fast & cheap, 200K ctx, $1/$5",
    },
  ],
  openai: [
    {
      value: "gpt-5.5",
      name: "GPT-5.5",
      description: "Latest frontier, reasoning, 272K ctx, $5/$30",
    },
    {
      value: "gpt-5.5-pro",
      name: "GPT-5.5 Pro",
      description: "Max capability, reasoning, 1M ctx, $30/$180",
    },
    { value: "gpt-5.4", name: "GPT-5.4", description: "Reasoning, 272K ctx, $2.50/$15" },
    {
      value: "gpt-5.4-pro",
      name: "GPT-5.4 Pro",
      description: "Extended thinking, 1M ctx, $30/$180",
    },
    {
      value: "gpt-5.4-mini",
      name: "GPT-5.4 Mini",
      description: "Fast & cheap, reasoning, 400K ctx, $0.75/$4.50",
    },
    { value: "gpt-4o", name: "GPT-4o", description: "Balanced, 128K ctx, $2.50/$10" },
    { value: "gpt-4.1", name: "GPT-4.1", description: "1M ctx, $2/$8" },
    { value: "gpt-4.1-mini", name: "GPT-4.1 Mini", description: "1M ctx, cheap, $0.40/$1.60" },
  ],
  "openai-codex": [
    { value: "gpt-5.5", name: "GPT-5.5", description: "Latest frontier, reasoning, 272K ctx" },
    { value: "gpt-5.4", name: "GPT-5.4", description: "Reasoning, 272K ctx" },
    { value: "gpt-5.4-mini", name: "GPT-5.4 Mini", description: "Fast & cheap, reasoning" },
    { value: "gpt-5.3-codex", name: "GPT-5.3 Codex", description: "Coding specialist, 272K ctx" },
    {
      value: "gpt-5.3-codex-spark",
      name: "GPT-5.3 Codex Spark",
      description: "Coding, preview, free",
    },
  ],
  google: [
    {
      value: "gemini-3.1-pro-preview",
      name: "Gemini 3.1 Pro",
      description: "Preview, latest gen, reasoning, 1M ctx, $2/$12",
    },
    {
      value: "gemini-3.1-flash-lite-preview",
      name: "Gemini 3.1 Flash Lite",
      description: "Preview, fast & cheap, reasoning, 1M ctx, $0.25/$1.50",
    },
    { value: "gemini-2.5-pro", name: "Gemini 2.5 Pro", description: "Stable, 1M ctx, $1.25/$10" },
    {
      value: "gemini-2.5-flash",
      name: "Gemini 2.5 Flash",
      description: "Fast, 1M ctx, $0.30/$2.50",
    },
    {
      value: "gemini-2.5-flash-lite",
      name: "Gemini 2.5 Flash Lite",
      description: "Ultra cheap, 1M ctx, $0.10/$0.40",
    },
  ],
  xai: [
    {
      value: "grok-4.3",
      name: "Grok 4.3",
      description: "Latest, reasoning, vision, 1M ctx, $1.25/$2.50",
    },
    {
      value: "grok-4.20-0309-reasoning",
      name: "Grok 4.20 Reasoning",
      description: "Reasoning, vision, 2M ctx, $2/$6",
    },
    {
      value: "grok-4.20-0309-non-reasoning",
      name: "Grok 4.20 Non-Reasoning",
      description: "Fast, vision, 2M ctx, $2/$6",
    },
    {
      value: "grok-4-1-fast-non-reasoning",
      name: "Grok 4.1 Fast",
      description: "Fast, vision, 2M ctx, $0.20/$0.50",
    },
  ],
  groq: GROQ_TEXT_MODELS,
  openrouter: [
    {
      value: "anthropic/claude-opus-4.7",
      name: "Claude Opus 4.7",
      description: "Latest, 1M ctx, reasoning, $5/M",
    },
    {
      value: "anthropic/claude-sonnet-4.6",
      name: "Claude Sonnet 4.6",
      description: "Balanced, 1M ctx, $3/M",
    },
    { value: "openai/gpt-5.5", name: "GPT-5.5", description: "Frontier, reasoning, 1M ctx, $5/M" },
    {
      value: "google/gemini-3.1-pro-preview",
      name: "Gemini 3.1 Pro",
      description: "Preview, reasoning, 1M ctx, $2/M",
    },
    {
      value: "deepseek/deepseek-v4-pro",
      name: "DeepSeek V4 Pro",
      description: "Latest, reasoning, 1M ctx, $0.44/M",
    },
    {
      value: "qwen/qwen3.6-35b-a3b",
      name: "Qwen3.6 35B A3B",
      description: "Reasoning, 262K ctx, $0.15/M",
    },
    { value: "z-ai/glm-5.1", name: "GLM-5.1", description: "Reasoning, 202K ctx, $1.05/M" },
    {
      value: "x-ai/grok-4.3",
      name: "Grok 4.3",
      description: "Reasoning, vision, 1M ctx, $1.25/M",
    },
    {
      value: "minimax/minimax-m2.7",
      name: "MiniMax M2.7",
      description: "Reasoning, 196K ctx, $0.30/M",
    },
    {
      value: "moonshotai/kimi-k2.6",
      name: "Kimi K2.6",
      description: "Reasoning, vision, 262K ctx, $0.75/M",
    },
    {
      value: "nvidia/nemotron-nano-9b-v2",
      name: "Nemotron Nano 9B",
      description: "Small & fast, 131K ctx, $0.04/M",
    },
    {
      value: "perplexity/sonar-pro",
      name: "Perplexity Sonar Pro",
      description: "Web search integrated",
    },
    { value: "minimax/minimax-m2.5", name: "MiniMax M2.5", description: "Latest MiniMax" },
    { value: "x-ai/grok-4", name: "Grok 4", description: "256K ctx, $3/M" },
    // Free models (no cost, rate-limited ~20 RPM)
    {
      value: "openrouter/free",
      name: "Free Models Router",
      description: "Auto-selects available free model, 200K ctx, FREE",
    },
    {
      value: "openrouter/owl-alpha",
      name: "Owl Alpha (free)",
      description: "262K ctx, FREE",
    },
    {
      value: "inclusionai/ring-2.6-1t:free",
      name: "inclusionAI: Ring-2.6-1T (free)",
      description: "Context 1.05M Max Output 262K, FREE",
    },
    {
      value: "qwen/qwen3.6-plus:free",
      name: "Qwen3.6 Plus (free)",
      description: "1M ctx, MoE, SWE-bench 78.8, FREE",
    },
    {
      value: "stepfun/step-3.5-flash:free",
      name: "Step 3.5 Flash (free)",
      description: "256K ctx, MoE 196B/11B, high-speed, FREE",
    },
    {
      value: "nvidia/nemotron-3-super-120b-a12b:free",
      name: "Nemotron 3 Super 120B (free)",
      description: "262K ctx, Mamba-Transformer hybrid, FREE",
    },
    {
      value: "arcee-ai/trinity-large-preview:free",
      name: "Trinity Large Preview (free)",
      description: "131K ctx, 400B/13B MoE, FREE",
    },
    {
      value: "z-ai/glm-4.5-air:free",
      name: "GLM 4.5 Air (free)",
      description: "131K ctx, lightweight MoE, FREE",
    },
    {
      value: "nvidia/nemotron-nano-30b-a3b:free",
      name: "Nemotron Nano 30B A3B (free)",
      description: "256K ctx, compact MoE for agents, FREE",
    },
    {
      value: "nvidia/nemotron-nano-12b-2-vl:free",
      name: "Nemotron Nano 12B VL (free)",
      description: "128K ctx, multimodal text+images, FREE",
    },
    {
      value: "minimax/minimax-m2.5:free",
      name: "MiniMax M2.5 (free)",
      description: "197K ctx, SWE-Bench 80.2%, FREE",
    },
    {
      value: "nvidia/nemotron-nano-9b-v2:free",
      name: "Nemotron Nano 9B V2 (free)",
      description: "128K ctx, reasoning + non-reasoning, FREE",
    },
    {
      value: "openai/gpt-oss-120b:free",
      name: "GPT OSS 120B (free)",
      description: "131K ctx, MoE 117B/5.1B, Apache 2.0, FREE",
    },
    {
      value: "qwen/qwen3-coder-480b-a35b:free",
      name: "Qwen3 Coder 480B A35B (free)",
      description: "262K ctx, coding specialist 480B/35B MoE, FREE",
    },
    {
      value: "openai/gpt-oss-20b:free",
      name: "GPT OSS 20B (free)",
      description: "131K ctx, MoE 21B/3.6B, low-latency, FREE",
    },
    {
      value: "qwen/qwen3-next-80b-a3b-instruct:free",
      name: "Qwen3 Next 80B A3B (free)",
      description: "262K ctx, stable without thinking mode, FREE",
    },
    {
      value: "meta-llama/llama-3.3-70b-instruct:free",
      name: "Llama 3.3 70B Instruct (free)",
      description: "66K ctx, multilingual 8 languages, FREE",
    },
    {
      value: "liquidai/lfm2.5-1.2b-thinking:free",
      name: "LFM2.5 1.2B Thinking (free)",
      description: "33K ctx, edge-optimized reasoning, FREE",
    },
    {
      value: "liquidai/lfm2.5-1.2b-instruct:free",
      name: "LFM2.5 1.2B Instruct (free)",
      description: "33K ctx, compact chat for edge, FREE",
    },
    {
      value: "venice/uncensored:free",
      name: "Venice Uncensored (free)",
      description: "33K ctx, uncensored, FREE",
    },
    {
      value: "nousresearch/hermes-3-405b-instruct:free",
      name: "Hermes 3 405B Instruct (free)",
      description: "131K ctx, frontier-level Llama-3.1 405B fine-tune, FREE",
    },
    {
      value: "meta-llama/llama-3.2-3b-instruct:free",
      name: "Llama 3.2 3B Instruct (free)",
      description: "131K ctx, lightweight multilingual, FREE",
    },
    {
      value: "google/gemma-3-27b:free",
      name: "Gemma 3 27B (free)",
      description: "131K ctx, multimodal 140+ languages, FREE",
    },
    {
      value: "google/gemma-3-4b:free",
      name: "Gemma 3 4B (free)",
      description: "33K ctx, compact multimodal, FREE",
    },
    {
      value: "google/gemma-3n-4b:free",
      name: "Gemma 3n 4B (free)",
      description: "8K ctx, optimized for mobile, FREE",
    },
    {
      value: "google/gemma-3n-2b:free",
      name: "Gemma 3n 2B (free)",
      description: "8K ctx, ultra-lightweight edge model, FREE",
    },
    {
      value: "google/gemma-3-12b:free",
      name: "Gemma 3 12B (free)",
      description: "33K ctx, balanced quality/speed, FREE",
    },
  ],
  moonshot: [
    {
      value: "kimi-for-coding",
      name: "Kimi for Coding",
      description: "Coding plan, reasoning, 262K ctx",
    },
    {
      value: "kimi-k2-thinking",
      name: "Kimi K2 Thinking",
      description: "Reasoning, 262K ctx",
    },
  ],
  mistral: [
    { value: "devstral-2512", name: "Devstral 2", description: "Coding, 262K ctx, $0.40/M" },
    {
      value: "mistral-small-latest",
      name: "Mistral Small",
      description: "Reasoning, 256K ctx, $0.15/M",
    },
    {
      value: "mistral-medium-latest",
      name: "Mistral Medium",
      description: "Reasoning, 262K ctx, $1.50/M",
    },
    {
      value: "mistral-large-latest",
      name: "Mistral Large",
      description: "General, 262K ctx, $0.50/M",
    },
  ],
  cerebras: [
    {
      value: "qwen-3-235b-a22b-instruct-2507",
      name: "Qwen 3 235B",
      description: "131K ctx, $0.60/$1.20",
    },
    { value: "gpt-oss-120b", name: "GPT OSS 120B", description: "Reasoning, 131K ctx, $0.25/M" },
    { value: "zai-glm-4.7", name: "ZAI GLM-4.7", description: "131K ctx, $2.25/M" },
    { value: "llama3.1-8b", name: "Llama 3.1 8B", description: "Fast & cheap, 32K ctx, $0.10/M" },
  ],
  zai: [
    { value: "glm-5.1", name: "GLM-5.1", description: "Latest, reasoning, 200K ctx" },
    { value: "glm-5-turbo", name: "GLM-5 Turbo", description: "Fast reasoning, 200K ctx" },
    { value: "glm-4.7", name: "GLM-4.7", description: "204K ctx, $0.60/$2.20" },
    { value: "glm-5", name: "GLM-5", description: "Best quality, 204K ctx, $1.00/$3.20" },
    { value: "glm-4.6", name: "GLM-4.6", description: "204K ctx, $0.60/$2.20" },
    { value: "glm-4.7-flash", name: "GLM-4.7 Flash", description: "FREE, 200K ctx" },
    { value: "glm-4.5-flash", name: "GLM-4.5 Flash", description: "FREE, 131K ctx" },
    { value: "glm-4.5v", name: "GLM-4.5V", description: "Vision, 64K ctx, $0.60/$1.80" },
  ],
  minimax: [
    { value: "MiniMax-M2.7", name: "MiniMax M2.7", description: "204K ctx, $0.30/$1.20" },
    {
      value: "MiniMax-M2.7-highspeed",
      name: "MiniMax M2.7 Fast",
      description: "204K ctx, $0.60/$2.40",
    },
  ],
  huggingface: [
    {
      value: "deepseek-ai/DeepSeek-V4-Pro",
      name: "DeepSeek V4 Pro",
      description: "Latest, reasoning, 1M ctx, $1.74/M",
    },
    {
      value: "Qwen/Qwen3.5-397B-A17B",
      name: "Qwen3.5 397B",
      description: "Reasoning, 262K ctx, $0.60/M",
    },
    {
      value: "Qwen/Qwen3-Coder-Next",
      name: "Qwen3 Coder Next",
      description: "Coding, 262K ctx, $0.20/M",
    },
    {
      value: "moonshotai/Kimi-K2.6",
      name: "Kimi K2.6",
      description: "Reasoning, vision, 262K ctx, $0.95/M",
    },
    { value: "zai-org/GLM-5.1", name: "GLM-5.1", description: "Reasoning, 202K ctx, $1/M" },
    {
      value: "MiniMaxAI/MiniMax-M2.7",
      name: "MiniMax M2.7",
      description: "Reasoning, 204K ctx, $0.30/M",
    },
  ],
  nvidia: [
    {
      value: "z-ai/glm-5.1",
      name: "GLM-5.1",
      description: "NVIDIA hosted agentic chat model with native tool calling",
    },
    {
      value: "minimaxai/minimax-m2.7",
      name: "MiniMax M2.7",
      description: "Current NVIDIA preview coding model",
    },
    {
      value: "openai/gpt-oss-20b",
      name: "GPT OSS 20B Overview",
      description:
        "OpenAI releases the gpt-oss family of open-weight models designed for powerful reasoning, agentic tasks, and versatile developer use cases",
    },
    {
      value: "openai/gpt-oss-120b",
      name: "GPT OSS 120B Overview",
      description:
        "OpenAI releases the gpt-oss family of open-weight models designed for powerful reasoning, agentic tasks, and versatile developer use cases",
    },
    {
      value: "meta/llama-3.1-8b-instruct",
      name: "Llama 3.1 8B Instruct",
      description: "128K ctx, chat + tools + vision, FREE preview",
    },
    {
      value: "meta/llama-3.1-70b-instruct",
      name: "Llama 3.1 70B Instruct",
      description: "128K ctx, chat + tools, FREE preview",
    },
    {
      value: "meta/llama-3.2-90b-vision-instruct",
      name: "Llama 3.2 90B Vision Instruct",
      description: "128K ctx, large multimodal vision + chat, FREE preview",
    },
    {
      value: "meta/llama-3.3-70b-instruct",
      name: "Llama 3.3 70B Instruct",
      description: "128K ctx, updated general-purpose instruct, FREE preview",
    },
    {
      value: "qwen/qwen3-next-80b-a3b-instruct",
      name: "Qwen3 Next 80B",
      description: "Large MoE chat model, FREE preview",
    },
    {
      value: "qwen/qwen3-coder-480b-a35b-instruct",
      name: "Qwen3 Coder 480B",
      description: "Current NVIDIA preview coding model",
    },
    {
      value: "qwen/qwen3.5-122b-a10b",
      name: "Qwen3.5-122B-A10B",
      description: "Current NVIDIA preview coding model",
    },
    {
      value: "qwen/qwen3.5-397b-a17b",
      name: "Qwen3.5-397B-A17B",
      description: "Current NVIDIA preview coding model",
    },
    {
      value: "mistralai/mistral-small-4-119b-2603",
      name: "Mistral Small 4 119B A6B",
      description:
        "Mistral Small 4 is a powerful hybrid model capable of acting as both a general instruction model and a reasoning model. It unifies the capabilities of three different model families—Instruct, Reasoning (previously called Magistral), and Devstral—into a single, unified model",
    },
    {
      value: "deepseek-ai/deepseek-v3.1-terminus",
      name: "DeepSeek V3.1 Terminus",
      description: "Current NVIDIA preview reasoning/chat model",
    },
    {
      value: "deepseek-ai/deepseek-v4-flash",
      name: "DeepSeek V4 Flesh",
      description: "Current NVIDIA preview reasoning/chat model",
    },
    {
      value: "moonshotai/kimi-k2.6",
      name: "Kimi-K2.6",
      description: "Current NVIDIA preview instruct model",
    },
    {
      value: "stepfun-ai/step-3.7-flash",
      name: "Step 3.7 Flash",
      description: "Current NVIDIA preview fast chat model",
    },
    {
      value: "stepfun-ai/step-3.5-flash",
      name: "Step 3.5 Flash",
      description: "Current NVIDIA preview fast chat model",
    },
  ],
  gocoon: [
    {
      value: "Qwen/Qwen3-32B",
      name: "Qwen3-32B",
      description: "Decentralized inference on TON",
    },
  ],
};

/** Get models for a provider (codex → openai-codex) */
export function getModelsForProvider(provider: string): ModelOption[] {
  const key = provider === "codex" ? "openai-codex" : provider;
  return MODEL_OPTIONS[key] || [];
}

/** Get Groq STT models */
export function getGroqSttModels(): ModelOption[] {
  return GROQ_STT_MODELS;
}

/** Get Groq TTS models */
export function getGroqTtsModels(): ModelOption[] {
  return GROQ_TTS_MODELS;
}
