import type { TelegramBridge } from "../bridge.js";
import type Database from "better-sqlite3";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("Telegram");

export type CallbackHandler = (data: {
  action: string;
  params: string[];
  queryId: bigint;
  chatId: string;
  messageId: number;
  userId: number;
}) => Promise<void>;

export class CallbackQueryHandler {
  private handlers: Map<string, CallbackHandler> = new Map();

  constructor(
    private bridge: TelegramBridge,
    private db: Database.Database
  ) {}

  register(actionPrefix: string, handler: CallbackHandler): void {
    this.handlers.set(actionPrefix, handler);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- GramJS raw update event shape
  async handle(event: any): Promise<void> {
    try {
      const queryId = event.queryId;
      const data = event.data?.toString() || "";
      const chatId = event.peer?.toString() || event.chatInstance?.toString() || "";
      const messageId = event.msgId || 0;
      const userId = Number(event.userId);

      log.info(`[Callback] Received: data="${data}" from user ${userId} in chat ${chatId}`);

      const parts = data.split(":");
      const action = parts[0];
      const params = parts.slice(1);

      const handler = this.handlers.get(action);
      if (!handler) {
        log.warn(`No handler for callback action: ${action}`);
        await this.answerCallback(queryId, "Unknown action");
        return;
      }

      await handler({
        action,
        params,
        queryId,
        chatId,
        messageId,
        userId,
      });
    } catch (error) {
      log.error({ err: error }, "Error handling callback query");
      if (event?.queryId) {
        await this.answerCallback(event.queryId, "An error occurred. Please try again.");
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- GramJS BigInteger queryId
  private async answerCallback(queryId: any, message?: string, alert = false): Promise<void> {
    try {
      await this.bridge.getClient().answerCallbackQuery(queryId, { message, alert });
    } catch (error) {
      log.error({ err: error }, "Error answering callback");
    }
  }
}
