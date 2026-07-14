import { describe, expect, it } from "vitest";

import { selectRunIdToLoad } from "../pipelineRunSelection";

describe("selectRunIdToLoad", () => {
  it("keeps the user's selected run across polls", () => {
    expect(selectRunIdToLoad("older-run", ["newest-run", "older-run"])).toBe("older-run");
  });

  it("auto-selects the newest run when no run is selected", () => {
    expect(selectRunIdToLoad(null, ["newest-run", "older-run"])).toBe("newest-run");
  });

  it("selects the newest run when the previous selection belongs to another pipeline", () => {
    expect(selectRunIdToLoad("other-pipeline-run", ["newest-run", "older-run"])).toBe("newest-run");
  });

  it("clears the selection when there are no runs", () => {
    expect(selectRunIdToLoad("older-run", [])).toBeNull();
  });
});
