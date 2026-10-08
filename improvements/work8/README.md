# V8 Full Logic Audit Work Folder (Issue #738)

This folder contains the V8 audit workspace for
[`#738`](https://github.com/xlabtg/teleton-agent/issues/738) ("Check via
Claude"). It follows the format established by the prior audit folders
(`improvements/work` … `work7`): one report, one reproducible record per
confirmed defect, and structural validation scripts.

## Scope

The audit fanned out across the whole tree on `main` = `fd9ac870`
(release 0.8.56 + NVIDIA model-catalog update) in six parallel tracks:

- TON / autonomous mode / financial safety (`src/ton`, `src/autonomous`, `src/deals`, `src/gocoon`)
- WebUI backend, management API, webhooks, audit trail (`src/webui`, `src/api`, `src/services/webhook-dispatcher.ts`)
- memory / session / backup / workspace / config (`src/memory`, `src/session`, `src/config`, …)
- agent runtime, tools, plugins, providers, managed agents, pipelines (`src/agent`, `src/agents`, `src/providers`, `src/sdk`)
- Telegram bridges, handlers, services, CLI (`src/telegram`, `src/services`, `src/cli`, `src/index.ts`)
- React frontend, SDK package, Docker/Helm/install script, CI, repository hygiene

Every candidate was adversarially re-checked against the source before being
accepted. Findings of earlier waves (`work`…`work7`, all `[AUDIT…]` issues up to
#712) were used as a duplicate baseline and are not re-filed.

## Contents

| File                                     | Purpose                                               |
| ---------------------------------------- | ----------------------------------------------------- |
| [AUDIT_V8_REPORT.md](AUDIT_V8_REPORT.md) | Issue #738 full audit report, finding index & stages  |
| [issues/](issues/)                       | One professional issue template per confirmed finding |
| [validation/](validation/)               | Structural check and issue-filing helper              |

## Validation

```bash
node improvements/work8/validation/check-artifacts.mjs
```
