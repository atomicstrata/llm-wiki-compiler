/**
 * @file test/preparations/expansion.test.ts
 * @description The fan-out enumerator (Chunk 3 unit B): canonical-digest and
 * host-id identity, first-seen dedup, the fail duplicate policy, the
 * maximumItems bound, and both overflow dispositions (fail-closed vs
 * counted-as-incomplete against a named class).
 */

import { describe, expect, it } from "vitest";
import {
  enumerateMapExpansion, repeatIterationDecision,
  type MapExpansionInputV1, type RepeatIterationInputV1,
} from "../../src/preparations/expansion.js";

const BASE: MapExpansionInputV1 = {
  maximumItems: 10, itemIdentity: "canonical-item-digest",
  duplicateDisposition: "deduplicate", overflowDisposition: { kind: "fail-closed" },
};

describe("enumerateMapExpansion", () => {
  it("enumerates one instance per distinct canonical item, in source order", () => {
    const result = enumerateMapExpansion([{ a: 1 }, { a: 2 }, { a: 3 }], BASE);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.instances).toHaveLength(3);
    expect(result.instances.map((i) => i.item)).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
    expect(new Set(result.instances.map((i) => i.expansionIdentity)).size).toBe(3);
    expect(result.overflowDeficit).toBe(0);
  });

  it("deduplicates structurally-equal items, keeping first-seen order", () => {
    const result = enumerateMapExpansion([{ a: 1 }, { a: 1 }, { a: 2 }], BASE);
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.instances.map((i) => i.item)).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("refuses a duplicate under the fail duplicate policy", () => {
    const result = enumerateMapExpansion([{ a: 1 }, { a: 1 }],
      { ...BASE, duplicateDisposition: "fail" });
    expect(result).toMatchObject({ status: "refused", reason: expect.stringContaining("duplicate") });
  });

  it("refuses overflow when fail-closed", () => {
    const result = enumerateMapExpansion([{ a: 1 }, { a: 2 }, { a: 3 }], { ...BASE, maximumItems: 2 });
    expect(result).toMatchObject({ status: "refused", reason: expect.stringContaining("fail-closed") });
  });

  it("counts overflow as a deficit against the named class", () => {
    const result = enumerateMapExpansion([{ a: 1 }, { a: 2 }, { a: 3 }], {
      ...BASE, maximumItems: 2,
      overflowDisposition: { kind: "count-as-incomplete", completenessClassId: "screened-sources" },
    });
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.instances).toHaveLength(2);
    expect(result.overflowDeficit).toBe(1);
    expect(result.deficitClassId).toBe("screened-sources");
  });

  it("identifies items by host id when so configured", () => {
    const result = enumerateMapExpansion(
      [{ hostId: "x", value: 1 }, { hostId: "x", value: 2 }, { hostId: "y", value: 3 }],
      { ...BASE, itemIdentity: "host-id" });
    if (result.status !== "ok") throw new Error("expected ok");
    // Same host id dedups regardless of differing value.
    expect(result.instances.map((i) => i.itemDigest)).toEqual(["host:x", "host:y"]);
  });
});

const REPEAT: RepeatIterationInputV1 = {
  completedIndex: 0, maximumIterations: 3, continuation: { kind: "until-empty" },
  remainingIsEmpty: false, limitDisposition: { kind: "fail-closed" },
};

describe("repeatIterationDecision", () => {
  it("fixed-count continues until the declared count, then converges", () => {
    const base = { ...REPEAT, continuation: { kind: "fixed-count", count: 2 } as const };
    expect(repeatIterationDecision({ ...base, completedIndex: 0 })).toEqual({ kind: "continue" });
    expect(repeatIterationDecision({ ...base, completedIndex: 1 })).toEqual({ kind: "converged" });
  });

  it("until-empty converges the moment the remaining-queue empties", () => {
    expect(repeatIterationDecision({ ...REPEAT, remainingIsEmpty: true })).toEqual({ kind: "converged" });
  });

  it("until-empty continues while the queue is non-empty and below the max", () => {
    expect(repeatIterationDecision({ ...REPEAT, completedIndex: 1 })).toEqual({ kind: "continue" });
  });

  it("refuses a non-convergent run at the iteration cap under fail-closed", () => {
    const result = repeatIterationDecision({ ...REPEAT, completedIndex: 2 });
    expect(result).toMatchObject({ kind: "refused", reason: expect.stringContaining("fail-closed") });
  });

  it("counts a non-convergent run as incomplete against the named class", () => {
    const result = repeatIterationDecision({
      ...REPEAT, completedIndex: 2,
      limitDisposition: { kind: "count-as-incomplete", completenessClassId: "unresolved-queue" },
    });
    expect(result).toEqual({ kind: "stopped-incomplete", deficitClassId: "unresolved-queue" });
  });
});
