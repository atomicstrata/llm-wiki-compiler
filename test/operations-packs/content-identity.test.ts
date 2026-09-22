/**
 * @file test/operations-packs/content-identity.test.ts
 * @description The select family's `identityFrom: "identity-fields"` — deriving
 * an item's identity from its own declared fields instead of its position in
 * the caller's list.
 *
 * WHY IT EXISTS. The host mints one evidence item per source record under
 * `source-<i>`, and that identity is what reconcile compares against the store
 * snapshot AND what the materializer writes the page at. Positional identity is
 * stable within a run and NOT across runs that pass different lists, so a pack
 * seeding a catalog could not express "the same concept keeps the same page":
 * seeding one already-present concept would compare it against whatever record
 * happened to occupy that index. This suite pins the derivation and its three
 * refusals; the cross-run consequence is witnessed in the prefill journey.
 *
 * THE DEFAULT MUST NOT MOVE. Absent the field, every identity stays positional,
 * so the first case here is the one that protects every pack authored before it.
 */

import { describe, expect, it } from "vitest";
import { selectSet } from "../../src/operations-packs/handlers/set-select.js";
import type { PackEvidenceItemV1, PackSelectInputV1 } from "../../src/operations-packs/handlers/types.js";
import type { SelectPhaseBodyV2 } from "../../src/operations-packs/recipe-types.js";

const BOUNDS = { maximumItems: 16, maximumOutputBytes: 65_536 } as const;

/** One positional source record carrying a title. */
function record(index: number, titles: string): PackEvidenceItemV1 {
  return { itemId: `source-${index}`, fields: { titles } };
}

/**
 * A filter body, optionally deriving identity from the title field.
 *
 * `predicates` is a parameter because `has-identity` EXCLUDES an item whose
 * declared identity field is missing, so a suite that left it on could never
 * reach the derivation's own missing-field refusal — the filter would answer
 * first and the control would pass without ever running.
 */
function body(
  fromContent: boolean, identityFields = ["titles"], predicates: string[] = ["has-identity"],
): SelectPhaseBodyV2 {
  return {
    operation: "filter", identityFields, sortFields: [],
    filterPredicateIds: predicates, overflowDisposition: "fail",
    completenessClass: "evidence-coverage",
    ...(fromContent ? { identityFrom: "identity-fields" as const } : {}),
  };
}

/** Select `primary` under `selectBody`. */
function run(selectBody: SelectPhaseBodyV2, primary: PackEvidenceItemV1[]) {
  return selectSet({ body: selectBody, primary, bounds: BOUNDS } as PackSelectInputV1);
}

describe("identity source", () => {
  it("keeps positional identities when the body does not ask for content identity", () => {
    const result = run(body(false), [record(0, "Transformer architecture"), record(1, "ImageNet")]);
    expect(result.items.map((item) => item.itemId)).toEqual(["source-0", "source-1"]);
  });

  it("derives the identity from the declared field, independent of list position", () => {
    const full = run(body(true), [record(0, "Transformer architecture"), record(1, "ImageNet")]);
    expect(full.items.map((item) => item.itemId)).toEqual(["transformer-architecture", "imagenet"]);
    // THE CROSS-RUN PROPERTY: the same concept alone in a shorter list keeps the
    // identity it had in the full catalog. Positionally it would be `source-0`.
    const single = run(body(true), [record(0, "ImageNet")]);
    expect(single.items.map((item) => item.itemId)).toEqual(["imagenet"]);
  });

  it("reports the derived identities as the included selection, not the positional ones", () => {
    const result = run(body(true), [record(0, "ImageNet")]);
    expect(result.selection.included).toEqual(["imagenet"]);
  });

  it("carries the item's fields through unchanged, so only the identity moves", () => {
    const result = run(body(true), [record(0, "ImageNet")]);
    expect(result.items[0]?.fields).toEqual({ titles: "ImageNet" });
  });
});

describe("content identity fails closed", () => {
  it("refuses a value that slugifies to nothing rather than seeding silently", () => {
    expect(() => run(body(true), [record(0, "!!!")])).toThrow(/empty identity/);
  });

  it("refuses when a declared identity field is missing from the item", () => {
    expect(() => run(body(true, ["titles", "kinds"], []), [record(0, "ImageNet")]))
      .toThrow(/empty identity/);
  });

  it("refuses two records that derive the SAME identity instead of dropping one", () => {
    // Distinct titles, one slug: `Image-Net` and `image net` both reduce to
    // `image-net`, so keeping the first would discard a real catalog entry.
    expect(() => run(body(true), [record(0, "Image-Net"), record(1, "image net")]))
      .toThrow(/same content identity/);
  });

  it("refuses an identity that is not slug-safe rather than failing at the page write", () => {
    expect(() => run(body(true), [record(0, "変換器")])).toThrow(/not slug-safe/);
  });
});
