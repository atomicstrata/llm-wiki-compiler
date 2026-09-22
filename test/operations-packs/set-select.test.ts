/**
 * @file test/operations-packs/set-select.test.ts
 * @description set-select (design section 16.3) runs one closed deterministic
 * operation over validated evidence: stable dedup/sort, bounded top-N with an
 * explicit overflow disposition (record-deficit or fail-closed), set
 * union/intersection/difference by declared identity, group-by a declared scalar,
 * and filter by a REGISTERED predicate (an unregistered predicate fails closed).
 */

import { describe, expect, it } from "vitest";
import { selectSet } from "../../src/operations-packs/handlers/set-select.js";
import { canonicalBytes } from "../../src/profile/templates/signing/canonical.js";
import { PackHostHandlerError } from "../../src/operations-packs/handlers/types.js";
import type { SelectPhaseBodyV2 } from "../../src/operations-packs/recipe-types.js";
import type { PackEvidenceItemV1, PackSelectInputV1 } from "../../src/operations-packs/handlers/types.js";

type Fields = PackEvidenceItemV1["fields"];
function item(itemId: string, fields: Fields): PackEvidenceItemV1 { return { itemId, fields }; }

function input(operation: SelectPhaseBodyV2["operation"], primary: PackEvidenceItemV1[], over: Partial<SelectPhaseBodyV2> = {}, secondary?: PackEvidenceItemV1[]): PackSelectInputV1 {
  const body: SelectPhaseBodyV2 = {
    operation, identityFields: ["key"], sortFields: ["rank"], filterPredicateIds: [],
    overflowDisposition: "record-deficit", completenessClass: "select", ...over,
  };
  return { body, primary, ...(secondary === undefined ? {} : { secondary }), bounds: { maximumItems: 100, maximumOutputBytes: 262_144 } };
}

describe("set-select", () => {
  it("dedupes by declared identity, keeping the first occurrence", () => {
    const items = [item("a", { key: "k1", rank: 2 }), item("b", { key: "k1", rank: 1 }), item("c", { key: "k2", rank: 3 })];
    const result = selectSet(input("dedupe", items));
    expect(result.items.map((entry) => entry.itemId)).toEqual(["a", "c"]);
    expect(result.selection.excluded).toEqual([{ itemId: "b", reason: "duplicate-identity" }]);
  });

  it("sorts stably by the declared sort fields, deterministically", () => {
    const items = [item("a", { key: "a", rank: 3 }), item("b", { key: "b", rank: 1 }), item("c", { key: "c", rank: 1 })];
    const first = selectSet(input("sort", items));
    expect(first.items.map((entry) => entry.itemId)).toEqual(["b", "c", "a"]);
    expect(canonicalBytes(first)).toEqual(canonicalBytes(selectSet(input("sort", items))));
  });

  it("applies bounded top-N with a recorded overflow deficit", () => {
    const items = [item("a", { key: "a", rank: 1 }), item("b", { key: "b", rank: 2 }), item("c", { key: "c", rank: 3 })];
    const result = selectSet(input("top-n", items, { topN: 2 }));
    expect(result.items.map((entry) => entry.itemId)).toEqual(["a", "b"]);
    expect(result.selection.excluded).toEqual([{ itemId: "c", reason: "over-top-n" }]);
    expect(result.deficits).toEqual([{ completenessClass: "select", reason: "overflow", droppedCount: 1 }]);
  });

  it("fails closed when top-N overflows under a fail disposition", () => {
    const items = [item("a", { key: "a", rank: 1 }), item("b", { key: "b", rank: 2 })];
    expect(() => selectSet(input("top-n", items, { topN: 1, overflowDisposition: "fail" }))).toThrow(PackHostHandlerError);
  });

  it("computes union, intersection, and difference by declared identity", () => {
    const left = [item("a", { key: "k1" }), item("b", { key: "k2" })];
    const right = [item("c", { key: "k2" }), item("d", { key: "k3" })];
    expect(selectSet(input("intersection", left, {}, right)).items.map((entry) => entry.itemId)).toEqual(["b"]);
    expect(selectSet(input("difference", left, {}, right)).items.map((entry) => entry.itemId)).toEqual(["a"]);
    expect(selectSet(input("union", left, {}, right)).items.map((entry) => entry.itemId)).toEqual(["a", "b", "d"]);
  });

  it("groups by the declared scalar key", () => {
    const items = [item("a", { key: "a", grp: "x" }), item("b", { key: "b", grp: "y" }), item("c", { key: "c", grp: "x" })];
    expect(selectSet(input("group-by", items, { groupByField: "grp" })).groups)
      .toEqual([{ key: "x", itemIds: ["a", "c"] }, { key: "y", itemIds: ["b"] }]);
  });

  it("filters by a registered predicate and fails closed on an unregistered id", () => {
    const items = [item("a", { key: "k1" }), item("b", { key: "" })];
    const result = selectSet(input("filter", items, { filterPredicateIds: ["has-identity"] }));
    expect(result.items.map((entry) => entry.itemId)).toEqual(["a"]);
    expect(result.selection.excluded).toEqual([{ itemId: "b", reason: "filtered-out" }]);
    expect(() => selectSet(input("filter", items, { filterPredicateIds: ["nope"] }))).toThrow(PackHostHandlerError);
  });
});
