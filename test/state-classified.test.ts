import { describe, it, expect } from "vitest";
import { readStateClassified } from "../src/utils/state.js";
import { useLintTempRoot } from "./fixtures/lint-temp-root.js";
import { expectReadsCorruptNoBak, expectReadsOkV1 } from "./fixtures/state-read-assertions.js";

describe("readStateClassified", () => {
  const env = useLintTempRoot("state-classified");

  it("reports missing when state.json does not exist", async () => {
    const result = await readStateClassified(env.dir);
    expect(result.status).toBe("missing");
    expect(result.state.sources).toEqual({});
  });

  it("reports ok and parses a valid state file", async () => {
    await expectReadsOkV1(env.dir);
  });

  it("reports corrupt WITHOUT writing a .bak (read-only)", async () => {
    await expectReadsCorruptNoBak(env.dir);
  });
});
