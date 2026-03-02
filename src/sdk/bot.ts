/**
 * Bot SDK — per-plugin frozen SDK for inline mode.
 * Follows the same pattern as src/sdk/telegram.ts.
 */

import type { BotSDK, BotManifest, BotKeyboard, ButtonDef, PluginLogger } from "@teleton-agent/sdk";
import type { InlineRouter, PluginBotHandlers } from "../bot/inline-router.js";
import type { GramJSBotClient } from "../bot/gramjs-bot.js";
import type { Bot } from "grammy";
import type { PluginRateLimiter } from "../bot/rate-limiter.js";
import { toTLMarkup, toGrammyKeyboard, prefixButtons } from "../bot/services/styled-keyboard.js";
import { stripCustomEmoji, parseHtml } from "../bot/services/html-parser.js";
import { compileGlob } from "../bot/inline-router.js";

export function createBotSDK(
  router: InlineRouter | null,
  gramjsBot: GramJSBotClient | null,
  grammyBot: Bot | null,
  pluginName: string,
  manifest: BotManifest | undefined,
  rateLimiter: PluginRateLimiter | null,
  log: PluginLogger
): BotSDK | null {
  // No router or no manifest with bot features → null
  if (!router || !manifest || (!manifest.inline && !manifest.callbacks)) {
    return null;
  }

  const inlineLimit = manifest.rateLimits?.inlinePerMinute ?? 30;
  const callbackLimit = manifest.rateLimits?.callbackPerMinute ?? 60;

  // Track accumulated handlers so incremental registration works
  const handlers: PluginBotHandlers = {};

  function syncToRouter(): void {
    router!.registerPlugin(pluginName, { ...handlers });
  }

  const sdk: BotSDK = {
    get isAvailable() {
      return !!router;
    },

    get username() {
      try {
        return grammyBot?.botInfo?.username ?? "";
      } catch {
        return "";
      }
    },

    onInlineQuery(handler) {
      if (handlers.onInlineQuery) {
        log.warn("onInlineQuery called again — overwriting previous handler");
      }
      handlers.onInlineQuery = async (ctx) => {
        if (rateLimiter) {
          rateLimiter.check(pluginName, "inline", inlineLimit);
        }
        return handler(ctx);
      };
      syncToRouter();
    },

    onCallback(pattern, handler) {
      if (!handlers.onCallback) {
        handlers.onCallback = [];
      }
      handlers.onCallback.push({
        pattern,
        regex: compileGlob(pattern),
        handler: async (ctx) => {
          if (rateLimiter) {
            rateLimiter.check(pluginName, "callback", callbackLimit);
          }
          return handler(ctx);
        },
      });
      syncToRouter();
    },

    onChosenResult(handler) {
      handlers.onChosenResult = handler;
      syncToRouter();
    },

    async editInlineMessage(inlineMessageId, text, opts) {
      const keyboard = opts?.keyboard ? prefixButtons(opts.keyboard, pluginName) : undefined;

      // Try GramJS first (styled buttons)
      if (gramjsBot?.isConnected() && keyboard) {
        try {
          const strippedHtml = stripCustomEmoji(text);
          const { text: plainText, entities } = parseHtml(strippedHtml);
          const markup = toTLMarkup(keyboard);

          await gramjsBot.editInlineMessageByStringId({
            inlineMessageId,
            text: plainText,
            entities: entities.length > 0 ? entities : undefined,
            replyMarkup: markup,
          });
          return;
        } catch (error: any) {
          if (error?.errorMessage === "MESSAGE_NOT_MODIFIED") return;
          log.warn(`GramJS edit failed, falling back to Grammy: ${error?.errorMessage || error}`);
        }
      }

      // Grammy fallback
      if (grammyBot) {
        try {
          const kb = keyboard ? toGrammyKeyboard(keyboard) : undefined;
          await grammyBot.api.editMessageTextInline(inlineMessageId, stripCustomEmoji(text), {
            parse_mode: (opts?.parseMode as "HTML" | "MarkdownV2") ?? "HTML",
            link_preview_options: { is_disabled: true },
            reply_markup: kb,
          });
        } catch (error: any) {
          if (error?.description?.includes("message is not modified")) return;
          log.error(`Failed to edit inline message: ${error?.description || error}`);
        }
      }
    },

    keyboard(rows: ButtonDef[][]): BotKeyboard {
      const prefixed = prefixButtons(rows, pluginName);
      return {
        rows: rows.map((row) =>
          row.map((btn) => ({
            ...btn,
            callback: btn.callback ? `${pluginName}:${btn.callback}` : undefined,
          }))
        ),
        toGrammy() {
          return toGrammyKeyboard(prefixed);
        },
        toTL() {
          return toTLMarkup(prefixed);
        },
      };
    },
  };

  return Object.freeze(sdk);
}
