/**
 * @file test/operations-packs/reconcile-expected-current-digest.test.ts
 * @description The generic IN-RECONCILE author-read-digest chokepoint (the
 * artifact-UPDATE primitive P6.3c-2c(3a) adds). When a reconcile body names
 * `expectedCurrentDigestRef`, a proposed identity that MATCHES a snapshot page
 * must carry, under that field, a canonical `sha256:<64hex>` digest EQUAL to the
 * page's host-derived current-digest — else reconcile refuses BEFORE emitting a
 * finding. These cases pin the primitive directly on `reconcileEvidence` (the
 * reconcile-pipeline seam) so the update it later feeds can never overwrite a page
 * that changed since the caller read it.
 *
 * Each control is mutation-anchored: the STALE and MALFORMED cases go RED only
 * because the chokepoint runs, and the MATCH / absent-identity / absent-field
 * cases prove it does not fire spuriously (so a mutant that always-throws is
 * caught too).
 */

import { describe, expect, it } from "vitest";
import { reconcileEvidence } from "../../src/operations-packs/handlers/reconcile.js";
import {
  CURRENT_BYTES_FIELD, CURRENT_DIGEST_FIELD,
} from "../../src/operations-packs/runtime/store-snapshot.js";
import type { PackEvidenceItemV1 } from "../../src/operations-packs/handlers/types.js";

const BOUNDS = { maximumItems: 16, maximumOutputBytes: 65_536 } as const;
const CURRENT_HEX = "a".repeat(64);
const REF = "author-read-digest";

/** A reconcile body gating updates on the author-read-digest ref. */
function gatedBody() {
  return {
    reconcilePolicyId: "reconcile.default", comparedEvidenceClass: "ideas",
    findingClasses: ["absent", "identical", "compatible-update", "conflicting"],
    expectedCurrentDigestRef: REF,
  };
}

/** The idea page currently on disk (its snapshot carries the on-disk digest). */
function snapshotItem(): PackEvidenceItemV1 {
  return {
    itemId: "an-idea",
    fields: { title: "An idea", stage: "proposed", [CURRENT_DIGEST_FIELD]: CURRENT_HEX, [CURRENT_BYTES_FIELD]: 64 },
  };
}

/** A proposed update of that idea, sealing `digest` under the gated ref (omitted when undefined). */
function proposed(itemId: string, digest: string | undefined): PackEvidenceItemV1 {
  return {
    itemId,
    fields: { title: "An idea", stage: "explored", ...(digest === undefined ? {} : { [REF]: digest }) },
  };
}

/** Reconcile one proposal against the single idea snapshot under the gated body. */
function reconcile(item: PackEvidenceItemV1) {
  return reconcileEvidence({ body: gatedBody(), proposed: [item], snapshot: [snapshotItem()], bounds: BOUNDS } as never);
}

describe("reconcile author-read-digest chokepoint", () => {
  it("admits an update whose sealed author-read digest EQUALS the current page", () => {
    const result = reconcile(proposed("an-idea", `sha256:${CURRENT_HEX}`));
    expect(result.findings.map((f) => f.identity)).toEqual(["an-idea"]); // no refusal, a finding is emitted
  });

  it("REFUSES a STALE update: the sealed digest no longer equals the current page", () => {
    expect(() => reconcile(proposed("an-idea", `sha256:${"b".repeat(64)}`)))
      .toThrow(/does not equal the current page digest.*stale artifact-update/);
  });

  it("REFUSES a MALFORMED sealed digest (fail-closed parse of a present value)", () => {
    expect(() => reconcile(proposed("an-idea", "not-a-digest")))
      .toThrow(/is not a canonical sha256:<64hex>/);
  });

  it("does NOT gate a proposal with NO snapshot match — a create carries no precondition", () => {
    // A stale-looking digest on an identity the store does not hold is irrelevant:
    // an absent identity is a create, never a gated update.
    const result = reconcile(proposed("a-different-idea", `sha256:${"c".repeat(64)}`));
    expect(result.findings.map((f) => f.findingClass)).toEqual(["absent"]);
  });

  it("REFUSES a matched update that sealed NO author-read digest (the stale-body bypass is closed)", () => {
    // Skipping an absent digest would let a caller read a draft, allow a body edit,
    // then update with the NEWER snapshot as precondition while writing the stale body.
    expect(() => reconcile(proposed("an-idea", undefined)))
      .toThrow(/requires the author-read digest field "author-read-digest" to update "an-idea".*sealed none/);
  });

  it("leaves reconcile ungated when the body names no ref at all", () => {
    const body = { ...gatedBody(), expectedCurrentDigestRef: undefined };
    const result = reconcileEvidence({
      body, proposed: [proposed("an-idea", "not-a-digest")], snapshot: [snapshotItem()], bounds: BOUNDS,
    } as never);
    expect(result.findings.map((f) => f.identity)).toEqual(["an-idea"]); // a garbage ref value is inert without the body ref
  });
});
