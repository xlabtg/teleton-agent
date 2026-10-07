---
title: "[AUDIT/V8] CI runs untrusted fork-PR code under `pull_request_target` in jobs that hold VERCEL_TOKEN / CODECOV_TOKEN (\"pwn request\")"
labels: ["bug", "audit-finding-v8", "high", "v3.0-blocker", "security"]
milestone: "v3.0 - Production Ready"
audit-source: "#738"
finding-id: "WORK8-006"
severity: "high"
category: "security"
github-issue: "TBD"
---

## Problem Description

The workflow triggers on `pull_request_target` (base-repo context, secrets available) and, for fork PRs only, checks out the attacker's head and runs their scripts:
```yaml
pull_request_target:
  branches: [main]
...
deploy-vercel:
  if: github.event_name == 'pull_request_target' && github.event.pull_request.head.repo.full_name != github.repository
  - uses: actions/checkout@v4
    with:
      ref: ${{ github.event.pull_request.head.sha }}
  - run: cd web && npm ci
  - run: cd web && npm run build
  - uses: amondnet/vercel-action@v25
    with:
      vercel-token: ${{ secrets.VERCEL_TOKEN }}
```
The `test` job does the same with `npm ci` / `npm run test:coverage` followed by `codecov/codecov-action` with `secrets.CODECOV_TOKEN`. The `permissions: contents: read` setting does not apply to repository secrets. The earlier fix (PR #245 / #299, see improvements/work*/AUDIT_WORK_REPORT.md) only added `pull_request` next to it and called it a "permissions gate". That gate covers GITHUB_TOKEN, not secrets.

## Location

- .github/workflows/ci.yml:8, :37-52 (build-runtime), :195-236 (test), :369-410 (deploy-vercel)

## How To Reproduce

Open a PR from a fork whose `web/package.json` has `"build": "env | base64 > /tmp/x; ..."` or whose build writes `NODE_OPTIONS=--require ./steal.js` to `$GITHUB_ENV`. The next step (the Vercel action) runs Node with the attacker's preload and can read `VERCEL_TOKEN` from its inputs.

**Verification evidence:** `grep -n 'pull_request_target\|head.sha\|secrets\.' .github/workflows/ci.yml` shows the trigger at line 8, head checkouts at 39/129/167/207 and secrets at 234/406-410 in the same fork-only jobs.

## Impact

Any GitHub user can exfiltrate the Vercel and Codecov tokens and poison the base-branch `actions/setup-node` npm cache. Approval is required only if the `pr-preview` environment has protection rules, and nothing in the repo enforces that.

## Proposed Fix

Remove `pull_request_target` from ci.yml. Run fork PRs via `pull_request` (no secrets). If preview deploys are needed, use a separate `workflow_run` workflow that deploys only a pre-built artifact and never runs PR code, or require a maintainer-applied label plus a protected environment.

## Regression Test

Add a CI lint step (e.g. `zizmor` or `actionlint` plus a grep) that fails if any workflow has `pull_request_target` together with `ref: ${{ github.event.pull_request.head.* }}`.

## Acceptance Criteria

- [ ] No workflow runs PR-head code in a context where `secrets.*` are available.
- [ ] The zizmor "dangerous-triggers" check is clean.

## Related Artifacts

- Report: `improvements/work8/AUDIT_V8_REPORT.md#work8-006`
- Audit track notes: `experiments/audit8/web-infra.md` (finding 1)
