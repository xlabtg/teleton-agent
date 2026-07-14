import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import type { Tool as PiAiTool } from "@mariozechner/pi-ai";
import { NoopEmbeddingProvider } from "../../../memory/embeddings/provider.js";
import { ensureSchema, runMigrations } from "../../../memory/schema.js";
import { ToolIndex } from "../tool-index.js";

describe("ToolIndex", () => {
  let db: InstanceType<typeof Database>;
  let toolIndex: ToolIndex;

  beforeEach(() => {
    db = new Database(":memory:");
    ensureSchema(db);
    runMigrations(db);
    toolIndex = new ToolIndex(db, new NoopEmbeddingProvider(), false, {
      topK: 10,
      alwaysInclude: [],
      skipUnlimitedProviders: false,
    });
  });

  afterEach(() => {
    db.close();
  });

  it("keeps the FTS index in sync when re-registering a tool", async () => {
    const tool = (description: string): PiAiTool => ({ name: "foo", description }) as PiAiTool;

    await toolIndex.reindexTools([], [tool("alpha")]);
    const rowidBefore = db.prepare(`SELECT rowid FROM tool_index WHERE name = 'foo'`).pluck().get();

    await toolIndex.reindexTools([], [tool("beta")]);
    const rowidAfter = db.prepare(`SELECT rowid FROM tool_index WHERE name = 'foo'`).pluck().get();

    expect(rowidAfter).toBe(rowidBefore);
    expect(await toolIndex.search("alpha", [])).toEqual([]);
    expect((await toolIndex.search("beta", [])).map((result) => result.name)).toEqual(["foo"]);
    expect(() =>
      db.prepare(`INSERT INTO tool_index_fts(tool_index_fts) VALUES ('integrity-check')`).run()
    ).not.toThrow();
  });
});
