---
title: "[AUDIT/V8] Marketplace `updatePlugin` uninstalls before installing; a failed download deletes the plugin"
labels: ["bug", "audit-finding-v8", "medium", "v3.x", "reliability"]
milestone: "v3.0 - Production Ready"
audit-source: "#738"
finding-id: "WORK8-017"
severity: "medium"
category: "reliability"
github-issue: "TBD"
---

## Problem Description

```ts
async updatePlugin(pluginId: string) {
  await this.uninstallPlugin(pluginId);
  return this.installPlugin(pluginId);
}
```
`uninstallPlugin` removes the plugin directory with `rmSync` and unregisters its tools. If `installPlugin` then fails (GitHub rate limit, network error, bad manifest, or a registry entry removed), nothing restores the plugin. Its tools disappear until someone manually reinstalls it.

## Location

- src/webui/services/marketplace.ts:577-582

## How To Reproduce

Install a plugin, then make `fetch` reject (or return 403) and call `POST /api/marketplace/update`. The request returns an error, the plugin directory is gone, and its tools are no longer registered.

**Verification evidence:** Confirmed by reading the source (lines 577-582). `uninstallPlugin` performs the `rmSync` of the plugin directory before `installPlugin` performs any network I/O.

## Impact

A transient network error during a routine update permanently removes a working plugin, along with any local state in its directory.

## Proposed Fix

Download and validate into a temporary directory first. Only after that succeeds, move the old directory to a backup, swap in the new one, and re-register. On any failure, restore the backup and re-register the old module.

## Regression Test

```ts
await svc.installPlugin("demo");
fetchMock.mockRejectedValue(new Error("network"));
await expect(svc.updatePlugin("demo")).rejects.toThrow();
expect(existsSync(join(PLUGINS_DIR, "demo"))).toBe(true);
expect(registry.getToolNames()).toContain("demo_tool");
```

## Acceptance Criteria

- [ ] A failed update leaves the previously installed version on disk and registered.
- [ ] A successful update replaces it atomically.

## Related Artifacts

- Report: `improvements/work8/AUDIT_V8_REPORT.md#work8-017`
- Audit track notes: `experiments/audit8/webui.md` (finding 5)
