---
title: "[AUDIT/V8] web_download_binary SSRF guard is bypassed by every IPv6 literal and by redirects to private hosts"
labels: ["bug", "audit-finding-v8", "high", "v3.0-blocker", "security"]
milestone: "v3.0 - Production Ready"
audit-source: "#738"
finding-id: "WORK8-004"
severity: "high"
category: "security"
github-issue: "https://github.com/xlabtg/teleton-agent/issues/743"
---

## Problem Description

```ts
const ipVersion = isIP(normalized);
...
if (ipVersion === 6) {
  return normalized === "::1" || normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd");
}
return false;
```
`new URL("http://[::1]/").hostname` is `"[::1]"`, with the brackets. `isIP("[::1]")` returns `0`, so the IPv6 branch never runs and every bracketed IPv6 literal is allowed: `[::1]`, `[::ffff:127.0.0.1]`, `[::ffff:169.254.169.254]` and `[fd00::1]`. Three more gaps:
- the hostname is never resolved, so a public name that points at 127.0.0.1 or 10.x passes;
- the fetch uses `redirect: "follow"`, so a public URL that returns a 302 to `http://169.254.169.254/...` makes the server send the internal request. The `parseHttpUrl(finalUrl)` check only runs after that request has already been made;
- the caller can supply request headers such as `Authorization`, and those are forwarded along the redirect chain.

The LLM can call this tool. Content from a prompt injection (a web page, a forwarded message) can therefore make the agent reach loopback or metadata services.

## Location

- `src/agent/tools/web/download-binary.ts:127` (`redirect: "follow"`), `:201-229` (`isBlockedHostname`)

## How To Reproduce

`experiments/audit8/repro-agent-2.test.ts`: stub `fetch` and call `webDownloadBinaryExecutor({url:"http://[::1]:8080/a.png"})`. `fetch` is called and the result is `Download failed: 404`, not `Blocked private or local hostname`. The same happens for `[::ffff:127.0.0.1]`, `[fd00::1]` and `[::ffff:169.254.169.254]`.

**Verification evidence:** `repro-agent-2.test.ts` passed 5/5. All four IPv6 URLs reached `fetch`, and `init.redirect === "follow"`.

## Impact

Blind and semi-blind SSRF to loopback admin ports (WebUI and management API on 127.0.0.1), cloud metadata and the LAN. If the response is an allowed binary MIME type, it is written to `workspace/downloads/` and can then be read back.

## Proposed Fix

Reuse the DNS-resolving SSRF guard already used for workflows, webhooks and MCP (the one fixed in #555/#588/#530):
- strip the brackets before calling `isIP`;
- block IPv4-mapped (`::ffff:`), NAT64, `::`, unique-local and link-local addresses;
- resolve the hostname and check every address;
- use `redirect: "manual"` and re-validate each hop, with a maximum hop count;
- drop caller-supplied headers on cross-origin redirects.

## Regression Test

Stub `fetch`. For each of `[::1]`, `[::ffff:7f00:1]`, `[fd00::1]`, `[fe80::1]`, and a hostname whose resolution is mocked to 10.0.0.1, assert that `fetch` is never called and the error matches `/Blocked/`. Stub a 302 to `http://127.0.0.1/` and assert the second hop is never fetched.

## Acceptance Criteria

- [ ] No request reaches a private, loopback or link-local address, whether the address comes from an IPv6 literal, a DNS name or a redirect.

## Related Artifacts

- Report: `improvements/work8/AUDIT_V8_REPORT.md#work8-004`
- Audit track notes: `experiments/audit8/agent.md` (finding 1)
- Repro: `experiments/audit8/repro-agent-2.test.ts`
