# V7 Full Logic Audit Work Folder (Issue #689)

This folder contains the V7 audit workspace for
[`#689`](https://github.com/xlabtg/teleton-agent/issues/689) ("Check via
Claude"). It follows the format established by the prior audit folders
(`improvements/work`, `work2`, `work3`, `work4`, `work5`, `work6`): one report,
one reproducible record per confirmed defect, and structural + pattern
validation scripts.

## Scope

The audit fanned out across the whole tree and adversarially verified each
candidate on commit `9d5e5b16` (compared base `main` = `af252b67`, release
0.8.55):

- memory / RAG storage (FTS5 external-content triggers, hybrid vector+keyword
  scoring, message re-embedding, tool-index search)
- autonomous / financial safety (TON policy-engine budgets, wallet tx-lock,
  jetton decimal conversion)
- agent tooling (tool-result truncation, workspace file permissions)
- Telegram bot bridge & message formatting (HTML rendering, long-message split)
- services (HTTP integration providers / SSRF, workflow scheduler dedup,
  managed-agent runtime & inbox)
- WebUI backend (lifecycle SSE lifecycle) and gocoon wallet CLI
- React frontend (Config, Security, Network, Events, Pipelines pages)
- prompt-injection sanitizer

Findings already captured in earlier audits (`#252`–`#296`, `#306`–`#329`,
`#400`–`#404`, `#447`–`#451`, `#523`–`#540`, `#585`–`#592`, `#604`–`#623`) were
treated as a duplicate baseline and are not re-filed.

## Contents

| File                                       | Purpose                                              |
| ------------------------------------------ | ---------------------------------------------------- |
| [AUDIT_V7_REPORT.md](AUDIT_V7_REPORT.md)   | Issue #689 full audit report, finding index & stages |
| [audit-config.yaml](audit-config.yaml)     | Audit metadata, inspected paths, finding policy      |
| [issues/](issues/)                         | One professional issue template per confirmed finding |
| [validation/](validation/)                 | Structural + pattern reproduction checks             |

## Confirmed findings

| ID        | Severity | Category         | Task File                                                                              | GitHub Issue | Status  |
| --------- | -------- | ---------------- | -------------------------------------------------------------------------------------- | ------------ | ------- |
| WORK7-001 | High     | data-integrity   | [WORK7-001](issues/WORK7-001-fts5-delete-triggers-plain-delete.md)                      | [#691](https://github.com/xlabtg/teleton-agent/issues/691)    | Created |
| WORK7-002 | High     | data-integrity   | [WORK7-002](issues/WORK7-002-tool-index-insert-or-replace-rowid-churn.md)               | [#692](https://github.com/xlabtg/teleton-agent/issues/692)    | Created |
| WORK7-003 | High     | financial-safety | [WORK7-003](issues/WORK7-003-policy-engine-daily-ton-budget-never-enforced.md)          | [#693](https://github.com/xlabtg/teleton-agent/issues/693)    | Created |
| WORK7-004 | High     | financial-safety | [WORK7-004](issues/WORK7-004-tx-lock-releases-mutex-on-timeout.md)                      | [#694](https://github.com/xlabtg/teleton-agent/issues/694)    | Created |
| WORK7-005 | High     | reliability      | [WORK7-005](issues/WORK7-005-markdown-placeholder-dollar-replacement-corruption.md)     | [#695](https://github.com/xlabtg/teleton-agent/issues/695)    | Created |
| WORK7-006 | Medium   | security         | [WORK7-006](issues/WORK7-006-integration-provider-read-ssrf.md)                         | [#696](https://github.com/xlabtg/teleton-agent/issues/696)    | Created |
| WORK7-007 | Medium   | data-integrity   | [WORK7-007](issues/WORK7-007-hybrid-search-vector-only-score-unweighted.md)             | [#697](https://github.com/xlabtg/teleton-agent/issues/697)    | Created |
| WORK7-008 | Medium   | data-integrity   | [WORK7-008](issues/WORK7-008-stale-message-vector-on-failed-reembed.md)                 | [#698](https://github.com/xlabtg/teleton-agent/issues/698)    | Created |
| WORK7-009 | Medium   | reliability      | [WORK7-009](issues/WORK7-009-tool-result-truncator-cap-not-guaranteed.md)               | [#699](https://github.com/xlabtg/teleton-agent/issues/699)    | Created |
| WORK7-010 | Medium   | financial-safety | [WORK7-010](issues/WORK7-010-jetton-send-zero-decimals.md)                              | [#700](https://github.com/xlabtg/teleton-agent/issues/700)    | Created |
| WORK7-011 | Medium   | reliability      | [WORK7-011](issues/WORK7-011-workflow-event-webhook-bypass-dedup.md)                    | [#701](https://github.com/xlabtg/teleton-agent/issues/701)    | Created |
| WORK7-012 | Medium   | reliability      | [WORK7-012](issues/WORK7-012-managed-agent-inbox-unbounded.md)                          | [#702](https://github.com/xlabtg/teleton-agent/issues/702)    | Created |
| WORK7-013 | Medium   | reliability      | [WORK7-013](issues/WORK7-013-managed-agent-restart-count-never-reset.md)                | [#703](https://github.com/xlabtg/teleton-agent/issues/703)    | Created |
| WORK7-014 | Medium   | reliability      | [WORK7-014](issues/WORK7-014-lifecycle-sse-listener-leak.md)                            | [#704](https://github.com/xlabtg/teleton-agent/issues/704)    | Created |
| WORK7-015 | Medium   | security         | [WORK7-015](issues/WORK7-015-workspace-write-world-readable-files.md)                   | [#705](https://github.com/xlabtg/teleton-agent/issues/705)    | Created |
| WORK7-016 | Medium   | reliability      | [WORK7-016](issues/WORK7-016-config-save-clobbers-unsaved-edits.md)                     | [#706](https://github.com/xlabtg/teleton-agent/issues/706)    | Created |
| WORK7-017 | Medium   | reliability      | [WORK7-017](issues/WORK7-017-security-approval-params-json-parse-render-crash.md)       | [#707](https://github.com/xlabtg/teleton-agent/issues/707)    | Created |
| WORK7-018 | Medium   | reliability      | [WORK7-018](issues/WORK7-018-bot-bridge-splits-html-mid-tag.md)                         | [#708](https://github.com/xlabtg/teleton-agent/issues/708)    | Created |
| WORK7-019 | Low      | reliability      | [WORK7-019](issues/WORK7-019-ui-mutations-swallow-promise-rejections.md)                | [#709](https://github.com/xlabtg/teleton-agent/issues/709)    | Created |
| WORK7-020 | Low      | reliability      | [WORK7-020](issues/WORK7-020-pipelines-poll-resets-selected-run.md)                     | [#710](https://github.com/xlabtg/teleton-agent/issues/710)    | Created |
| WORK7-021 | Low      | reliability      | [WORK7-021](issues/WORK7-021-strip-markup-tags-over-consumes-text.md)                   | [#711](https://github.com/xlabtg/teleton-agent/issues/711)    | Created |
| WORK7-022 | Medium   | security         | [WORK7-022](issues/WORK7-022-gocoon-data-dir-not-0700.md)                               | [#712](https://github.com/xlabtg/teleton-agent/issues/712)    | Created |

The issue body frontmatter and footer contain the requested labels and milestone
metadata. The automation account used for creation has no triage rights on the
upstream repository, so **maintainers still need to apply the labels, milestone,
and assignment** in GitHub — each issue lists its suggested labels/milestone for
convenience. The `GitHub Issue` column and each file's `github-issue` frontmatter
field are updated with the issue URL once filed.

## Validation

```bash
# Structural check: report references every ID, every issue file has the
# required frontmatter fields and section headings.
node improvements/work7/validation/check-artifacts.mjs

# Reproduction check: asserts the audited code patterns still exist on this
# commit (exits non-zero while the findings remain present).
node improvements/work7/validation/reproduce-findings.mjs

# Filing helper (run once, requires gh auth):
node improvements/work7/validation/file-issues.mjs
```

## Finding format

Each issue file uses the established structure: YAML frontmatter (`title`,
`labels`, `milestone`, `audit-source`, `finding-id`, `severity`, `category`,
`github-issue`) followed by `Problem Description`, `Location`,
`How To Reproduce`, `Impact`, `Proposed Fix`, `Regression Test`,
`Acceptance Criteria`, and `Related Artifacts`.
