import { describe, it, expect } from "vitest";
import { existsSync } from "fs";
import path from "path";
import { readStateClassified } from "../src/utils/state.js";
import { useLintTempRoot } from "./fixtures/lint-temp-root.js";
import { writeCorruptTestStateJson, writeTestStateJson } from "./fixtures/state-json.js";

describe("readStateClassified", () => {
  const env = useLintTempRoot("state-classified");

  it("reports missing when state.json does not exist", async () => {
    const result = await readStateClassified(env.dir);
    expect(result.status).toBe("missing");
    expect(result.state.sources).toEqual({});
  });

  it("reports ok and parses a valid state file", async () => {
    await writeTestStateJson(env.dir, {
      version: 1,
      indexHash: "",
      sources: { "a.md": { hash: "h", concepts: ["x"], compiledAt: "t" } },
    });
    const result = await readStateClassified(env.dir);
    expect(result.status).toBe("ok");
    expect(result.state.sources["a.md"].hash).toBe("h");
  });

  it("reports corrupt WITHOUT writing a .bak (read-only)", async () => {
    await writeCorruptTestStateJson(env.dir);
    const result = await readStateClassified(env.dir);
    expect(result.status).toBe("corrupt");
    expect(result.state.sources).toEqual({});
    expect(existsSync(path.join(env.dir, ".llmwiki/state.json.bak"))).toBe(false);
  });
});
