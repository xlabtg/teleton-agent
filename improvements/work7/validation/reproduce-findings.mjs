#!/usr/bin/env node
// Reproduction check for the V7 audit (issue #689).
// Each check asserts that the audited code pattern is still present on the
// current commit. While a finding remains reproducible the script exits
// non-zero, so it doubles as a regression guard once the fixes land.
import { readFileSync } from "node:fs";

function read(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

const f = {
  schema: read("src/memory/schema.ts"),
  toolIndex: read("src/agent/tools/tool-index.ts"),
  policy: read("src/autonomous/policy-engine.ts"),
  txLock: read("src/ton/tx-lock.ts"),
  formatting: read("src/telegram/formatting.ts"),
  providers: read("src/services/integrations/providers.ts"),
  hybrid: read("src/memory/search/hybrid.ts"),
  feedMessages: read("src/memory/feed/messages.ts"),
  truncator: read("src/agent/tool-result-truncator.ts"),
  jettonSend: read("src/agent/tools/ton/jetton-send.ts"),
  scheduler: read("src/services/workflow-scheduler.ts"),
  agentsService: read("src/agents/service.ts"),
  lifecycleSse: read("src/webui/lifecycle-sse.ts"),
  workspaceWrite: read("src/agent/tools/workspace/write.ts"),
  validator: read("src/workspace/validator.ts"),
  configState: read("web/src/hooks/useConfigState.ts"),
  security: read("web/src/pages/Security.tsx"),
  bot: read("src/telegram/bridges/bot.ts"),
  network: read("web/src/pages/Network.tsx"),
  events: read("web/src/pages/Events.tsx"),
  pipelines: read("web/src/pages/Pipelines.tsx"),
  sanitize: read("src/utils/sanitize.ts"),
  gocoonCli: read("src/gocoon/cli.ts"),
};

const checks = [
  {
    id: "WORK7-001",
    description: "knowledge_fts / tool_index_fts delete+update triggers use a plain DELETE on an external-content table",
    present:
      f.schema.includes("content='knowledge'") &&
      f.schema.includes("DELETE FROM knowledge_fts WHERE rowid = old.rowid") &&
      f.schema.includes("content='tool_index'") &&
      f.schema.includes("DELETE FROM tool_index_fts WHERE rowid = old.rowid"),
  },
  {
    id: "WORK7-002",
    description: "tool_index upsert uses INSERT OR REPLACE against a TEXT PRIMARY KEY external-content FTS index",
    present:
      f.toolIndex.includes("INSERT OR REPLACE INTO tool_index") &&
      f.schema.includes("name TEXT PRIMARY KEY") &&
      f.schema.includes("content='tool_index'"),
  },
  {
    id: "WORK7-003",
    description: "autonomous policy engine declares a daily TON budget but only enforces perTask",
    present:
      f.policy.includes("daily: 0.5") &&
      f.policy.includes("constraints.budgetTON ?? this.config.tonSpending.perTask") &&
      !f.policy.includes("tonSpending.daily"),
  },
  {
    id: "WORK7-004",
    description: "withTxLock releases the mutex on Promise.race timeout while fn() may still be in-flight",
    present:
      f.txLock.includes("TX_LOCK_TIMEOUT_MS = 60_000") &&
      f.txLock.includes("Promise.race([fn(), timeoutPromise])") &&
      f.txLock.includes("pending = execute.then("),
  },
  {
    id: "WORK7-005",
    description: "markdownToTelegramHtml injects user content via String.replace (unescaped $ replacement patterns)",
    present:
      f.formatting.includes("html.replace(`\\x00BLOCKQUOTE") &&
      f.formatting.includes("html.replace(`\\x00INLINECODE") &&
      !f.formatting.includes("replace(/\\$/g"),
  },
  {
    id: "WORK7-006",
    description: "integration provider fetches caller-controlled URLs with no private-IP/SSRF guard",
    present:
      f.providers.includes("this.resolveUrl(actionConfig, params)") &&
      f.providers.includes("this.fetchWithTimeout(") &&
      !f.providers.includes("isPrivate") &&
      !f.providers.includes("assertPublic"),
  },
  {
    id: "WORK7-007",
    description: "hybrid merge keeps vector-only results unweighted while keyword-only results are weighted",
    present:
      f.hybrid.includes("byId.set(r.id, { ...r, vectorScore: r.score });") &&
      f.hybrid.includes("byId.set(r.id, { ...r, score: keywordWeight * (r.keywordScore ?? 0) });"),
  },
  {
    id: "WORK7-008",
    description: "message upsert only replaces tg_messages_vec when a non-empty embedding is present",
    present:
      f.feedMessages.includes("if (this.vectorEnabled && embedding.length > 0 && message.text)") &&
      f.feedMessages.includes("DELETE FROM tg_messages_vec WHERE id = ?"),
  },
  {
    id: "WORK7-009",
    description: "truncateToolResult summarizes field-by-field with no final maxSize guarantee",
    present:
      f.truncator.includes("if (resultText.length <= maxSize) return resultText;") &&
      f.truncator.includes('typeof value === "string" && value.length > 500'),
  },
  {
    id: "WORK7-010",
    description: "jetton_send derives decimals with `|| 9`, mishandling 0-decimal jettons",
    present: f.jettonSend.includes("jettonBalance.jetton.decimals || 9"),
  },
  {
    id: "WORK7-011",
    description: "event/webhook triggers call execute() without the runningWorkflowIds guard the cron path enforces",
    present:
      f.scheduler.includes("async fireEvent(") &&
      f.scheduler.includes("async handleWebhook(") &&
      f.scheduler.includes("this.runningWorkflowIds.add(workflowId);") &&
      f.scheduler.includes("if (this.runningWorkflowIds.has(wf.id)) {"),
  },
  {
    id: "WORK7-012",
    description: "managed-agent inbox/results stored as whole-file JSON arrays rewritten per message",
    present:
      f.agentsService.includes('"messages", "inbox.json"') &&
      f.agentsService.includes('"messages", "results.json"'),
  },
  {
    id: "WORK7-013",
    description: "restartCount is incremented and drives health but is never reset after recovery",
    present:
      f.agentsService.includes("record.restartCount += 1;") &&
      f.agentsService.includes('record.restartCount > 0 ? "degraded" : "healthy"'),
  },
  {
    id: "WORK7-014",
    description: "lifecycle SSE detaches its stateChange listener only after the heartbeat loop (no try/finally)",
    present:
      f.lifecycleSse.includes('lifecycle.on("stateChange", onStateChange);') &&
      f.lifecycleSse.includes('lifecycle.off("stateChange", onStateChange);') &&
      !f.lifecycleSse.includes("finally"),
  },
  {
    id: "WORK7-015",
    description: "workspace write paths create files 0o666 while the append path uses 0o600",
    present:
      f.workspaceWrite.includes("openSync(validated.absolutePath, flags, 0o666)") &&
      f.workspaceWrite.includes("{ mode: 0o600 }") &&
      f.validator.includes("openSync(validatedAbsolutePath, flags, 0o666)"),
  },
  {
    id: "WORK7-016",
    description: "saveConfig calls loadData(), which overwrites the whole localInputs map",
    present:
      f.configState.includes("setLocalInputs(inputs);") &&
      f.configState.includes("await loadData();"),
  },
  {
    id: "WORK7-017",
    description: "Security page calls JSON.parse(approval.params) inline during render",
    present: f.security.includes("compactJson(JSON.parse(approval.params))"),
  },
  {
    id: "WORK7-018",
    description: "bot bridge splits rendered HTML on whitespace boundaries (no tag/entity awareness)",
    present:
      f.bot.includes("private async sendLongMessage(") &&
      f.bot.includes('remaining.lastIndexOf(" ", TELEGRAM_MAX_MESSAGE_LENGTH)') &&
      f.bot.includes(".slice(0, TELEGRAM_MAX_MESSAGE_LENGTH)"),
  },
  {
    id: "WORK7-019",
    description: "Network/Events mutations fire via void/.then with no catch",
    present:
      f.network.includes("void updateTrust(") &&
      f.network.includes("void toggleBlocked(") &&
      f.events.includes(".then((result) => setEvents(result.data.events))"),
  },
  {
    id: "WORK7-020",
    description: "Pipelines loadRuns always selects the newest run and is re-invoked by the 2s poll",
    present:
      f.pipelines.includes("await loadRunDetail(pipelineId, next[0].id);") &&
      f.pipelines.includes("window.setInterval(() => void loadRuns(selected.id), 2_000)"),
  },
  {
    id: "WORK7-021",
    description: "stripMarkupTags greedily swallows fragments after a tag via isTagNameFragment loop",
    present:
      f.sanitize.includes("isTagNameFragment(text.slice(next, fragmentEnd))") &&
      f.sanitize.includes("i = end;"),
  },
  {
    id: "WORK7-022",
    description: "gocoon data dir (holds wallet.json) is created without 0o700",
    present:
      f.gocoonCli.includes("mkdirSync(gocoonDataDir(), { recursive: true });") &&
      !f.gocoonCli.includes("mode: 0o700"),
  },
];

const present = checks.filter((check) => check.present);

for (const check of checks) {
  const status = check.present ? "PRESENT" : "not detected";
  console.log(`${check.id}: ${status} - ${check.description}`);
}

if (present.length > 0) {
  console.error(`\n${present.length}/${checks.length} audit finding(s) are still reproducible.`);
  process.exit(1);
}

console.log("\nNo tracked audit findings detected.");
