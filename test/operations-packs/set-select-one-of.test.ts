/**
 * @file test/operations-packs/set-select-one-of.test.ts
 * @description The parameterised `one-of` admission predicate (section 16.3):
 * full-string equality against a closed declared value set, NO trimming, and a
 * DISTINCT `invalid-value` exclusion the validation deficit counts alone.
 *
 * WHAT IT EXISTS TO END: nothing in the select grammar could refuse an
 * out-of-set field value — `whenEquals` intent gates merely route unmatched
 * rows away with no deficit, so a provider row carrying a near-miss label
 * (whitespace, a superstring) vanished silently. `one-of` turns that row into
 * a counted `invalid-row` deficit a required completeness class refuses on.
 *
 * THE NO-TRIM RULE IS THE POINT of the whitespace case: the downstream
 * `whenEquals` gates compare the SAME raw field value, so a trimming predicate
 * would admit a `" supported"` row that then matches no intent group — the
 * split-brain the shared-enumeration rule forbids.
 */

import { describe, expect, it } from "vitest";
import { selectSet } from "../../src/operations-packs/handlers/set-select.js";
import type { SelectFilterPredicateV2, SelectPhaseBodyV2 } from "../../src/operations-packs/recipe-types.js";
import type { PackEvidenceItemV1, PackSelectInputV1 } from "../../src/operations-packs/handlers/types.js";

/** The overlapping label set the design names as the substring hazard. */
const LABELS = ["supported", "partially_supported", "not_supported"];

type Fields = PackEvidenceItemV1["fields"];
const item = (itemId: string, fields: Fields): PackEvidenceItemV1 => ({ itemId, fields });

/** One filter select over `verdict` with the given predicates. */
function input(primary: PackEvidenceItemV1[], predicates: SelectFilterPredicateV2[]): PackSelectInputV1 {
  const body: SelectPhaseBodyV2 = {
    operation: "filter", identityFields: ["verdict"], sortFields: [],
    filterPredicateIds: predicates,
    overflowDisposition: "record-deficit", completenessClass: "row-validity",
  };
  return { body, primary, bounds: { maximumItems: 100, maximumOutputBytes: 262_144 } };
}

const oneOf = (values: string[]): SelectFilterPredicateV2 => ({ id: "one-of", field: "verdict", values });

/** Assert one row was admitted with nothing excluded and nothing counted. */
function expectAdmittedCleanly(selectInput: PackSelectInputV1, itemId: string): void {
  const result = selectSet(selectInput);
  expect(result.items.map((entry) => entry.itemId)).toEqual([itemId]);
  expect(result.selection.excluded).toEqual([]);
  expect(result.deficits).toEqual([]);
}

describe("one-of admission", () => {
  it("classifies a doubly-failing row as ROUTED under either declaration order", () => {
    // Fails has-identity (empty verdict) AND one-of (empty is not a label). The
    // classification must be order-INDEPENDENT: always the route's filtered-out,
    // never a counted invalid-value — else declaring one-of first would turn a
    // legitimately routed-away row into a spurious REQUIRED refusal.
    for (const predicates of [
      [oneOf(LABELS), "has-identity"],
      ["has-identity", oneOf(LABELS)],
    ] as SelectFilterPredicateV2[][]) {
      const result = selectSet(input([item("both", { verdict: "" })], predicates));
      expect(result.items).toEqual([]);
      expect(result.selection.excluded).toEqual([{ itemId: "both", reason: "filtered-out" }]);
      expect(result.deficits).toEqual([]);
    }
  });

  it("admits a row whose field exactly equals one declared value", () => {
    expectAdmittedCleanly(input([item("row", { verdict: "supported" })], [oneOf(LABELS)]), "row");
  });

  it("admits each overlapping label exactly — never by substring", () => {
    // `supported` is a substring of both other labels; full-string equality
    // must admit each row under its own label and only that one.
    const rows = LABELS.map((label, index) => item(`row-${index}`, { verdict: label }));
    const result = selectSet(input(rows, [oneOf(LABELS)]));
    expect(result.items.map((entry) => entry.fields.verdict)).toEqual(LABELS);
    expect(result.deficits).toEqual([]);
  });

  it("refuses a superstring carrying a declared label inside it", () => {
    // The substring hazard inverted: `partially_supported` CONTAINS the only
    // declared label, and a substring scan would admit it.
    const result = selectSet(input([item("row", { verdict: "partially_supported" })], [oneOf(["supported"])]));
    expect(result.items).toEqual([]);
    expect(result.selection.excluded).toEqual([{ itemId: "row", reason: "invalid-value" }]);
  });

  it("a whitespace variant is an invalid row — refused AND counted, never trimmed in", () => {
    const result = selectSet(input([item("row", { verdict: " supported" })], [oneOf(LABELS)]));
    expect(result.items).toEqual([]);
    expect(result.selection.excluded).toEqual([{ itemId: "row", reason: "invalid-value" }]);
    // Not a silent drop: the exclusion is counted as an invalid-row deficit,
    // which a required completeness class turns into a run refusal.
    expect(result.deficits).toEqual([
      { completenessClass: "row-validity", reason: "invalid-row", droppedCount: 1 },
    ]);
  });

  it("counts ONLY one-of refusals: a routing predicate's exclusions stay uncounted", () => {
    // `has-identity` (over `verdict`) drops the keyless row by design; only the
    // out-of-set row may reach the deficit, or routing would cause false refusals.
    const rows = [
      item("keyless", { verdict: "" }),
      item("off-label", { verdict: "unknown" }),
      item("good", { verdict: "supported" }),
    ];
    const result = selectSet(input(rows, ["has-identity", oneOf(LABELS)]));
    expect(result.items.map((entry) => entry.itemId)).toEqual(["good"]);
    expect(result.selection.excluded).toEqual([
      { itemId: "keyless", reason: "filtered-out" },
      { itemId: "off-label", reason: "invalid-value" },
    ]);
    expect(result.deficits).toEqual([
      { completenessClass: "row-validity", reason: "invalid-row", droppedCount: 1 },
    ]);
  });

  it("MUTATION CONTROL: without the predicate the same malformed row flows through", () => {
    // The deficit is what `one-of` adds: removing it must admit the row and
    // record nothing, or the refusal case above never witnessed the predicate.
    expectAdmittedCleanly(input([item("row", { verdict: " supported" })], []), "row");
  });
});
