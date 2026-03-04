import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { complete, type Context } from "@mariozechner/pi-ai";
import { summarizeViaClaude, formatMessagesForSummary } from "../memory/ai-summarization.js";
import { getUtilityModel } from "../agent/client.js";
import type { SupportedProvider } from "../config/providers.js";
import { createLogger } from "../utils/logger.js";
import {
  SESSION_SLUG_RECENT_MESSAGES,
  SESSION_SLUG_MAX_TOKENS,
  DEFAULT_MAX_SUMMARY_TOKENS,
} from "../constants/limits.js";

const log = createLogger("Session");

/**
 * Generate a semantic slug for a session using LLM.
 * Creates a short, descriptive identifier based on conversation content.
 */
async function generateSlugViaClaude(params: {
  messages: Context["messages"];
  apiKey: string;
  provider?: SupportedProvider;
  utilityModel?: string;
}): Promise<string> {
  const provider = params.provider || "anthropic";
  const model = getUtilityModel(provider, params.utilityModel);

  const formatted = formatMessagesForSummary(params.messages.slice(-SESSION_SLUG_RECENT_MESSAGES));

  if (!formatted.trim()) {
    return "empty-session";
  }

  try {
    const context: Context = {
      messages: [
        {
          role: "user",
          content: `Generate a short, descriptive slug (2-4 words, kebab-case) for this conversation.
Examples: "gift-transfer-fix", "context-overflow-debug", "telegram-integration"

Conversation:
${formatted}

Slug:`,
          timestamp: Date.now(),
        },
      ],
    };

    const response = await complete(model, context, {
      apiKey: params.apiKey,
      maxTokens: SESSION_SLUG_MAX_TOKENS,
    });

    const textContent = response.content.find((block) => block.type === "text");
    const slug = textContent?.type === "text" ? textContent.text.trim() : "";

    return (
      slug
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, "")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .slice(0, 50) || "session"
    );
  } catch (error) {
    log.warn({ err: error }, "Slug generation failed, using fallback");
    const now = new Date();
    return `session-${now.getHours().toString().padStart(2, "0")}${now.getMinutes().toString().padStart(2, "0")}`;
  }
}

/**
 * Save session memory to dated markdown file.
 * Creates audit trail of session transitions for human review.
 */
export async function saveSessionMemory(params: {
  oldSessionId: string;
  newSessionId: string;
  context: Context;
  chatId: string;
  apiKey: string;
  provider?: SupportedProvider;
  utilityModel?: string;
}): Promise<void> {
  try {
    const { TELETON_ROOT } = await import("../workspace/paths.js");
    const memoryDir = join(TELETON_ROOT, "memory");
    await mkdir(memoryDir, { recursive: true });

    const now = new Date();
    const dateStr = now.toISOString().split("T")[0];

    log.info("Generating semantic slug for session memory...");
    const slug = await generateSlugViaClaude({
      messages: params.context.messages,
      apiKey: params.apiKey,
      provider: params.provider,
      utilityModel: params.utilityModel,
    });

    const filename = `${dateStr}-${slug}.md`;
    const filepath = join(memoryDir, filename);

    const timeStr = now.toISOString().split("T")[1].split(".")[0];

    log.info("Generating session summary...");
    let summary: string;
    try {
      summary = await summarizeViaClaude({
        messages: params.context.messages,
        apiKey: params.apiKey,
        maxSummaryTokens: DEFAULT_MAX_SUMMARY_TOKENS,
        customInstructions:
          "Summarize this session comprehensively. Include key topics, decisions made, problems solved, and important context.",
        provider: params.provider,
        utilityModel: params.utilityModel,
      });
    } catch (error) {
      log.warn({ err: error }, "Session summary generation failed");
      summary = `Session contained ${params.context.messages.length} messages. Summary generation failed.`;
    }

    const content = `# Session Memory: ${dateStr} ${timeStr} UTC

## Metadata

- **Old Session ID**: \`${params.oldSessionId}\`
- **New Session ID**: \`${params.newSessionId}\`
- **Chat ID**: \`${params.chatId}\`
- **Timestamp**: ${now.toISOString()}
- **Message Count**: ${params.context.messages.length}

## Session Summary

${summary}

## Context

This session was compacted and migrated to a new session ID. The summary above preserves key information for continuity.

---

*Generated automatically by Teleton-AI session memory hook*
`;

    await writeFile(filepath, content, "utf-8");

    const relPath = filepath.replace(TELETON_ROOT, "~/.teleton");
    log.info(`Session memory saved: ${relPath}`);
  } catch (error) {
    log.error({ err: error }, "Failed to save session memory");
  }
}
