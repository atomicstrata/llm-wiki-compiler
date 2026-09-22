/**
 * @file test/operations-packs/canonical-projection.test.ts
 * @description The canonical projection: reconcile must compare the fields the
 * terminal WOULD WRITE, not the caller's raw input.
 *
 * THE DEFECT IT REMOVES. Proposals carry input field names (`author`, and a
 * `stage` nothing supplies); a stored page carries frontmatter (`authors`,
 * `stage`). Those vocabularies cannot produce equal payload digests, so
 * `identical` was structurally unreachable and an unchanged record compared
 * against its own page reported `conflicting`. Behaviour looked right because
 * both classes fail an `absent` gate — the REASON was wrong, and any rule keyed
 * on `conflicting` would have fired on every unchanged record. That is why
 * `ingest` and `edit`, which both dedupe against existing state, were held
 * until this existed.
 *
 * ONE DECLARATION, TWO CONSUMERS. The same projection feeds the comparison and
 * the write, so the two cannot drift — a mapping repeated in both places is the
 * same defect waiting to reappear.
 */

import { describe, expect, it } from "vitest";
import { reconcileEvidence } from "../../src/operations-packs/handlers/reconcile.js";
import type { PackEvidenceItemV1, PackReconcileInputV1 } from "../../src/operations-packs/handlers/types.js";
import type { PackProjectionV2 } from "../../src/operations-packs/recipe-types.js";
import {
  CURRENT_BYTES_FIELD, CURRENT_DIGEST_FIELD,
} from "../../src/operations-packs/runtime/store-snapshot.js";

const BOUNDS = { maximumItems: 16, maximumOutputBytes: 65_536 } as const;

/** How a source record becomes `papers` frontmatter — the shared definition. */
const PAPER_PROJECTION: PackProjectionV2 = {
  projectionId: "project.paper", targetProfileClass: "papers",
  listFields: ["authors"],
  fieldMappings: [
    { targetField: "title", source: "phase-input", ref: "title" },
    { targetField: "authors", source: "phase-input", ref: "author" },
    { targetField: "stage", source: "constant", value: "imported" },
  ],
};

/** One caller record, in the INPUT vocabulary. */
const PROPOSED: PackEvidenceItemV1 = {
  itemId: "source-0", fields: { title: "Alpha effects", author: "A. Author", doi: "10.1/alpha" },
};

/**
 * The page that record already wrote, as a REAL snapshot item.
 *
 * It carries the on-disk digest and byte count the store snapshot attaches, so
 * these cases exercise what reconcile actually receives. Those fields have no
 * counterpart in a proposal, so leaving them in the comparison would put them
 * in the payload digest and make every existing page compare different —
 * `identical` unreachable again, for a new reason.
 */
const STORED: PackEvidenceItemV1 = {
  itemId: "source-0",
  fields: {
    title: "Alpha effects", stage: "imported",
    [CURRENT_DIGEST_FIELD]: "b".repeat(64), [CURRENT_BYTES_FIELD]: 96,
  },
};

/** Reconcile one proposal against one snapshot, with or without the projection. */
function compare(snapshot: PackEvidenceItemV1[], projection?: PackProjectionV2) {
  return reconcileEvidence({
    body: {
      reconcilePolicyId: "reconcile.default", comparedEvidenceClass: "papers",
      findingClasses: ["absent", "identical", "compatible-update", "conflicting", "duplicate-identity"],
    },
    proposed: [PROPOSED], snapshot, bounds: BOUNDS,
    ...(projection === undefined ? {} : { projection }),
  } as PackReconcileInputV1);
}

describe("comparing the canonical fields", () => {
  it("classifies an unchanged record IDENTICAL once the projection is applied", () => {
    expect(compare([STORED], PAPER_PROJECTION).findings)
      .toEqual([{ identity: "source-0", findingClass: "identical" }]);
  });

  it("WITHOUT the projection the same pair is not identical — the defect, pinned", () => {
    // The discriminating red: raw input field names against page frontmatter.
    // If this ever reports `identical`, the projection is no longer doing
    // anything and the case above proves nothing.
    expect(compare([STORED]).findings[0]?.findingClass).not.toBe("identical");
  });

  it("still reports ABSENT when the store holds nothing, so it is not always identical", () => {
    expect(compare([], PAPER_PROJECTION).findings)
      .toEqual([{ identity: "source-0", findingClass: "absent" }]);
  });

  it("still reports a real difference, so the projection does not flatten everything", () => {
    const different = {
      itemId: "source-0",
      fields: {
        title: "Something else", stage: "imported",
        [CURRENT_DIGEST_FIELD]: "c".repeat(64), [CURRENT_BYTES_FIELD]: 96,
      },
    };
    expect(compare([different], PAPER_PROJECTION).findings[0]?.findingClass).not.toBe("identical");
  });

  it("publishes BOTH vocabularies downstream, so other groups keep their raw fields", () => {
    // The paper group drafts from canonical `stage`; a relation group in the
    // same phase still needs the record's own `doi`. Dropping one would starve
    // the other.
    const item = compare([STORED], PAPER_PROJECTION).items[0]!;
    expect(item.fields.stage).toBe("imported");
    expect(item.fields.doi).toBe("10.1/alpha");
  });
});
