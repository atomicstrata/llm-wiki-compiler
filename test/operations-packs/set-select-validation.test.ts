/**
 * @file test/operations-packs/set-select-validation.test.ts
 * @description The `exactly-one-present` VALIDATION predicate and its
 * `invalid-row` deficit (spec §2.1 generic change 3).
 *
 * WHAT IT EXISTS TO END: a provider row carrying its class in WHICH key field
 * is populated is routed by `has-identity` splits — and a row populating NO key
 * field, or SEVERAL, matched no split and vanished as `filtered-out`, the same
 * silent-drop shape as the positional-identity ingest defect. A completeness
 * class cannot express the refusal (deficit reasons are a closed union with no
 * arithmetic), so the validating select counts its own exclusions as
 * `invalid-row` deficits, and a `required` class turns that count into a run
 * failure.
 *
 * THE SCOPE IS THE POINT: routing splits' exclusions are INTENDED — each
 * class's split drops every other class's rows — so only the validation
 * predicate's exclusions may count. The routing case pins that boundary.
 */

import { describe, expect, it } from "vitest";
import { selectSet } from "../../src/operations-packs/handlers/set-select.js";
import type { SelectPhaseBodyV2 } from "../../src/operations-packs/recipe-types.js";
import type { PackEvidenceItemV1, PackSelectInputV1 } from "../../src/operations-packs/handlers/types.js";

const KEYS = ["paperKey", "conceptKey", "methodKey"];
type Fields = PackEvidenceItemV1["fields"];
const item = (itemId: string, fields: Fields): PackEvidenceItemV1 => ({ itemId, fields });

function validateInput(primary: PackEvidenceItemV1[], over: Partial<SelectPhaseBodyV2> = {}): PackSelectInputV1 {
  const body: SelectPhaseBodyV2 = {
    operation: "filter", identityFields: KEYS, sortFields: [],
    filterPredicateIds: ["exactly-one-present"],
    overflowDisposition: "record-deficit", completenessClass: "row-validity", ...over,
  };
  return { body, primary, bounds: { maximumItems: 100, maximumOutputBytes: 262_144 } };
}

describe("exactly-one-present validation", () => {
  it("keeps a one-key row and counts zero-key and multi-key rows as invalid-row", () => {
    const rows = [
      item("good", { paperKey: "p1", conceptKey: "", methodKey: "" }),
      item("none", { paperKey: "", conceptKey: "", methodKey: "" }),
      item("both", { paperKey: "p2", conceptKey: "c1", methodKey: "" }),
    ];
    const result = selectSet(validateInput(rows));
    expect(result.items.map((entry) => entry.itemId)).toEqual(["good"]);
    // The refusal the spec requires, POSITIVELY: a counted deficit under the
    // declared class, not a silent filtered-out disappearance.
    expect(result.deficits).toEqual([
      { completenessClass: "row-validity", reason: "invalid-row", droppedCount: 2 },
    ]);
  });

  it("emits NO deficit when every row is valid", () => {
    const rows = [item("a", { paperKey: "p1", conceptKey: "", methodKey: "" })];
    expect(selectSet(validateInput(rows)).deficits).toEqual([]);
  });

  it("leaves ROUTING splits' exclusions uncounted — they are intended", () => {
    // A has-identity split over conceptKey drops the paper row by design.
    const rows = [
      item("paper", { paperKey: "p1", conceptKey: "" }),
      item("concept", { paperKey: "", conceptKey: "c1" }),
    ];
    const body: SelectPhaseBodyV2 = {
      operation: "filter", identityFields: ["conceptKey"], sortFields: [],
      filterPredicateIds: ["has-identity"],
      overflowDisposition: "record-deficit", completenessClass: "row-validity",
    };
    const result = selectSet({ body, primary: rows, bounds: { maximumItems: 100, maximumOutputBytes: 262_144 } });
    expect(result.items.map((entry) => entry.itemId)).toEqual(["concept"]);
    expect(result.deficits).toEqual([]);
  });
});
