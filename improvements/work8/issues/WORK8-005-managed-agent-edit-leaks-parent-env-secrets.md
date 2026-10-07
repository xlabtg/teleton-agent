---
title: "[AUDIT/V8] Managed-agent edits write the parent's environment-variable secrets and identity into the child's config.yaml"
labels: ["bug", "audit-finding-v8", "high", "v3.0-blocker", "security"]
milestone: "v3.0 - Production Ready"
audit-source: "#738"
finding-id: "WORK8-005"
severity: "high"
category: "security"
github-issue: "TBD"
---

## Problem Description

`loadConfig()` mutates the loaded config with the process environment (`TELETON_API_KEY`, `TELETON_TG_PHONE`, `TELETON_TG_API_ID/HASH`, `TELETON_TG_BOT_TOKEN`, `TELETON_BASE_URL`, ...). `ManagedAgentService` loads the child's config through that function in the parent process, then saves it:
```ts
const config = loadConfig(definition.configPath);   // parent env applied here
...
saveConfig(config, definition.configPath);          // and persisted to the child's file
```
So an unrelated edit, such as changing only the description, permanently replaces the child agent's own phone, Telegram API credentials and LLM key with the parent's values. Those values are written in plaintext, even though the operator deliberately kept them out of files by using env vars.

In addition, `startAgent` spawns the child with `...process.env`. A personal-mode child, which gets no bot token of its own, inherits the parent's `TELETON_TG_BOT_TOKEN`, phone and API credentials, and its own `loadConfig` applies them on boot. A `snapshot` or `startAgent` check run in the parent (`hasPersonalSession(config)`, `resolveBotToken`) also sees the parent's values, not the child's.

## Location

- `src/agents/service.ts:810` and `:852` (`updateAgent`), `:1015` and `:1022` (personal auth). The root cause is in `src/config/loader.ts:184-203`, which applies env overrides inside `loadConfig`. Related: `src/agents/service.ts:530`.

## How To Reproduce

`experiments/audit8/repro-agent-1.test.ts`:
1. Create a personal agent with phone `+15551234567`.
2. Set `TELETON_TG_PHONE=+19990000000` and `TELETON_API_KEY=sk-...PARENT-ENV-SECRET`.
3. Call `updateAgent(id,{description:"x"})`.

The child's `config.yaml` now contains `phone: "+19990000000"` and the parent's `api_key`.

**Verification evidence:** `repro-agent-1.test.ts` passed. The printed yaml shows the parent phone and the parent API key.

## Impact

- Env-only secrets end up in plaintext on disk.
- A child agent can be silently re-pointed at the owner's Telegram account or phone. Auth codes go to the wrong phone, and the agent may try to drive the owner's account.
- Two processes poll the same bot token, causing 409 conflicts.
- The child's LLM key or provider is overwritten.

## Proposed Fix

- Split `loadConfig` into `readConfigFile()` (no env overrides) and `applyEnvOverrides()`.
- `ManagedAgentService` (and any other load → save path) must use the raw reader.
- When spawning, build the child env from an allowlist, or at least delete the `TELETON_TG_*`, `TELETON_API_KEY`, `TELETON_BASE_URL`, `TELETON_WALLET_KEY`, `TELETON_TAVILY_API_KEY`, `TELETON_TONAPI_KEY` and similar variables before adding the child-specific ones.

## Regression Test

Use the repro test, but assert that the child yaml keeps `+15551234567` and does not contain `PARENT-ENV-SECRET`. Mock `spawn` and assert that `env.TELETON_TG_PHONE` and `env.TELETON_API_KEY` are undefined for a personal-mode child.

## Acceptance Criteria

- [ ] Parent env vars never leak into managed-agent config files or child process environments, unless explicitly mapped.

## Related Artifacts

- Report: `improvements/work8/AUDIT_V8_REPORT.md#work8-005`
- Audit track notes: `experiments/audit8/agent.md` (finding 2)
- Repro: `experiments/audit8/repro-agent-1.test.ts`
