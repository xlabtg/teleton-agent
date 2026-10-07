---
title: "[AUDIT/V8] install.sh installs the upstream TONresistor repo/image instead of this fork, and refuses fork clones"
labels: ["bug", "audit-finding-v8", "medium", "v3.x", "supply-chain"]
milestone: "v3.0 - Production Ready"
audit-source: "#738"
finding-id: "WORK8-013"
severity: "medium"
category: "supply-chain"
github-issue: "TBD"
---

## Problem Description

```sh
REPO="tonresistor/teleton-agent"
DOCKER_IMAGE="ghcr.io/${REPO}:latest"
...
local expected_url="https://github.com/${REPO}.git"
if [ "${actual_url}" != "${expected_url}" ]; then error "...unexpected origin..."
```
README.md:131/146 and compose.yaml:12 tell users to use `xlabtg/teleton-agent` and `ghcr.io/xlabtg/teleton-agent`, and release.yml pushes images to the current repo's ghcr. The installer still clones upstream and pulls the upstream image. The `repository`, `bugs` and `homepage` fields in both package.json files also point to TONresistor.

## Location

- install.sh:6, :9-10, :101-106
- package.json:19-26
- packages/sdk/package.json:36-38

## How To Reproduce

Run `bash install.sh` and choose git mode. It clones TONresistor, so none of the fork's security fixes are included. If `~/.teleton-app` was cloned from `https://github.com/xlabtg/teleton-agent.git` as README.md:146 says, the installer aborts with "unexpected origin".

**Verification evidence:** `grep -n REPO= install.sh` returns `tonresistor/teleton-agent`. `git remote -v` returns xlabtg.

## Impact

Users silently get different code (without the fork's fixes) from what the docs and release pipeline describe. Fork users cannot update through the installer. Bug reports go to the wrong tracker.

## Proposed Fix

Set `REPO="xlabtg/teleton-agent"`, update the usage URL and the package.json `repository`/`bugs`/`homepage` fields (root and SDK), or derive them from one source.

## Regression Test

Add a test or CI grep that fails if `install.sh` or `package.json` mention `tonresistor/teleton-agent` (case-insensitive), except the "upstream" credit in README.

## Acceptance Criteria

- [ ] The installer's clone URL, docker image, and package metadata all name `xlabtg/teleton-agent`.
- [ ] An existing xlabtg clone updates without error.

## Related Artifacts

- Report: `improvements/work8/AUDIT_V8_REPORT.md#work8-013`
- Audit track notes: `experiments/audit8/web-infra.md` (finding 2)
