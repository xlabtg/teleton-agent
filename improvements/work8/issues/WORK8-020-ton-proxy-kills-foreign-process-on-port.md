---
title: "[AUDIT/V8] TON Proxy start sends SIGTERM to whatever process listens on the configured port (default 8080) and to a stale, possibly reused PID"
labels: ["bug", "audit-finding-v8", "medium", "v3.x", "reliability"]
milestone: "v3.0 - Production Ready"
audit-source: "#738"
finding-id: "WORK8-020"
severity: "medium"
category: "reliability"
github-issue: "https://github.com/xlabtg/teleton-agent/issues/759"
---

## Problem Description

```ts
const portLine = out.split("\n").find((line) => line.includes(`:${this.config.port} `));
const pidMatch = portLine?.match(/pid=(\d+)/);
if (pidMatch) { ... process.kill(pid, "SIGTERM"); }
```
and
```ts
const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
process.kill(pid, 0); process.kill(pid, "SIGTERM");
```
Neither check confirms that the target is a `tonutils-proxy-cli` process (no `/proc/<pid>/cmdline` or exe check). Port 8080 is a common default for other services (dev servers, Jupyter, local APIs). The line match `:8080 ` also matches peer-address columns. A PID file left by a crash can point to a PID the OS has since reused.

## Location

- `src/ton-proxy/manager.ts:189-231` (`killOrphan`), called from `start()` at `:262`
- default port `src/config/schema.ts:507` (`default(8080)`)

## How To Reproduce

1. Run `python3 -m http.server 8080` as the same user.
2. Set `ton_proxy.enabled: true` (default port), or start it from WebUI `/api/ton-proxy`.
3. The log shows "Port 8080 occupied by PID N, killing it" and the Python server is terminated.

**Verification evidence:** Read `killOrphan` and `start`, and confirmed the 8080 default in the config schema. No prior issue covers this (searched prior titles for "orphan", "kill", "pid").

## Impact

Enabling the feature silently kills unrelated user processes. The function also calls `Atomics.wait`, which blocks the event loop for 500 ms.

## Proposed Fix

Only kill a PID after checking that its command line or executable is the proxy binary under `BINARY_DIR` (`/proc/<pid>/exe` or `ps -o comm=`). If the port is held by something else, fail start with a clear "port in use" error.

## Regression Test

Mock `spawnSync("ss")` to return a line with `pid=1234` and mock the cmdline as `python3`. Expect `process.kill` not to be called and `start()` to reject with "port in use".

## Acceptance Criteria

- [ ] No signal is ever sent to a process that is not the managed proxy binary.
- [ ] Start fails cleanly when the port is taken.

## Related Artifacts

- Report: `improvements/work8/AUDIT_V8_REPORT.md#work8-020`
- Audit track notes: `experiments/audit8/ton.md` (finding 4)
