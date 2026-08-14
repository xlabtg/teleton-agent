import { spawnSync } from "child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";

process.env.TELETON_CLI_SKIP_PARSE = "true";
const { bindTeletonHomeToConfig } = await import("../index.js");

const repoRoot = process.cwd();
const cliEntry = join(repoRoot, "src", "cli", "index.ts");
const tsxBin = join(
  repoRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsx.cmd" : "tsx"
);

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

describe("teleton start missing config diagnostics", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("explains an active TELETON_HOME override when the normal default config exists", () => {
    expect(existsSync(tsxBin)).toBe(true);

    const normalHome = makeTempDir("teleton-normal-home");
    const overrideHome = makeTempDir("teleton-override-home");
    const normalConfigPath = join(normalHome, ".teleton", "config.yaml");
    const overrideConfigPath = join(overrideHome, "config.yaml");

    mkdirSync(join(normalHome, ".teleton"), { recursive: true });
    writeFileSync(normalConfigPath, "# existing default config\n", {
      encoding: "utf-8",
      mode: 0o600,
    });

    const result = spawnSync(tsxBin, [cliEntry, "start"], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: normalHome,
        USERPROFILE: normalHome,
        TELETON_HOME: overrideHome,
        TELETON_CLI_SKIP_PARSE: undefined,
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Configuration not found");
    expect(result.stderr).toContain("custom TELETON_HOME override is active");
    expect(result.stderr).toContain(`TELETON_HOME: ${overrideHome}`);
    expect(result.stderr).toContain(`Expected file: ${overrideConfigPath}`);
    expect(result.stderr).toContain(`Normal default file: ${normalConfigPath}`);
    expect(result.stderr).toContain("A config already exists in the normal default location");
    expect(result.stderr).toContain("temporary workaround for #364");
    expect(result.stderr).toContain("set TELETON_HOME=");
    expect(result.stderr).toContain("$env:TELETON_HOME=$null");
  }, 30000);

  it("binds runtime home to an explicit config path before loading the app", () => {
    const wrongHome = makeTempDir("teleton-wrong-home");
    const agentHome = makeTempDir("teleton-agent-home");
    const configPath = join(agentHome, "config.yaml");
    const originalHome = process.env.TELETON_HOME;

    process.env.TELETON_HOME = wrongHome;
    bindTeletonHomeToConfig(configPath, ["node", "teleton", "start", "-c", configPath]);

    expect(process.env.TELETON_HOME).toBe(agentHome);
    process.env.TELETON_HOME = originalHome;
  });
});
