---
title: "[AUDIT/V8] Setup server accepts cross-site / DNS-rebinding requests that overwrite the wallet and set owner/admin config"
labels: ["bug", "audit-finding-v8", "high", "v3.0-blocker", "security"]
milestone: "v3.0 - Production Ready"
audit-source: "#738"
finding-id: "WORK8-002"
severity: "high"
category: "security"
github-issue: "TBD"
---

## Problem Description

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

## Location

- src/webui/setup-server.ts:118-155, src/webui/routes/setup.ts:221 (`/wallet/generate`), :236 (`/wallet/import`), :476 (`/config/save`)
- also src/api/server.ts:363

## How To Reproduce

1. Run `teleton setup --ui`.
2. In the same browser, visit a page containing:
   `fetch("http://127.0.0.1:7777/api/setup/wallet/import",{method:"POST",mode:"no-cors",headers:{"Content-Type":"text/plain"},body:JSON.stringify({mnemonic:"<attacker 24 words>"})})`
3. ~/.teleton/wallet.json now contains the attacker's wallet. A similar `/config/save` call sets the attacker as owner/admin.

**Verification evidence:** experiments/audit8/repro-webui-1.test.ts was run temporarily from src/__tests__/audit8/ and has since been removed. It uses the same CORS config plus `createSetupRoutes()`. A `text/plain` POST with `Origin: https://evil.example` returned 200 with `success: true`, and no `Access-Control-Allow-Origin` header was set. This shows the handler runs even though CORS "blocks" the request. Test passed.

## Impact

Visiting a web page while setup is running can plant a wallet the attacker controls, so the user funds an attacker-controlled address. It can also destroy the freshly generated wallet, or make the attacker an admin with exec rights.

## Proposed Fix

- Add middleware on the setup server that rejects any request whose `Origin` is present and not in the allowlist. Also reject when `Host` is not `127.0.0.1:<port>` / `localhost:<port>` (this blocks DNS rebinding).
- Require `Content-Type: application/json` on all POST/PUT routes, which forces a preflight.
- Better still, require the existing setup nonce header on every mutating route, not only `/launch`.
- On `/v1/setup`, disable `/wallet/*` after setup (or when wallet.json exists) unless the caller explicitly passes `overwrite: true`.

## Regression Test

```ts
const res = await setupServerApp.request("/api/setup/wallet/generate", {
  method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "text/plain" }, body: "{}" });
expect(res.status).toBe(403);
const res2 = await setupServerApp.request("/api/setup/config/save", {
  method: "POST", headers: { Host: "evil.example:7777", "Content-Type": "application/json" }, body: "{}" });
expect(res2.status).toBe(403);
```

## Acceptance Criteria

- [ ] Mutating setup routes reject foreign Origin, foreign Host, and non-JSON Content-Type with 403/415.
- [ ] The legitimate setup UI flow still works.
- [ ] `/v1/setup/wallet/*` cannot overwrite an existing wallet without an explicit override.

## Related Artifacts

- Report: `improvements/work8/AUDIT_V8_REPORT.md#work8-002`
- Audit track notes: `experiments/audit8/webui.md` (finding 1)
- Repro: `experiments/audit8/repro-webui-1.test.ts`
