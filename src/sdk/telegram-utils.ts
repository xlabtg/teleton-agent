import type { TelegramBridge } from "../telegram/bridge.js";
import type { Api } from "telegram";
import type { SimpleMessage } from "@teleton-agent/sdk";
import { PluginSDKError } from "@teleton-agent/sdk";

export function requireBridge(bridge: TelegramBridge): void {
  if (!bridge.isAvailable()) {
    throw new PluginSDKError(
      "Telegram bridge not connected. SDK telegram methods can only be called at runtime (inside tool executors or start()), not during plugin loading.",
      "BRIDGE_NOT_CONNECTED"
    );
  }
}

export function getClient(bridge: TelegramBridge) {
  return bridge.getClient().getClient();
}

/** Convert a GramJS message to a SimpleMessage */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- GramJS message type is dynamic and untyped in SDK context
export function toSimpleMessage(msg: any): SimpleMessage {
  return {
    id: msg.id,
    text: msg.message ?? "",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- GramJS fromId is a union of untyped peer types
    senderId: Number((msg.fromId as any)?.userId ?? (msg.fromId as any)?.channelId ?? 0),
    timestamp: new Date(msg.date * 1000),
  };
}

/** Cached dynamic import of telegram Api (needed in files with type-only imports) */
let _Api: typeof Api;
export async function getApi(): Promise<typeof Api> {
  if (!_Api) {
    _Api = (await import("telegram")).Api;
  }
  return _Api;
}
