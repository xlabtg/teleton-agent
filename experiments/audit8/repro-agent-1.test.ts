import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ManagedAgentService } from "../../src/agents/service.js";

const PRIMARY_CONFIG = `
agent:
  api_key: sk-ant-api03-test123
  provider: anthropic
telegram:
  api_id: 12345
  api_hash: abcdef1234567890
  phone: "+1234567890"
`;

describe("audit8: managed agent persists parent env overrides", () => {
  let rootDir: string;
  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "a8-"));
    mkdirSync(join(rootDir, "workspace"), { recursive: true });
    writeFileSync(join(rootDir, "config.yaml"), PRIMARY_CONFIG);
  });
  afterEach(() => {
    delete process.env.TELETON_TG_PHONE;
    delete process.env.TELETON_API_KEY;
    rmSync(rootDir, { recursive: true, force: true });
  });
  it("updateAgent rewrites child phone/api_key with parent env values", () => {
    const svc = new ManagedAgentService({ rootDir, primaryConfigPath: join(rootDir, "config.yaml") });
    const snap = svc.createAgent({
      name: "Child",
      personalConnection: { apiId: 98765, apiHash: "childhash123", phone: "+15551234567" },
      acknowledgePersonalAccountAccess: true,
    });
    process.env.TELETON_TG_PHONE = "+19990000000";
    process.env.TELETON_API_KEY = "sk-ant-api03-PARENT-ENV-SECRET";
    svc.updateAgent(snap.id, { description: "x" });
    const yaml = readFileSync(snap.configPath, "utf-8");
    console.log(yaml.split("\n").filter((l) => /phone|api_key/.test(l)).join("\n"));
    expect(yaml).toContain("+19990000000");
    expect(yaml).toContain("PARENT-ENV-SECRET");
  });
});
