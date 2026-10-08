import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import YAML from "yaml";
const read = (path: string) => readFileSync(path, "utf8");
describe("deployment safeguards (#745, #751, #752, #766)", () => {
  it("does not execute PR head with privileged target triggers", () => {
    for (const file of readdirSync(".github/workflows")) {
      if (!/\.ya?ml$/.test(file)) continue;
      const workflow = YAML.parse(read(`.github/workflows/${file}`));
      expect(workflow.on?.pull_request_target, file).toBeUndefined();
      expect(workflow.on?.workflow_run, file).toBeUndefined();
    }
    const ci = YAML.parse(read(".github/workflows/ci.yml"));
    expect(ci.jobs["deploy-vercel"].if).toContain("refs/heads/main");
    expect(ci.jobs["deploy-vercel"].if).toContain("'push'");
    const codecov = ci.jobs.test.steps.find(
      (step: { name: string }) => step.name === "Upload coverage to Codecov"
    );
    expect(codecov.with.token).toBeUndefined();
  });
  it("binds published WebUI port to loopback by default", () => {
    const compose = read("compose.yaml");
    expect(compose).toContain("${TELETON_WEBUI_BIND:-127.0.0.1}:${TELETON_WEBUI_PORT:-7777}:7777");
  });
  it("uses this repository for installation and package metadata", () => {
    expect(read("install.sh")).toContain("xlabtg/teleton-agent");
    for (const file of [
      "install.sh",
      "package.json",
      "packages/sdk/package.json",
      "GETTING_STARTED.md",
      "docs/deployment.md",
      "docs/user-guide/en/01-quick-start.md",
      "docs/user-guide/ru/01-quick-start.md",
      "docs-sdk/pages/installation.html",
      "docs-sdk/pages/deploy-docker.html",
      "src/cli/prompts.ts",
    ]) {
      expect(read(file)).not.toContain("TONresistor/teleton-agent");
      expect(read(file)).not.toContain("ghcr.io/tonresistor/teleton");
    }
  });
  it("excludes solver scratch files from repository and image context", () => {
    const files = [
      "APPLY_LOG.txt",
      "DUMP.txt",
      "CR_SNAPSHOT.txt",
      "STATE2.txt",
      "VERIFY_STATE.txt",
      "COMMIT_RESULT.txt",
      "REPORT.txt",
      "PIPELINE.status",
      "PR_BODY.md",
      "commit_and_push.sh",
      "run_pipeline.sh",
      "report.sh",
      "apply_a11y.py",
    ];
    for (const file of files) {
      expect(existsSync(file), file).toBe(false);
      expect(read(".gitignore")).toContain(file);
      expect(read(".dockerignore")).toContain(file);
    }
  });
});
