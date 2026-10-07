---
title: "[AUDIT/V8] The registry's hard 90s tool timeout abandons exec commands that are still running (exec default limit is 120s), so the agent is told the command failed while it keeps running"
labels: ["bug", "audit-finding-v8", "medium", "v3.x", "reliability"]
milestone: "v3.0 - Production Ready"
audit-source: "#738"
finding-id: "WORK8-019"
severity: "medium"
category: "reliability"
github-issue: "TBD"
---

## Problem Description

```ts
const result = await Promise.race([
  registered.executor(validatedArgs, context),
  new Promise<never>((_, reject) => { timeoutHandle = setTimeout(() => reject(new Error(`Tool "${toolCall.name}" timed out after 90s`)), TOOL_EXECUTION_TIMEOUT_MS); }),
])
```
The race rejects but does not cancel the executor, because no AbortSignal is passed to it. `exec_run`, `exec_install` and `exec_service` enforce their own limit (`exec.limits.timeout`, 120s by default, up to 3600s). So:
- the configured exec timeout can never take effect above 90s;
- at 90s the agent gets a failure while the shell command keeps running for up to the configured limit, and its exit code and output are thrown away;
- the LLM will typically retry, so a non-idempotent command (an install, a deploy, a payment script) runs twice, possibly at the same time.

The same pattern applies to MCP tools (`mcp-loader.ts:305`).

## Location

- `src/agent/tools/registry.ts:283-299`, `src/constants/timeouts.ts:26` (`TOOL_EXECUTION_TIMEOUT_MS = 90_000`), `src/config/schema.ts:793` (`exec.limits.timeout ... max(3600).default(120)`)

## How To Reproduce

`experiments/audit8/repro-agent-4.test.ts` uses fake timers. An `exec_run` executor that takes 100s returns `{success:false, error:'Tool "exec_run" timed out after 90s'}` at 90s, and its side effect still completes 10s later.

**Verification evidence:** `repro-agent-4.test.ts` passed. The logged error was `Tool "exec_run" timed out after 90s` and `finished` flipped to true afterwards.

## Impact

Duplicate side effects, a misleading failure reported to the agent and the user, orphaned processes, and the `exec.limits.timeout` setting being silently capped.

## Proposed Fix

Give each tool its own timeout. For exec tools, use `max(TOOL_EXECUTION_TIMEOUT_MS, exec.limits.timeout*1000 + KILL_GRACE_MS)`, or let tools declare a timeout. Pass an `AbortSignal` in `ToolContext` that the exec runner uses to kill the process group on registry timeout. When a tool is abandoned, record it as "timed out (may still be running)".

## Regression Test

Register `exec_run` with `exec.limits.timeout=120`. Under fake timers, assert that the registry does not reject at 90s. Separately, assert that a registry timeout aborts the signal and the runner kills the child.

## Acceptance Criteria

- [ ] The configured exec timeout is honored end to end, and no tool keeps running after the registry has reported it as failed.

## Related Artifacts

- Report: `improvements/work8/AUDIT_V8_REPORT.md#work8-019`
- Audit track notes: `experiments/audit8/agent.md` (finding 4)
- Repro: `experiments/audit8/repro-agent-4.test.ts`
