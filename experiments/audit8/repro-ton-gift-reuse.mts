import { verifyGiftPayment } from "../../src/deals/gift-matcher.ts";
const gifts = [{ msgId: "777", slug: "plush-pepe", name: "x", fromUserId: 42, receivedAt: 1_700_000_100_000 }];
const dealA = { user_gives_gift_slug: "plush-pepe", user_telegram_id: 42, created_at: 1_700_000_000 };
const dealB = { user_gives_gift_slug: "plush-pepe", user_telegram_id: 42, created_at: 1_700_000_050 };
console.log("deal A:", verifyGiftPayment(dealA as any, gifts as any).gift?.msgId);
console.log("deal B:", verifyGiftPayment(dealB as any, gifts as any).gift?.msgId);
