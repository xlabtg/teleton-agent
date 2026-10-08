# Audit 8 - WebUI / Management API / Webhooks / Audit trail / Marketplace

Scope: src/webui (server, routes, setup server, services/marketplace), src/api, src/services/webhook-dispatcher.ts, src/services/audit-trail.ts, integrations.
Findings below were deduplicated against /tmp/prior-issues.txt and improvements/work*/issues/*.md. Prior issues cover outbound webhook SSRF (#530/#559), workflow webhook secret timing (#529), the setup launch nonce (#274), and integration SSRF (#696/#719). None of the findings below overlap with those.

---

## 1. Setup server accepts cross-site / DNS-rebinding requests that overwrite the wallet and set owner/admin config

- Severity: High
- Category: Security (CSRF / DNS rebinding), financial safety
- Location: src/webui/setup-server.ts:118-155, src/webui/routes/setup.ts:221 (`/wallet/generate`), :236 (`/wallet/import`), :476 (`/config/save`); also src/api/server.ts:363

### Problem
The setup server listens on 127.0.0.1:7777 with no auth. Only `/api/setup/launch` is protected by a nonce. Its only cross-origin protection is CORS:

```ts
cors({
  origin: ["http://localhost:5173", `http://localhost:${this.port}`, "http://127.0.0.1:5173", `http://127.0.0.1:${this.port}`],
  credentials: true, ...
})
```

CORS only controls whether a browser may read the response. It does not stop the request. A `POST` with `Content-Type: text/plain` counts as a "simple" request, so the browser sends it without a preflight. Hono's `c.req.json()` parses the body whatever the Content-Type is, so the handler runs:

```ts
app.post("/validate/api-key", async (c) => {
  const body = await c.req.json<{ provider: string; apiKey: string }>();
```

The same applies to `POST /wallet/generate`, which calls `saveWallet` and overwrites wallet.json. It also applies to `POST /wallet/import` (attacker-chosen mnemonic) and `POST /config/save` (owner_id/admin_ids, exec mode, `expose_lan` -> api.host 0.0.0.0). Nothing checks the Origin or Host header, so DNS rebinding also gives the attacker full read access.

Secondary: `createSetupRoutes` is also mounted on the Management API at `/v1/setup` (src/api/server.ts:363). After setup, any API-key holder can still regenerate or import over the live wallet.

### How to reproduce
1. Run `teleton setup --ui`.
2. In the same browser, visit a page containing:
   `fetch("http://127.0.0.1:7777/api/setup/wallet/import",{method:"POST",mode:"no-cors",headers:{"Content-Type":"text/plain"},body:JSON.stringify({mnemonic:"<attacker 24 words>"})})`
3. ~/.teleton/wallet.json now contains the attacker's wallet. A similar `/config/save` call sets the attacker as owner/admin.

### Impact
Visiting a web page while setup is running can plant a wallet the attacker controls, so the user funds an attacker-controlled address. It can also destroy the freshly generated wallet, or make the attacker an admin with exec rights.

### Proposed fix
- Add middleware on the setup server that rejects any request whose `Origin` is present and not in the allowlist. Also reject when `Host` is not `127.0.0.1:<port>` / `localhost:<port>` (this blocks DNS rebinding).
- Require `Content-Type: application/json` on all POST/PUT routes, which forces a preflight.
- Better still, require the existing setup nonce header on every mutating route, not only `/launch`.
- On `/v1/setup`, disable `/wallet/*` after setup (or when wallet.json exists) unless the caller explicitly passes `overwrite: true`.

### Regression test sketch (vitest)
```ts
const res = await setupServerApp.request("/api/setup/wallet/generate", {
  method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "text/plain" }, body: "{}" });
expect(res.status).toBe(403);
const res2 = await setupServerApp.request("/api/setup/config/save", {
  method: "POST", headers: { Host: "evil.example:7777", "Content-Type": "application/json" }, body: "{}" });
expect(res2.status).toBe(403);
```

### Acceptance criteria
- Mutating setup routes reject foreign Origin, foreign Host, and non-JSON Content-Type with 403/415.
- The legitimate setup UI flow still works.
- `/v1/setup/wallet/*` cannot overwrite an existing wallet without an explicit override.

### Verification evidence
experiments/audit8/repro-webui-1.test.ts was run temporarily from src/__tests__/audit8/ and has since been removed. It uses the same CORS config plus `createSetupRoutes()`. A `text/plain` POST with `Origin: https://evil.example` returned 200 with `success: true`, and no `Access-Control-Allow-Origin` header was set. This shows the handler runs even though CORS "blocks" the request. Test passed.

---

## 2. Inbound webhook signature reuses the outbound HMAC: reflection, replay, and arbitrary internal event injection with fan-out

- Severity: High
- Category: Security (authentication / event spoofing)
- Location: src/services/webhook-dispatcher.ts:184, :385-393, :436; src/webui/routes/webhooks.ts:72-79

### Problem
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

### How to reproduce
1. Create webhook A, subscribed to `*`, with a target URL you control.
2. Capture one delivery (body plus signature) and POST it unchanged to `/api/webhooks/incoming/<A.id>`. It returns 2xx, and the event is re-published and re-delivered to A, repeating without end.
3. Sign `{"type":"security.alert",...}` with A's secret and POST it. Other webhooks receive a signed `security.alert`.

### Impact
Forged security and agent events reach downstream systems carrying valid signatures from the agent. Requests can be replayed, and delivery loops amplify traffic.

### Proposed fix
- Use a separate inbound secret, or a domain-separated HMAC such as `HMAC(secret, "inbound:" + ts + "." + body)`.
- Require an `X-Webhook-Timestamp` within 5 minutes and keep a cache of recently seen signatures.
- Always publish inbound events as `webhook.incoming`, putting the caller's type inside `data.type`. Never allow reserved EVENT_TYPES.
- Do not fan `webhook.incoming` out to the webhook that originated it.

### Regression test sketch (vitest)
```ts
const body = JSON.stringify({ type: "security.alert" });
const sig = signedHeaderForTest(secret, body); // outbound-style
const res = await app.request(`/api/webhooks/incoming/${id}`, { method: "POST", body, headers: { "X-Webhook-Signature": sig } });
expect(res.status).toBe(401); // outbound-format signature rejected
// with valid inbound sig + timestamp:
expect(publishedEvent.type).toBe("webhook.incoming");
// replay of the same request -> 409/401
```

### Acceptance criteria
- An outbound delivery cannot be accepted as an inbound request.
- Stale or replayed requests are rejected.
- Inbound requests cannot publish reserved internal event types.
- No webhook delivery loop is possible.

### Verification evidence
Confirmed by reading the source. The outbound (line 436) and inbound (line 393) code both call `signedHeader(webhook.secret, body)`. webhooks.ts:78 passes `payload.type` through. The dispatcher subscribes to `"*"` at line 228. There is no timestamp check anywhere in verifyIncomingSignature.

---

## 3. Webhook retries are lost on restart (rows stuck in `retrying` forever)

- Severity: Medium
- Category: Reliability / data loss
- Location: src/services/webhook-dispatcher.ts:207, :461-479, :488-495

### Problem
Retries exist only as in-memory timers:

```ts
private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
...
const status: WebhookDeliveryStatus = exhausted ? "failed" : "retrying";
...
this.scheduleRetry(deliveryId, nextAttemptAt - attemptedAt);
```

`next_attempt_at` is persisted but never read. Nothing at start-up loads rows with `status='retrying'` (a grep for `retrying` and `next_attempt_at` finds only the write path and the schema).

### How to reproduce
Point a webhook at an endpoint that returns 500 and trigger an event, so the delivery row becomes `retrying`. Restart the agent and fix the endpoint. The row stays `retrying` indefinitely and the event is never delivered.

### Impact
Events are silently lost on every restart, deploy, or crash while a target is temporarily down. The UI shows "retrying" forever.

### Proposed fix
In `start()`, select the `retrying` rows and call `scheduleRetry` for each with `max(0, next_attempt_at - now)`. Alternatively, use a periodic sweeper that claims due rows.

### Regression test sketch (vitest)
```ts
insertDelivery(db, { status: "retrying", next_attempt_at: Date.now() - 1, attempt: 1 });
const d = new WebhookDispatcher(db); d.start();
await vi.runAllTimersAsync();
expect(fetchMock).toHaveBeenCalledTimes(1);
expect(getDelivery(db).status).toBe("delivered");
```

### Acceptance criteria
After a restart, due retries are attempted, and future retries are scheduled at their persisted time.

### Verification evidence
Confirmed by reading the source and grepping. The only consumers of retry state are `scheduleRetry` (setTimeout) and the `timers` Map. Nothing reads `next_attempt_at`.

---

## 4. `AuditTrailService.pruneBefore` makes `verifyIntegrity` report tampering on an untampered log

- Severity: Medium
- Category: Correctness / data integrity (false tamper alarm)
- Location: src/services/audit-trail.ts:288-322, :446-449

### Problem
```ts
pruneBefore(cutoffUnix: number): number {
  const result = this.db.prepare(`DELETE FROM audit_events WHERE created_at < ?`).run(cutoffUnix);
```
After pruning, `verifyIntegrity()` seeds the chain from `SELECT checksum ... WHERE sequence < first`. That row has been deleted, so the seed is `null`. The first surviving row still stores its predecessor's checksum in `previous_checksum`, so the check fails:

```ts
if (row.previous_checksum !== previousChecksum) { result.valid = false; ... "Previous checksum mismatch"
```

`exportEvents` (line 393) embeds this result, so every export after a prune is flagged as tampered. `pruneBefore` is a public API with no in-tree callers yet. Wiring up any retention job triggers the bug.

### How to reproduce
Record 3 events with createdAt 1000/2000/3000 and confirm `verifyIntegrity().valid === true`. Then call `pruneBefore(1500)` and `verifyIntegrity()`. The result is `valid === false`, with `brokenAtEventId` set to the first surviving event.

### Impact
Applying a retention policy causes permanent false tamper alerts. Operators then cannot tell real tampering from pruning, which defeats the purpose of the audit log.

### Proposed fix
In the same transaction as the delete, store an anchor (the last pruned `sequence` and `checksum`) in an `audit_meta` table. `verifyIntegrity` uses this anchor when no earlier row exists. Alternatively, when the first row checked is the oldest remaining row, accept its `previous_checksum` only if it matches the stored anchor.

### Regression test sketch (vitest)
```ts
const svc = new AuditTrailService(new Database(":memory:"));
for (const t of [1000, 2000, 3000]) svc.recordEvent({ eventType: "config.changed", createdAt: t });
svc.pruneBefore(1500);
expect(svc.verifyIntegrity().valid).toBe(true);
db.prepare("UPDATE audit_events SET payload='{\"x\":1}' WHERE sequence=2").run();
expect(svc.verifyIntegrity().valid).toBe(false);
```

### Acceptance criteria
After a prune, verification still passes on an untouched log, and real tampering of the surviving rows (including the first one) is still detected.

### Verification evidence
Confirmed by reading the source (lines 294-322 and 446-449). A repro is written in experiments/audit8/repro-webui-2.test.ts. It could not be executed here because the better-sqlite3 native binding is not built in this environment (the "Could not locate the bindings file" error). The logic is deterministic: after the delete, the seed query returns undefined, so the seed is null, while the row's previous_checksum is not null.

---

## 5. Marketplace `updatePlugin` uninstalls before installing; a failed download deletes the plugin

- Severity: Medium
- Category: Reliability / data loss
- Location: src/webui/services/marketplace.ts:577-582

### Problem
```ts
async updatePlugin(pluginId: string) {
  await this.uninstallPlugin(pluginId);
  return this.installPlugin(pluginId);
}
```
`uninstallPlugin` removes the plugin directory with `rmSync` and unregisters its tools. If `installPlugin` then fails (GitHub rate limit, network error, bad manifest, or a registry entry removed), nothing restores the plugin. Its tools disappear until someone manually reinstalls it.

### How to reproduce
Install a plugin, then make `fetch` reject (or return 403) and call `POST /api/marketplace/update`. The request returns an error, the plugin directory is gone, and its tools are no longer registered.

### Impact
A transient network error during a routine update permanently removes a working plugin, along with any local state in its directory.

### Proposed fix
Download and validate into a temporary directory first. Only after that succeeds, move the old directory to a backup, swap in the new one, and re-register. On any failure, restore the backup and re-register the old module.

### Regression test sketch (vitest)
```ts
await svc.installPlugin("demo");
fetchMock.mockRejectedValue(new Error("network"));
await expect(svc.updatePlugin("demo")).rejects.toThrow();
expect(existsSync(join(PLUGINS_DIR, "demo"))).toBe(true);
expect(registry.getToolNames()).toContain("demo_tool");
```

### Acceptance criteria
A failed update leaves the previously installed version on disk and registered. A successful update replaces it atomically.

### Verification evidence
Confirmed by reading the source (lines 577-582). `uninstallPlugin` performs the `rmSync` of the plugin directory before `installPlugin` performs any network I/O.
