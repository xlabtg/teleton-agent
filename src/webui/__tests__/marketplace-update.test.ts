import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
const state = vi.hoisted(() => ({ root: "", candidate: undefined as unknown }));
vi.mock("../../workspace/paths.js", () => ({
  WORKSPACE_PATHS: {
    get PLUGINS_DIR() {
      return state.root;
    },
  },
}));
vi.mock("../../agent/tools/plugin-loader.js", () => ({
  ensurePluginDeps: vi.fn(),
  adaptPlugin: vi.fn(() => state.candidate),
}));
import { MarketplaceService } from "../services/marketplace.js";
import type { MarketplaceDeps } from "../types.js";
import type { ToolRegistry } from "../../agent/tools/registry.js";

describe("transactional marketplace updates (#756)", () => {
  let db: Database.Database;
  beforeEach(() => {
    state.root = mkdtempSync(join(tmpdir(), "teleton-market-update-"));
    db = new Database(":memory:");
    mkdirSync(join(state.root, "demo"));
    writeFileSync(join(state.root, "demo", "index.js"), "old version");
    writeFileSync(join(state.root, "demo", "local-state.json"), "persistent state");
  });
  afterEach(() => {
    db.close();
    rmSync(state.root, { recursive: true, force: true });
  });
  function fixture() {
    const old = {
      name: "demo",
      version: "1.0.0",
      tools: vi.fn(() => []),
      start: vi.fn(),
      stop: vi.fn(),
    };
    const candidate = {
      name: "demo",
      version: "2.0.0",
      tools: vi.fn(() => []),
      start: vi.fn(),
      stop: vi.fn(),
    };
    state.candidate = candidate;
    const toolRegistry = { registerPluginTools: vi.fn(() => 1), removePluginTools: vi.fn() };
    const modules = [old];
    const service = new MarketplaceService({
      modules,
      config: {},
      sdkDeps: {},
      pluginContext: { db },
      loadedModuleNames: ["demo"],
      rewireHooks: vi.fn(),
      toolRegistry,
    } as unknown as MarketplaceDeps & { toolRegistry: ToolRegistry });
    vi.spyOn(service, "getRegistry").mockResolvedValue([
      { id: "demo", name: "demo", path: "plugins/demo" },
    ] as never);
    const internal = service as unknown as {
      fetchRemoteManifest: () => Promise<unknown>;
      downloadDir: (remote: string, local: string) => Promise<void>;
    };
    vi.spyOn(internal, "fetchRemoteManifest").mockResolvedValue({});
    const download = vi
      .spyOn(internal, "downloadDir")
      .mockImplementation(async (_remote, local) => {
        writeFileSync(join(local, "package.json"), '{"type":"module"}');
        writeFileSync(join(local, "index.js"), "export default {};");
      });
    return { old, candidate, modules, toolRegistry, service, download };
  }
  it("preserves running version and local files on download failure", async () => {
    const f = fixture();
    f.download.mockRejectedValue(new Error("network"));
    await expect(f.service.updatePlugin("demo")).rejects.toThrow("network");
    expect(f.old.stop).not.toHaveBeenCalled();
    expect(f.toolRegistry.removePluginTools).not.toHaveBeenCalled();
    expect(f.modules).toEqual([f.old]);
    expect(readFileSync(join(state.root, "demo", "local-state.json"), "utf8")).toBe(
      "persistent state"
    );
  });
  it("restores files, module and tools if the new version fails to start", async () => {
    const f = fixture();
    f.candidate.start.mockRejectedValue(new Error("bad plugin"));
    await expect(f.service.updatePlugin("demo")).rejects.toThrow("bad plugin");
    expect(readFileSync(join(state.root, "demo", "index.js"), "utf8")).toBe("old version");
    expect(f.modules).toEqual([f.old]);
    expect(f.old.start).toHaveBeenCalledOnce();
    expect(f.toolRegistry.registerPluginTools).toHaveBeenLastCalledWith("demo", []);
  });
  it("replaces the installed version after validation", async () => {
    const f = fixture();
    expect(await f.service.updatePlugin("demo")).toMatchObject({ version: "2.0.0" });
    expect(f.modules).toEqual([f.candidate]);
    expect(existsSync(join(state.root, "demo", "index.js"))).toBe(true);
    expect(f.old.stop).toHaveBeenCalledOnce();
  });
});
