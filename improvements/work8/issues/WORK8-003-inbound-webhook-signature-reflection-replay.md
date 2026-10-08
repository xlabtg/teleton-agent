---
title: "[AUDIT/V8] Inbound webhook signature reuses the outbound HMAC: reflection, replay, and arbitrary internal event injection with fan-out"
labels: ["bug", "audit-finding-v8", "high", "v3.0-blocker", "security"]
milestone: "v3.0 - Production Ready"
audit-source: "#738"
finding-id: "WORK8-003"
severity: "high"
category: "security"
github-issue: "https://github.com/xlabtg/teleton-agent/issues/742"
---

## Problem Description

Inbound verification uses exactly the same construction as outbound signing:

```ts
// outbound (attemptDelivery)
"X-Webhook-Signature": signedHeader(webhook.secret, payload),
// inbound
const expected = signedHeader(webhook.secret, rawBody);
```

The route then trusts the event type sent in the body:

```ts
const eventType = typeof payload.type === "string" ? payload.type : "webhook.incoming";
const event = await getEventBus(deps.memory.db).publish({ ...
```

The dispatcher subscribes to `"*"` (line 228), which causes the following problems:
- The signature covers neither a timestamp nor a nonce, so any captured request can be replayed forever.
- Every outbound delivery (body plus `X-Webhook-Signature`) is already a valid inbound request for `/incoming/:id`. A receiver, or anyone who logs the delivery, can reflect it back.
- Anyone with one webhook's secret can publish any internal type, such as `security.alert` or `agent.message.sent`. The dispatcher then re-signs and delivers that event to every other subscribed webhook, which can loop between the two directions. The spoofed events are also stored in event_log and can be replayed through the events API.

## Location

- src/services/webhook-dispatcher.ts:184, :385-393, :436
- src/webui/routes/webhooks.ts:72-79

## How To Reproduce

1. Create webhook A, subscribed to `*`, with a target URL you control.
2. Capture one delivery (body plus signature) and POST it unchanged to `/api/webhooks/incoming/<A.id>`. It returns 2xx, and the event is re-published and re-delivered to A, repeating without end.
3. Sign `{"type":"security.alert",...}` with A's secret and POST it. Other webhooks receive a signed `security.alert`.

**Verification evidence:** Confirmed by reading the source. The outbound (line 436) and inbound (line 393) code both call `signedHeader(webhook.secret, body)`. webhooks.ts:78 passes `payload.type` through. The dispatcher subscribes to `"*"` at line 228. There is no timestamp check anywhere in verifyIncomingSignature.

## Impact

Forged security and agent events reach downstream systems carrying valid signatures from the agent. Requests can be replayed, and delivery loops amplify traffic.

## Proposed Fix

- Use a separate inbound secret, or a domain-separated HMAC such as `HMAC(secret, "inbound:" + ts + "." + body)`.
- Require an `X-Webhook-Timestamp` within 5 minutes and keep a cache of recently seen signatures.
- Always publish inbound events as `webhook.incoming`, putting the caller's type inside `data.type`. Never allow reserved EVENT_TYPES.
- Do not fan `webhook.incoming` out to the webhook that originated it.

## Regression Test

```ts
const body = JSON.stringify({ type: "security.alert" });
const sig = signedHeaderForTest(secret, body); // outbound-style
const res = await app.request(`/api/webhooks/incoming/${id}`, { method: "POST", body, headers: { "X-Webhook-Signature": sig } });
expect(res.status).toBe(401); // outbound-format signature rejected
// with valid inbound sig + timestamp:
expect(publishedEvent.type).toBe("webhook.incoming");
// replay of the same request -> 409/401
```

## Acceptance Criteria

- [ ] An outbound delivery cannot be accepted as an inbound request.
- [ ] Stale or replayed requests are rejected.
- [ ] Inbound requests cannot publish reserved internal event types.
- [ ] No webhook delivery loop is possible.

## Related Artifacts

- Report: `improvements/work8/AUDIT_V8_REPORT.md#work8-003`
- Audit track notes: `experiments/audit8/webui.md` (finding 2)
