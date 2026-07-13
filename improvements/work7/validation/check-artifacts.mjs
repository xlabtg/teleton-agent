#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const reportPath = join(root, "AUDIT_V7_REPORT.md");
const issuesDir = join(root, "issues");

const requiredIssueFields = [
  "title",
  "labels",
  "milestone",
  "audit-source",
  "finding-id",
  "severity",
  "category",
  "github-issue",
];

const requiredHeadings = [
  "## Problem Description",
  "## Location",
  "## How To Reproduce",
  "## Impact",
  "## Proposed Fix",
  "## Regression Test",
  "## Acceptance Criteria",
  "## Related Artifacts",
];

// The 22 confirmed findings filed as issue templates.
const findingIds = Array.from({ length: 22 }, (_, i) => `WORK7-${String(i + 1).padStart(3, "0")}`);

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

if (!existsSync(reportPath)) {
  fail(`Missing report: ${reportPath}`);
} else {
  const report = readFileSync(reportPath, "utf8");
  for (const id of findingIds) {
    if (!report.includes(id)) fail(`Report does not reference ${id}`);
  }
}

if (!existsSync(issuesDir)) {
  fail(`Missing issues directory: ${issuesDir}`);
} else {
  const files = readdirSync(issuesDir)
    .filter((file) => file.endsWith(".md"))
    .sort();
  if (files.length !== findingIds.length) {
    fail(`Expected ${findingIds.length} issue files, found ${files.length}`);
  }

  const seenIds = new Set();
  for (const file of files) {
    const body = readFileSync(join(issuesDir, file), "utf8");
    const frontmatter = body.match(/^---\n([\s\S]*?)\n---/);
    if (!frontmatter) {
      fail(`${file}: missing YAML frontmatter`);
      continue;
    }
    for (const field of requiredIssueFields) {
      if (!new RegExp(`^${field}:`, "m").test(frontmatter[1])) {
        fail(`${file}: missing frontmatter field ${field}`);
      }
    }
    for (const heading of requiredHeadings) {
      if (!body.includes(heading)) fail(`${file}: missing ${heading}`);
    }
    const idMatch = frontmatter[1].match(/^finding-id:\s*"?(WORK7-\d{3})"?/m);
    if (idMatch) seenIds.add(idMatch[1]);
  }

  for (const id of findingIds) {
    if (!seenIds.has(id)) fail(`No issue file declares finding-id ${id}`);
  }
}

if (process.exitCode) {
  process.exit();
}

console.log("work7 audit artifacts are structurally valid");
