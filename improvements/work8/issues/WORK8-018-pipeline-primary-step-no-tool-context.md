---
title: "[AUDIT/V8] Pipeline \"primary\" steps run the agent without toolContext: tool calls are dropped and the step is marked \"completed\" with an internal-error string"
labels: ["bug", "audit-finding-v8", "medium", "v3.x", "correctness"]
milestone: "v3.0 - Production Ready"
audit-source: "#738"
finding-id: "WORK8-018"
severity: "medium"
category: "correctness"
github-issue: "TBD"
---

## Problem Description

```ts
// executor.ts
const response = await this.deps.agent.processMessage({
  chatId: `pipeline:${runId}`, userName: "Pipeline", userMessage: action,
  timestamp: Date.now(), isGroup: false, pendingContext: JSON.stringify(context), signal: options.signal,
});                                   // <-- no toolContext
return response.content;
```
The runtime still selects tools and offers them to the LLM. When the model emits a tool call, the loop does this:
```ts
if (!this.toolRegistry || !toolContext) { log.error("⚠️ Cannot execute tools: registry or context missing"); break; }
...
if (!finalResponse) return { content: "Internal error: Agent loop failed to produce a response.", toolCalls: [] };
```
That return value does not throw, so the executor stores `"Internal error: ..."` as the step output. The step is marked `completed`, and the string is passed into `{output}` placeholders of the steps that depend on it. Every other `processMessage` caller (heartbeat, self-improvement, agent-actions, Telegram handlers) passes a `toolContext`. The pipeline is the only one that doesn't.

## Location

- `src/services/pipeline/executor.ts:318-327`, `src/agent/runtime.ts:1181-1183` and `:1551-1556`

## How To Reproduce

`experiments/audit8/repro-agent-3.test.ts` shows that `processMessage` receives `toolContext === undefined`, and that a run whose agent returns the runtime's internal-error text ends with status `completed` and `context.o = "Internal error..."`. With a real runtime, any action that needs a tool (for example "check wallet balance") produces that string.

**Verification evidence:** `repro-agent-3.test.ts` passed. Code paths are cited above.

## Impact

Pipelines silently can't use any tool. Failures are reported as success, and the garbage output feeds downstream steps.

## Proposed Fix

Pass a `toolContext` built the same way as the heartbeat's (bridge, db, admin `senderId`, config). The executor needs these as new deps. If tools aren't meant to be available, call the runtime in a no-tools mode. Separately, the runtime should throw instead of returning the "Internal error" text, so callers see a failure.

## Regression Test

Mock the runtime so that the LLM returns a toolCall. Assert that the pipeline step either executes the tool or ends in `failed`, never `completed` with the "Internal error" content.

## Acceptance Criteria

- [ ] Primary pipeline steps can execute permitted tools, and an agent-loop failure marks the step `failed`.

## Related Artifacts

- Report: `improvements/work8/AUDIT_V8_REPORT.md#work8-018`
- Audit track notes: `experiments/audit8/agent.md` (finding 3)
- Repro: `experiments/audit8/repro-agent-3.test.ts`
