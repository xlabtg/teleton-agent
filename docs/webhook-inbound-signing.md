# Подпись входящего webhook

POST `/v1/webhooks/incoming/:id` принимает JSON и использует secret соответствующего активного webhook. Клиент передаёт два заголовка:

- `X-Webhook-Timestamp`: Unix timestamp в секундах; допускается отклонение до 300 секунд.
- `X-Webhook-Signature`: `sha256=` плюс hex HMAC-SHA256 от строки `inbound:<timestamp>.<rawBody>` с webhook secret.

Подписывается точная UTF-8 строка HTTP body, включая whitespace. Пример Node.js:

```js
import { createHmac } from "node:crypto";
const rawBody = JSON.stringify({ orderId: "123", status: "paid" });
const timestamp = String(Math.floor(Date.now() / 1000));
const signature = "sha256=" + createHmac("sha256", secret)
  .update(`inbound:${timestamp}.${rawBody}`)
  .digest("hex");
await fetch(incomingUrl, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Webhook-Timestamp": timestamp,
    "X-Webhook-Signature": signature,
  },
  body: rawBody,
});
```

Повторная отправка той же подписи запрещена, в том числе после перезапуска сервера. Для отдельного нового события используйте новый timestamp/body. Старые inbound интеграции, подписывавшие только body, необходимо обновить. Outbound подпись остаётся прежней и не принимается inbound маршрутом.

Событие всегда имеет type `webhook.incoming`, source `webhook:<id>`, а исходный JSON хранится в payload. Поле `type` из body не задаёт внутренний тип события. Входящее событие не отправляется outbound webhook, поэтому подписанный callback не образует delivery loop.
