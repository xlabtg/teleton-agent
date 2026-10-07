---
title: "[AUDIT/V8] compose.yaml publishes the WebUI (full agent control, wallet) on all host interfaces by default"
labels: ["bug", "audit-finding-v8", "medium", "v3.x", "security"]
milestone: "v3.0 - Production Ready"
audit-source: "#738"
finding-id: "WORK8-012"
severity: "medium"
category: "security"
github-issue: "TBD"
---

## Problem Description

```yaml
TELETON_WEBUI_ENABLED: "true"
TELETON_WEBUI_HOST: 0.0.0.0
ports:
  - "${TELETON_WEBUI_PORT:-7777}:7777"
```
A short-form port mapping binds 0.0.0.0 on the host, and Docker also bypasses ufw/iptables INPUT rules. On a VPS, the WebUI (config, exec, wallet operations) becomes internet-reachable, protected only by the bearer token, and it serves plain HTTP. The helm chart, by contrast, defaults to ClusterIP.

## Location

- compose.yaml:29-32

## How To Reproduce

Run `docker compose up -d` on a cloud host, then `curl http://<public-ip>:7777/health` from outside, which returns `{"status":"ok"}`.

**Verification evidence:** compose.yaml:31-32 as quoted. This was not found in /tmp/prior-issues.txt (only #498/#512 introduced the deployment artifacts).

## Impact

Remote attack surface (token brute force, sniffing the token over plaintext HTTP), contrary to the local-first default of the non-docker install.

## Proposed Fix

Use `"127.0.0.1:${TELETON_WEBUI_PORT:-7777}:7777"` and document opting in to a public bind (behind a TLS reverse proxy).

## Regression Test

Add a CI step that runs `docker compose config` and asserts `ports[0].host_ip == "127.0.0.1"`.

## Acceptance Criteria

- [ ] By default the WebUI is reachable only from the host's loopback interface.

## Related Artifacts

- Report: `improvements/work8/AUDIT_V8_REPORT.md#work8-012`
- Audit track notes: `experiments/audit8/web-infra.md` (finding 4)
