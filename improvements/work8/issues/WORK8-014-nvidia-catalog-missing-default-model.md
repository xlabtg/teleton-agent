---
title: "[AUDIT/V8] NVIDIA model catalog no longer contains the provider's default model `z-ai/glm-5.1` (catalog/default/test drift after fd9ac870)"
labels: ["bug", "audit-finding-v8", "medium", "v3.x", "correctness"]
milestone: "v3.0 - Production Ready"
audit-source: "#738"
finding-id: "WORK8-014"
severity: "medium"
category: "correctness"
github-issue: "TBD"
---

## Problem Description

Commit fd9ac870 replaced the NVIDIA entries with `z-ai/glm-5-3`, `z-ai/glm-5-3-flash`, `deepseek-ai/deepseek-v4.1-flash`, `moonshotai/kimi-k3` and removed every other model, including the provider default:

```ts
// providers.ts
defaultModel: "z-ai/glm-5.1",
utilityModel: "z-ai/glm-5.1",
```

- The default (`z-ai/glm-5.1`) is no longer an option in the dropdown. Onboarding (`src/cli/commands/onboard.ts:498`) calls `select({ default: providerMeta.defaultModel, choices })` with a default that is not in the choices. The WebUI setup and config model lists (`/models/:provider`) leave out the model the agent actually runs on.
- All the GLM-specific workarounds use the exact string `z-ai/glm-5.1`: `NVIDIA_DISABLE_STREAMING_USAGE_MODELS` and `isNvidiaGlmEmptyStreamResponse` (runtime-utils.ts:155). The new GLM catalog entries (`z-ai/glm-5-3*`) therefore do not get the `supportsUsageInStreaming:false` compat flag or the empty-stream recovery that were added in #562/#627/#634/#677.
- The new ids use a hyphen (`glm-5-3`). NVIDIA NIM ids use dots (`z-ai/glm-5.1`, `deepseek-v3.1-terminus`, `kimi-k2.6`), so `glm-5-3` / `glm-5-3-flash` look malformed. The display name "DeepSeek v4.1 Flesh" also has a typo.
- `nvidia-provider.test.ts` still asserts on removed values (`z-ai/glm-5.1`, `qwen/qwen3-coder-480b-a35b-instruct`, `mistralai/mistral-small-4-119b-2603`, `deepseek-ai/deepseek-v3.1-terminus`, `moonshotai/kimi-k2.6`, `stepfun-ai/step-3.5-flash`), so the suite is red on main.

## Location

- src/config/model-catalog.ts:491-512
- src/config/providers.ts:196-197
- src/providers/model-resolver.ts:82
- src/agent/runtime-utils.ts:154-179
- src/providers/__tests__/nvidia-provider.test.ts:21,56,78-83

## How To Reproduce

`npx vitest run src/providers/__tests__/nvidia-provider.test.ts`. The "contains chat completion models" test fails on `toContain("z-ai/glm-5.1")`. Or run `teleton setup`, choose NVIDIA and see that the default model is not listed.

**Verification evidence:** `git show fd9ac870`; grep shows `z-ai/glm-5.1` only in providers.ts, model-resolver.ts, runtime-utils.ts and tests, and no longer in model-catalog.ts. I could not run the tests because node_modules is not installed in the checkout.

## Impact

New users get a catalog that does not match the runtime default. Users who pick a new GLM entry lose the GLM streaming fixes and may hit an invalid model id at NVIDIA (a 404 or an empty stream). CI is red.

## Proposed Fix

Restore `z-ai/glm-5.1` to the catalog, or move `defaultModel`/`utilityModel` to a verified, catalog-listed id. Check the new ids against `https://integrate.api.nvidia.com/v1/models` (dot notation). Turn the GLM matching into a prefix/regex such as `/^z-ai\/glm-5/`, used by both model-resolver and runtime-utils. Update the test assertions. Fix the "Flesh" typo.

## Regression Test

For every provider in `PROVIDER_REGISTRY` that has a catalog, assert that `getModelsForProvider(p).map(m=>m.value)` contains `meta.defaultModel` and `meta.utilityModel`. Assert that every NVIDIA GLM catalog entry yields `compat.supportsUsageInStreaming === false`.

## Acceptance Criteria

- [ ] The default and utility models appear in the catalog for every provider.
- [ ] The GLM workarounds apply to every GLM entry in the catalog.
- [ ] The NVIDIA provider tests pass.

## Related Artifacts

- Report: `improvements/work8/AUDIT_V8_REPORT.md#work8-014`
- Audit track notes: `experiments/audit8/memory.md` (finding 1)
