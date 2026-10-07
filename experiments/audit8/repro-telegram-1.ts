import { withFloodRetry } from "./telegram/flood-retry.ts";
import { splitMessageForTelegram } from "./telegram/message-splitter.ts";
import { readFileSync } from "node:fs";
// 1/2: AdminHandler methods copied verbatim from src/telegram/admin.ts:53-107
const body = readFileSync(new URL("./admin-methods.txt", import.meta.url), "utf8")
  .replace(/\): (boolean|AdminCommand \| null) \{/g, ") {").replace(/\(userId: number\)/g, "(userId)")
  .replace(/\(userId: number, chatId: string\)/, "(userId, chatId)").replace(/\(message: string\)/, "(message)");
const Cls = new Function(`return class { constructor(c){this.config=c;this.paused=false;} ${body} }`)();
const h = new Cls({ admin_ids: [1], command_access: { commands_enabled: true, admin_only_commands: true, allowed_user_ids: [], allowed_chat_ids: [] } });
for (const t of ["...so what do you think?", "!important question", ".NET or Java?", "/status@my_bot"]) {
  console.log(JSON.stringify(t), "->", JSON.stringify(h.parseCommand(t)), "allowed for non-admin:", h.isCommandAllowed(2, "2"));
}
// 3: nested flood retry
let calls = 0;
const t0 = Date.now();
const flood = () => { calls++; return Promise.reject(Object.assign(new Error("FLOOD"), { seconds: 0.05 })); };
await withFloodRetry(() => withFloodRetry(flood), undefined, undefined, "c1").catch(() => {});
console.log("nested withFloodRetry attempts:", calls, "(expected 3)");
// 5: surrogate split
const parts = splitMessageForTelegram("a" + "😀".repeat(30), 10);
console.log("lone surrogate in parts:", parts.some((p) => /[\ud800-\udbff]$/.test(p) || /^[\udc00-\udfff]/.test(p)));
console.log("utf8 roundtrip broken:", parts.join("") !== Buffer.from(parts.map(p=>Buffer.from(p).toString()).join("")).toString() || parts.some(p => Buffer.from(p).toString() !== p));
