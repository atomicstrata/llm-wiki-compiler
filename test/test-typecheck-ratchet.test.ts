/** Per-file test diagnostic allowances must decrease without transferable slack. */
import { expect, it } from "vitest";
import { compareDiagnosticCounts } from "../scripts/test-typecheck-ratchet.js";

it("accepts an unchanged per-file baseline", () => {
  expect(compareDiagnosticCounts({ "test/old.ts": 2 }, { "test/old.ts": 2 })).toEqual([]);
});

it("rejects a new nested-file error even when the total number decreases", () => {
  const errors = compareDiagnosticCounts({ "test/old.ts": 1, "test/nested/new.ts": 1 }, { "test/old.ts": 4 });
  expect(errors.some((error) => error.includes("test/nested/new.ts"))).toBe(true);
});

it("requires a baseline reduction when an existing error is fixed", () => {
  expect(compareDiagnosticCounts({ "test/old.ts": 1 }, { "test/old.ts": 2 })).toHaveLength(1);
});

it("requires removing the allowance when the last error is fixed", () => {
  expect(compareDiagnosticCounts({}, { "test/old.ts": 1 })).toHaveLength(1);
});

it("allows decreases, but never increases, while updating or comparing a PR baseline", () => {
  expect(compareDiagnosticCounts({}, { "test/old.ts": 1 }, true)).toEqual([]);
  expect(compareDiagnosticCounts({ "test/old.ts": 2 }, { "test/old.ts": 1 }, true)).toHaveLength(1);
});
