import { mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const { tempWorkspace } = vi.hoisted(() => ({
  tempWorkspace: "/tmp/teleton-workspace-write-test",
}));

rmSync(tempWorkspace, { recursive: true, force: true });
mkdirSync(tempWorkspace, { recursive: true });

vi.mock("../../../../workspace/paths.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../../workspace/paths.js")>();
  return {
    ...original,
    WORKSPACE_ROOT: tempWorkspace,
  };
});

import { workspaceWriteExecutor } from "../write.js";

afterAll(() => {
  rmSync(tempWorkspace, { recursive: true, force: true });
});

describe("workspaceWriteExecutor", () => {
  it("creates binary files with owner-only permissions", async () => {
    const previousUmask = process.umask(0o022);
    try {
      const result = await workspaceWriteExecutor(
        {
          path: "private.bin",
          content: Buffer.from("private content").toString("base64"),
          encoding: "base64",
        },
        {} as never
      );

      expect(result.success).toBe(true);
      expect(statSync(join(tempWorkspace, "private.bin")).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(previousUmask);
    }
  });
});
