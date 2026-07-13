---
title: "[AUDIT/V7] Network/Events UI mutations are fired via void/.then with no catch, silently swallowing failures"
labels: ["bug", "audit-finding-v7", "low", "reliability"]
milestone: "v3.0 - Production Ready"
audit-source: "#689"
finding-id: "WORK7-019"
severity: "low"
category: "reliability"
github-issue: "https://github.com/xlabtg/teleton-agent/issues/709"
---

## Problem Description

Several UI mutation handlers perform an API call and reload, but have **no error
handling**, and are invoked with `void`/`.then` so a rejection is swallowed with no
feedback:

```ts
// web/src/pages/Network.tsx:329-342 — no try/catch
const updateTrust = async (agent, trustLevel) => {
  await api.updateNetworkAgentTrust(agent.id, { trustLevel });
  await load();
};
const toggleBlocked = async (agent) => { await api.updateNetworkAgentTrust(...); await load(); };
const removeAgent  = async (agent) => { await api.removeNetworkAgent(agent.id); await load(); };
```

```tsx
// invoked as fire-and-forget — rejection is discarded
onChange={(e) => void updateTrust(agent, e.target.value as NetworkTrustLevel)}
onClick={() => void toggleBlocked(agent)}
onClick={() => void removeAgent(agent)}
```

```tsx
// web/src/pages/Events.tsx:420-423 — .then with no .catch
onClick={() => {
  setFilterType(type);
  api.eventsList({ type, limit: 100 }).then((result) => setEvents(result.data.events));
}}
```

Unlike the sibling handlers on these pages (which wrap calls in `try/catch` and
`setError`), these paths give the operator **no indication** when the mutation fails —
the trust change / block / removal / filter simply does nothing, and the UI keeps
showing stale state.

## Location

- `web/src/pages/Network.tsx:329-342` — `updateTrust` / `toggleBlocked` /
  `removeAgent` with no error handling; invoked via `void` at lines 623/634/638.
- `web/src/pages/Events.tsx:420-423` — event-type filter `.then` with no `.catch`.

## How To Reproduce

1. With the API returning an error (e.g. offline / 500), change an agent's trust
   level or click Block/Remove on the Network page.
2. Nothing happens and no error is shown; the row keeps its old state.

## Impact

Silent failure of safety-relevant controls (trust level, block, remove). The operator
believes an action succeeded when it did not, and unhandled rejections surface only in
the console.

## Proposed Fix

Wrap each mutation in `try/catch` and surface failures via the existing `setError`
banner (mirroring the other handlers on the same page); add `.catch` to the Events
filter `.then`.

## Regression Test

```typescript
it("surfaces an error when updateTrust fails", async () => {
  api.updateNetworkAgentTrust.mockRejectedValue(new Error("boom"));
  await fireEvent.change(trustSelect, "trusted");
  expect(await screen.findByText(/boom/)).toBeInTheDocument();
});
```

## Acceptance Criteria

- [ ] Failed mutations show an error to the operator.
- [ ] No unhandled promise rejections from these handlers.

## Related Artifacts

- Report: `improvements/work7/AUDIT_V7_REPORT.md#work7-019`
- Modules: `web/src/pages/Network.tsx`, `web/src/pages/Events.tsx`
