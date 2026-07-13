#!/usr/bin/env node
// One-shot helper: file each work7 issue template as a GitHub issue on the
// upstream repo, then print "WORK7-NNN <url>" for each. Idempotency is the
// caller's responsibility (run once). Frontmatter is stripped from the body and
// a suggested-labels footer is appended, matching the V6 precedent.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = "xlabtg/teleton-agent";
const issuesDir = new URL("../issues/", import.meta.url).pathname;
const tmp = mkdtempSync(join(tmpdir(), "work7-issues-"));

const files = readdirSync(issuesDir)
  .filter((f) => f.endsWith(".md"))
  .sort();

function parse(file) {
  const raw = readFileSync(join(issuesDir, file), "utf8");
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error(`${file}: no frontmatter`);
  const fm = m[1];
  const body = m[2].trimStart();
  const get = (k) => {
    const r = fm.match(new RegExp(`^${k}:\\s*(.*)$`, "m"));
    return r ? r[1].trim() : "";
  };
  const strip = (s) => s.replace(/^"(.*)"$/, "$1");
  const title = strip(get("title"));
  const labels = get("labels"); // raw JSON-ish array string
  const milestone = strip(get("milestone"));
  const id = strip(get("finding-id"));
  const severity = strip(get("severity"));
  return { title, labels, milestone, id, severity, body };
}

for (const file of files) {
  const { title, labels, milestone, id, severity, body } = parse(file);
  const footer =
    `\n\n---\n\n` +
    `> **Audit source:** #689 · **Prepared in PR:** #690 · **Finding ID:** \`${id}\` (severity: \`${severity}\`)\n` +
    `>\n` +
    `> Suggested labels: \`${labels}\` · Suggested milestone: \`${milestone}\`\n` +
    `>\n` +
    `> _Filed by the automation account, which lacks triage rights on this repo — maintainers please apply the labels/milestone above._\n`;
  const bodyFile = join(tmp, `${id}.md`);
  writeFileSync(bodyFile, body + footer);
  const url = execFileSync(
    "gh",
    ["issue", "create", "--repo", REPO, "--title", title, "--body-file", bodyFile],
    { encoding: "utf8" },
  ).trim();
  console.log(`${id} ${url}`);
}
