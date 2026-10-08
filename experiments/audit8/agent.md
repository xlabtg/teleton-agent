# Audit 8 — agent runtime / tools / pipeline / managed agents

Repro tests live in `experiments/audit8/repro-agent-*.test.ts`. The vitest include globs only cover `src/**/__tests__`, so I copied each test to `src/__tests__/audit8/` (import paths rewritten), ran it there, and then deleted that directory. All four passed, which confirms each bug.

---

## 1. web_download_binary SSRF guard is bypassed by every IPv6 literal and by redirects to private hosts

- **Severity:** high
- **Category:** security
- **Location:** `src/agent/tools/web/download-binary.ts:127` (`redirect: "follow"`), `:201-229` (`isBlockedHostname`)

### Problem
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

### How to reproduce
`experiments/audit8/repro-agent-2.test.ts`: stub `fetch` and call `webDownloadBinaryExecutor({url:"http://[::1]:8080/a.png"})`. `fetch` is called and the result is `Download failed: 404`, not `Blocked private or local hostname`. The same happens for `[::ffff:127.0.0.1]`, `[fd00::1]` and `[::ffff:169.254.169.254]`.

### Impact
Blind and semi-blind SSRF to loopback admin ports (WebUI and management API on 127.0.0.1), cloud metadata and the LAN. If the response is an allowed binary MIME type, it is written to `workspace/downloads/` and can then be read back.

### Proposed fix
Reuse the DNS-resolving SSRF guard already used for workflows, webhooks and MCP (the one fixed in #555/#588/#530):
- strip the brackets before calling `isIP`;
- block IPv4-mapped (`::ffff:`), NAT64, `::`, unique-local and link-local addresses;
- resolve the hostname and check every address;
- use `redirect: "manual"` and re-validate each hop, with a maximum hop count;
- drop caller-supplied headers on cross-origin redirects.

### Regression test sketch
Stub `fetch`. For each of `[::1]`, `[::ffff:7f00:1]`, `[fd00::1]`, `[fe80::1]`, and a hostname whose resolution is mocked to 10.0.0.1, assert that `fetch` is never called and the error matches `/Blocked/`. Stub a 302 to `http://127.0.0.1/` and assert the second hop is never fetched.

### Acceptance criteria
No request reaches a private, loopback or link-local address, whether the address comes from an IPv6 literal, a DNS name or a redirect.

### Verification evidence
`repro-agent-2.test.ts` passed 5/5. All four IPv6 URLs reached `fetch`, and `init.redirect === "follow"`.

---

## 2. Managed-agent edits write the parent's environment-variable secrets and identity into the child's config.yaml

- **Severity:** high
- **Category:** security / data-integrity
- **Location:** `src/agents/service.ts:810` and `:852` (`updateAgent`), `:1015` and `:1022` (personal auth). The root cause is in `src/config/loader.ts:184-203`, which applies env overrides inside `loadConfig`. Related: `src/agents/service.ts:530`.

### Problem
`loadConfig()` mutates the loaded config with the process environment (`TELETON_API_KEY`, `TELETON_TG_PHONE`, `TELETON_TG_API_ID/HASH`, `TELETON_TG_BOT_TOKEN`, `TELETON_BASE_URL`, ...). `ManagedAgentService` loads the child's config through that function in the parent process, then saves it:
```ts
const config = loadConfig(definition.configPath);   // parent env applied here
...
saveConfig(config, definition.configPath);          // and persisted to the child's file
```
So an unrelated edit, such as changing only the description, permanently replaces the child agent's own phone, Telegram API credentials and LLM key with the parent's values. Those values are written in plaintext, even though the operator deliberately kept them out of files by using env vars.

In addition, `startAgent` spawns the child with `...process.env`. A personal-mode child, which gets no bot token of its own, inherits the parent's `TELETON_TG_BOT_TOKEN`, phone and API credentials, and its own `loadConfig` applies them on boot. A `snapshot` or `startAgent` check run in the parent (`hasPersonalSession(config)`, `resolveBotToken`) also sees the parent's values, not the child's.

### How to reproduce
`experiments/audit8/repro-agent-1.test.ts`:
1. Create a personal agent with phone `+15551234567`.
2. Set `TELETON_TG_PHONE=+19990000000` and `TELETON_API_KEY=sk-...PARENT-ENV-SECRET`.
3. Call `updateAgent(id,{description:"x"})`.

The child's `config.yaml` now contains `phone: "+19990000000"` and the parent's `api_key`.

### Impact
- Env-only secrets end up in plaintext on disk.
- A child agent can be silently re-pointed at the owner's Telegram account or phone. Auth codes go to the wrong phone, and the agent may try to drive the owner's account.
- Two processes poll the same bot token, causing 409 conflicts.
- The child's LLM key or provider is overwritten.

### Proposed fix
- Split `loadConfig` into `readConfigFile()` (no env overrides) and `applyEnvOverrides()`.
- `ManagedAgentService` (and any other load → save path) must use the raw reader.
- When spawning, build the child env from an allowlist, or at least delete the `TELETON_TG_*`, `TELETON_API_KEY`, `TELETON_BASE_URL`, `TELETON_WALLET_KEY`, `TELETON_TAVILY_API_KEY`, `TELETON_TONAPI_KEY` and similar variables before adding the child-specific ones.

### Regression test sketch
Use the repro test, but assert that the child yaml keeps `+15551234567` and does not contain `PARENT-ENV-SECRET`. Mock `spawn` and assert that `env.TELETON_TG_PHONE` and `env.TELETON_API_KEY` are undefined for a personal-mode child.

### Acceptance criteria
Parent env vars never leak into managed-agent config files or child process environments, unless explicitly mapped.

### Verification evidence
`repro-agent-1.test.ts` passed. The printed yaml shows the parent phone and the parent API key.

---

## 3. Pipeline "primary" steps run the agent without toolContext: tool calls are dropped and the step is marked "completed" with an internal-error string

- **Severity:** medium
- **Category:** correctness / reliability (error swallowing)
- **Location:** `src/services/pipeline/executor.ts:318-327`, `src/agent/runtime.ts:1181-1183` and `:1551-1556`

### Problem
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

### How to reproduce
`experiments/audit8/repro-agent-3.test.ts` shows that `processMessage` receives `toolContext === undefined`, and that a run whose agent returns the runtime's internal-error text ends with status `completed` and `context.o = "Internal error..."`. With a real runtime, any action that needs a tool (for example "check wallet balance") produces that string.

### Impact
Pipelines silently can't use any tool. Failures are reported as success, and the garbage output feeds downstream steps.

### Proposed fix
Pass a `toolContext` built the same way as the heartbeat's (bridge, db, admin `senderId`, config). The executor needs these as new deps. If tools aren't meant to be available, call the runtime in a no-tools mode. Separately, the runtime should throw instead of returning the "Internal error" text, so callers see a failure.

### Regression test sketch
Mock the runtime so that the LLM returns a toolCall. Assert that the pipeline step either executes the tool or ends in `failed`, never `completed` with the "Internal error" content.

### Acceptance criteria
Primary pipeline steps can execute permitted tools, and an agent-loop failure marks the step `failed`.

### Verification evidence
`repro-agent-3.test.ts` passed. Code paths are cited above.

---

## 4. The registry's hard 90s tool timeout abandons exec commands that are still running (exec default limit is 120s), so the agent is told the command failed while it keeps running

- **Severity:** medium
- **Category:** reliability / correctness
- **Location:** `src/agent/tools/registry.ts:283-299`, `src/constants/timeouts.ts:26` (`TOOL_EXECUTION_TIMEOUT_MS = 90_000`), `src/config/schema.ts:793` (`exec.limits.timeout ... max(3600).default(120)`)

### Problem
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

### How to reproduce
`experiments/audit8/repro-agent-4.test.ts` uses fake timers. An `exec_run` executor that takes 100s returns `{success:false, error:'Tool "exec_run" timed out after 90s'}` at 90s, and its side effect still completes 10s later.

### Impact
Duplicate side effects, a misleading failure reported to the agent and the user, orphaned processes, and the `exec.limits.timeout` setting being silently capped.

### Proposed fix
Give each tool its own timeout. For exec tools, use `max(TOOL_EXECUTION_TIMEOUT_MS, exec.limits.timeout*1000 + KILL_GRACE_MS)`, or let tools declare a timeout. Pass an `AbortSignal` in `ToolContext` that the exec runner uses to kill the process group on registry timeout. When a tool is abandoned, record it as "timed out (may still be running)".

### Regression test sketch
Register `exec_run` with `exec.limits.timeout=120`. Under fake timers, assert that the registry does not reject at 90s. Separately, assert that a registry timeout aborts the signal and the runner kills the child.

### Acceptance criteria
The configured exec timeout is honored end to end, and no tool keeps running after the registry has reported it as failed.

### Verification evidence
`repro-agent-4.test.ts` passed. The logged error was `Tool "exec_run" timed out after 90s` and `finished` flipped to true afterwards.
