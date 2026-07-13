---
title: "[AUDIT/V7] HTTP integration provider fetches caller-controlled URLs with no private-IP/SSRF guard"
labels: ["bug", "audit-finding-v7", "medium", "security"]
milestone: "v3.0 - Production Ready"
audit-source: "#689"
finding-id: "WORK7-006"
severity: "medium"
category: "security"
github-issue: ""
---

## Problem Description

The HTTP integration provider issues outbound requests to URLs derived from
integration config and per-call params, validating only the scheme (and, when a
`baseUrl` is set, same-origin) — never blocking private/link-local/metadata
addresses:

```ts
// src/services/integrations/providers.ts (resolveUrl)
const target = stringValue(params.url) || actionConfig.url || stringValue(params.path) || actionConfig.path;
const url = baseUrl ? new URL(interpolated, baseUrl) : new URL(interpolated);
if (!["http:", "https:"].includes(url.protocol)) throw new Error("...http and https URLs");
if (baseUrl) { /* same-origin check, skippable via allowCrossOrigin:true */ }
```

`healthCheck` similarly fetches `entity.healthCheckUrl` directly
(`providers.ts:50-61`). When no `baseUrl` is configured (or `allowCrossOrigin` is
enabled), `params.url` is fetched as-is, so a request can target
`http://169.254.169.254/…` (cloud metadata), `http://127.0.0.1:…`, or other
internal services. This is the same SSRF class as WORK6-005 (OAuth token
exchange), on a different, agent/operator-reachable code path.

## Location

- `src/services/integrations/providers.ts:137-165` — `resolveUrl` (no host/IP
  validation).
- `src/services/integrations/providers.ts:50-61` — `healthCheck` fetch of
  `healthCheckUrl`.
- `src/services/integrations/providers.ts:111` — `fetchWithTimeout(url.toString())`.

## How To Reproduce

1. Configure an HTTP integration without `baseUrl` (or with
   `allowCrossOrigin: true`).
2. Invoke an action with `params.url = "http://169.254.169.254/latest/meta-data/"`.
3. The provider fetches it and returns the response body/headers to the caller.

## Impact

Server-side request forgery: read access to cloud metadata endpoints (credential
theft), internal-only admin/health endpoints, and port scanning of the host
network, with the response reflected back to the caller.

## Proposed Fix

- Resolve the target host and reject private, loopback, link-local, and
  unique-local ranges (and re-check after DNS resolution to defeat rebinding), for
  both the action path and `healthCheckUrl`.
- Reuse the outbound-URL guard already applied elsewhere (the connection-pinned
  fetch used for the SSRF-hardened paths) rather than a bare `fetch`.
- Consider requiring an explicit allowlist for cross-origin/no-baseUrl integrations.

## Regression Test

```typescript
it("rejects integration requests to private/metadata addresses", async () => {
  const provider = makeHttpProvider({ /* no baseUrl */ });
  await expect(provider.request({ url: "http://169.254.169.254/latest/meta-data/" }))
    .rejects.toThrow(/blocked|private|not allowed/i);
});
```

## Acceptance Criteria

- [ ] Requests to loopback/private/link-local/metadata hosts are blocked
      (post-DNS-resolution).
- [ ] `healthCheckUrl` is subject to the same guard.
- [ ] Legitimate public integrations are unaffected.

## Related Artifacts

- Report: `improvements/work7/AUDIT_V7_REPORT.md#work7-006`
- Modules: `src/services/integrations/providers.ts`
- Related: WORK6-005 (OAuth token-exchange SSRF).
