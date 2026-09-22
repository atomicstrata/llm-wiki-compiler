/**
 * The local health gate must reject the same nonempty combined report as the
 * pinned GitHub action, even when the underlying analyzer exits successfully.
 */
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/** Execute the report boundary without running the analyzer or fetching Git. */
function gate(report: unknown) {
  return spawnSync(process.execPath, ["scripts/check-fallow-report.mjs"], {
    input: JSON.stringify(report), encoding: "utf8",
  });
}

describe("local Fallow report gate", () => {
  it.each([[0, 0, 0, 0], [0, 95, 0, 1], [1, 0, 0, 1], [0, 0, 1, 1]])(
    "counts dead-code=%i duplication=%i complexity=%i",
    (dead, clones, complexity, expected) => {
      expect(gate({ check: { total_issues: dead }, dupes: { stats: { clone_groups: clones } },
        health: { summary: { functions_above_threshold: complexity } } }).status).toBe(expected);
    },
  );
  it("fails closed on a missing report schema", () => {
    expect(gate({}).status).toBe(2);
  });
});
