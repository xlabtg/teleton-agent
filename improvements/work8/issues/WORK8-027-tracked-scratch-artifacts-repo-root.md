---
title: "[AUDIT/V8] Tracked scratch/automation artefacts in repo root leak bot paths and include a destructive auto-commit/push script"
labels: ["bug", "audit-finding-v8", "low", "v3.x", "repo-hygiene"]
milestone: "v3.0 - Production Ready"
audit-source: "#738"
finding-id: "WORK8-027"
severity: "low"
category: "repo-hygiene"
github-issue: "https://github.com/xlabtg/teleton-agent/issues/766"
---

## Problem Description

All of these are tracked (`git ls-files`); they were added by commit 55ce5a4d "Auto-commit before critical-error recovery". The scripts hard-code the solver's working directory and do git writes:
```sh
cd /tmp/gh-issue-solver-1780101166480
rm -f apply_a11y.py run_pipeline.sh DUMP.txt ...
rm -rf web/test-results web/a11y-report
git merge origin/main --no-edit
git push origin issue-499-aa140238a8b8
```
No secrets were found. They are not in the npm tarball (`files`: dist/, bin/, src/templates/) or the image (Dockerfile COPYs specific paths). They are, however, sent in the Docker build context because `.dockerignore` does not exclude them.

## Location

- APPLY_LOG.txt, DUMP.txt, CR_SNAPSHOT.txt, STATE2.txt, VERIFY_STATE.txt, COMMIT_RESULT.txt, REPORT.txt, PIPELINE.status, PR_BODY.md, commit_and_push.sh:5,27-73, run_pipeline.sh:5, report.sh:3, apply_a11y.py:11

## How To Reproduce

`git ls-files | grep -E '^(APPLY_LOG|DUMP|CR_SNAPSHOT|STATE2|VERIFY_STATE)\.txt|commit_and_push.sh'`. Running `sh commit_and_push.sh` on a machine where that /tmp path exists would rm files, commit, merge and push to a stale branch.

**Verification evidence:** The `git ls-files` output includes all the listed files. `grep` found `/tmp/gh-issue-solver-1780101166480` in 4 tracked scripts.

## Impact

Repo clutter, leaked internal tooling paths and branch names, and a footgun script that can push.

## Proposed Fix

`git rm` these files. Add a `.gitignore` rule (e.g. `/*.txt` except allowed ones, `PIPELINE.status`, `/commit_and_push.sh`, `/run_pipeline.sh`, `/report.sh`, `/apply_a11y.py`) and matching `.dockerignore` entries.

## Regression Test

Add a CI step that fails if `git ls-files` matches a root-level denylist (`*_LOG.txt`, `DUMP.txt`, `STATE*.txt`, `*.status`, `/tmp/gh-issue-solver` string in tracked files).

## Acceptance Criteria

- [ ] None of the listed files are tracked.
- [ ] `grep -rn gh-issue-solver $(git ls-files)` returns nothing outside experiments/.

## Related Artifacts

- Report: `improvements/work8/AUDIT_V8_REPORT.md#work8-027`
- Audit track notes: `experiments/audit8/web-infra.md` (finding 3)
