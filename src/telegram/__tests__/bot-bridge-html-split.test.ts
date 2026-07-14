import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMessage = vi.fn();
let guestHandler: ((ctx: unknown) => Promise<void>) | undefined;

vi.mock("grammy", () => ({
  Bot: class {
    api = { sendMessage };
    catch(): void {}
    on(event: string, handler: (ctx: unknown) => Promise<void>): void {
      if (event === "guest_message") guestHandler = handler;
    }
  },
  InlineKeyboard: class {},
  InputFile: class {},
}));

import { GrammyBotBridge } from "../bridges/bot";

describe("GrammyBotBridge long HTML messages", () => {
  beforeEach(() => {
    sendMessage.mockReset();
    sendMessage.mockImplementation(async () => ({ message_id: 1, date: 1 }));
    guestHandler = undefined;
  });

  it("sends balanced chunks when formatting spans the Telegram limit", async () => {
    const bridge = new GrammyBotBridge({ bot_token: "test" });

    await bridge.sendMessage({ chatId: "123", text: `**${"word ".repeat(1200)}**` });

    expect(sendMessage.mock.calls.length).toBeGreaterThan(1);
    for (const [, html, options] of sendMessage.mock.calls) {
      expect(html.length).toBeLessThanOrEqual(4096);
      expect(html).toMatch(/^<b>.*<\/b>$/s);
      expect(options.parse_mode).toBe("HTML");
    }
  });

  it("truncates guest answers at a valid HTML chunk boundary", async () => {
    const bridge = new GrammyBotBridge({ bot_token: "test" });
    bridge.onGuestMessage(async () => `**${"word ".repeat(1200)}**`);
    const answerGuestQuery = vi.fn();

    await guestHandler?.({
      guestMessage: { message_id: 42, chat: { id: 123 }, from: { id: 456 } },
      answerGuestQuery,
    });

    const html = answerGuestQuery.mock.calls[0][0].input_message_content.message_text;
    expect(html.length).toBeLessThanOrEqual(4096);
    expect(html).toMatch(/^<b>.*<\/b>$/s);
  });
});
