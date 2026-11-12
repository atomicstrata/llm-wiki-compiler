/**
 * The local health gate must reject the same nonempty combined report as the
 * pinned GitHub action, even when the underlying analyzer exits successfully.
 */
import { describe, expect, it } from "bun:test";
import { spawnCaptured } from "../fixtures/spawn-captured.js";

/** Execute the report boundary without running the analyzer or fetching Git. */
function gate(report: unknown) {
  return spawnCaptured(process.execPath, ["scripts/check-fallow-report.mjs"], {
    input: JSON.stringify(report),
  });
}

describe("local Fallow report gate", () => {
  it.each([[0, 0, 0, 0], [0, 95, 0, 1], [1, 0, 0, 1], [0, 0, 1, 1]])(
    "counts dead-code=%i duplication=%i complexity=%i",
    async (dead, clones, complexity, expected) => {
      expect((await gate({ check: { total_issues: dead }, dupes: { stats: { clone_groups: clones } },
        health: { summary: { functions_above_threshold: complexity } } })).status).toBe(expected);
    },
  );
  it("fails closed on a missing report schema", async () => {
    expect((await gate({})).status).toBe(2);
  });
});
