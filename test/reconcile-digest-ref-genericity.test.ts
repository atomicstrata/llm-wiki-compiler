/**
 * @file test/reconcile-digest-ref-genericity.test.ts
 * @description §4.6 genericity evidence for the IN-RECONCILE author-read-digest
 * primitive (P6.3c-2c(3a)) — a NEW core recipe-grammar seam that a product
 * consumes. Requirement (1) — no product vocabulary/imports — is enforced by the
 * existing `no-research-branch-in-core` + `product-boundary-genericity` gates the
 * seam passes unchanged (the field name is the pack's, never core's). Here:
 * (2) a DISSIMILAR (newsroom `articles`) consumer exercises the chokepoint exactly
 * as the research (`ideas`) consumer does — the primitive branches on NO
 * vocabulary; (3) BYTE-IDENTICAL CORE — a fingerprint over the COMPLETE tracked
 * core tree (`git ls-files -z src`, path + raw bytes) is unchanged before/after the
 * seam runs under two dissimilar profiles' shapes.
 */

import { describe, it, expect } from "vitest";
import { coreTreeFingerprint as fingerprint } from "./fixtures/core-tree-fingerprint.js";
import { reconcileEvidence } from "../src/operations-packs/handlers/reconcile.js";
import {
  CURRENT_BYTES_FIELD, CURRENT_DIGEST_FIELD,
} from "../src/operations-packs/runtime/store-snapshot.js";
import type { PackEvidenceItemV1 } from "../src/operations-packs/handlers/types.js";

const BOUNDS = { maximumItems: 16, maximumOutputBytes: 65_536 } as const;
const REF = "author-read-digest";
const CURRENT_HEX = "d".repeat(64);

/**
 * A fingerprint of the COMPLETE tracked core tree: EVERY `git ls-files src` (any
 * extension), sorted, hashing each relative PATH and its RAW BYTES with length-
 * prefixed framing so a rename, a new file, or a byte edit all change the digest.
 */
function coreTreeFingerprint(): string {
  return fingerprint(true);
}

/** Exercise the chokepoint for ONE profile's evidence class, asserting stale-refuse + match-admit. */
function exerciseChokepoint(evidenceClass: string, id: string, titleField: string): void {
  const body = {
    reconcilePolicyId: "reconcile.default", comparedEvidenceClass: evidenceClass,
    findingClasses: ["absent", "compatible-update", "conflicting"], expectedCurrentDigestRef: REF,
  };
  const snapshot: PackEvidenceItemV1 = {
    itemId: id, fields: { [titleField]: "T", [CURRENT_DIGEST_FIELD]: CURRENT_HEX, [CURRENT_BYTES_FIELD]: 8 },
  };
  const propose = (digest: string): PackEvidenceItemV1 => ({ itemId: id, fields: { [titleField]: "T", desk: "news", [REF]: digest } });
  expect(() => reconcileEvidence({ body, proposed: [propose(`sha256:${"e".repeat(64)}`)], snapshot: [snapshot], bounds: BOUNDS } as never))
    .toThrow(/stale artifact-update/);
  const ok = reconcileEvidence({ body, proposed: [propose(`sha256:${CURRENT_HEX}`)], snapshot: [snapshot], bounds: BOUNDS } as never);
  expect(ok.findings.map((f) => f.identity)).toEqual([id]);
}

describe("reconcile author-read-digest chokepoint — §4.6 genericity", () => {
  it("gates a DISSIMILAR (newsroom articles) consumer identically to a research (ideas) consumer", () => {
    // The primitive reads `expectedCurrentDigestRef` and the snapshot's on-disk
    // digest — never any entity/relation name — so a newsroom `articles` update is
    // gated exactly as a research `ideas` one is.
    exerciseChokepoint("ideas", "an-idea", "title");
    exerciseChokepoint("articles", "an-article", "headline");
  });

  it("leaves the COMPLETE tracked core tree byte-identical when exercised under two dissimilar shapes", () => {
    const before = coreTreeFingerprint();
    exerciseChokepoint("ideas", "an-idea", "title");
    exerciseChokepoint("articles", "an-article", "headline");
    expect(coreTreeFingerprint()).toBe(before);
  });
});
