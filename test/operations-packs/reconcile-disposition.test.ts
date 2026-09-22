/**
 * @file test/operations-packs/reconcile-disposition.test.ts
 * @description The two capabilities a PATCHABLE reconciliation needs, proven at
 * the units that own them: reconcile's verdicts must REACH the phase that
 * proposes next, and that phase must be able to act on WHICH verdict each
 * identity got.
 *
 * WHY THEY DID NOT EXIST. Reconcile published `findings` while the phase-output
 * decoder reads a predecessor's `items`, so a pack could surface a collision and
 * then propose straight over it — the verdict was legible to a human and
 * unreachable by the run. And intent groups gated on a field's PRESENCE, which
 * cannot express "draft only where the comparison said absent": every compared
 * item carries a `finding-class`, so presence is true for all of them and the
 * group would draft the colliding identity too. Those two gaps are exactly why
 * the AutoSci bootstrap ships labeled PARTIAL.
 *
 * The `findings` array is deliberately unchanged: it remains the report surface,
 * and this suite asserts both views describe the same verdicts so the thing an
 * operator reads and the thing the run acts on can never disagree.
 */

import { describe, expect, it } from "vitest";
import { compileIntents } from "../../src/operations-packs/handlers/intent-compile.js";
import { FINDING_CLASS_FIELD, reconcileEvidence } from "../../src/operations-packs/handlers/reconcile.js";
import type {
  PackEvidenceItemV1, PackReconcileInputV1,
} from "../../src/operations-packs/handlers/types.js";
import type { IntentPhaseBodyV2 } from "../../src/operations-packs/recipe-types.js";

const BOUNDS = { maximumItems: 16, maximumOutputBytes: 65_536 } as const;

/** One proposed paper candidate. */
function paper(itemId: string, title: string): PackEvidenceItemV1 {
  return { itemId, fields: { title, doi: `10.1/${itemId}` } };
}

/** Reconcile `proposed` against `snapshot`, declaring every class this suite uses. */
function compare(proposed: PackEvidenceItemV1[], snapshot: PackEvidenceItemV1[]) {
  const input: PackReconcileInputV1 = {
    body: {
      reconcilePolicyId: "reconcile.default",
      comparedEvidenceClass: "papers",
      findingClasses: ["absent", "identical", "conflicting", "duplicate-identity"],
    },
    proposed, snapshot, bounds: BOUNDS,
  };
  return reconcileEvidence(input);
}

/** An intent body drafting one page per item, gated to a finding class. */
function gatedBody(value: string): IntentPhaseBodyV2 {
  return {
    intents: [{
      mutationKind: "artifact-upsert",
      targetProfileClass: "papers",
      whenEquals: { field: FINDING_CLASS_FIELD, value },
      fieldMappings: [{ targetField: "title", source: "phase-input", ref: "title" }],
    }],
  } as unknown as IntentPhaseBodyV2;
}

describe("reconcile verdicts reach the proposing phase", () => {
  it("republishes every finding as a chainable item carrying its class and the proposal's fields", () => {
    const result = compare([paper("source-0", "Fresh"), paper("source-1", "Known")], [paper("source-1", "Known")]);
    expect(result.items.map((item) => [item.itemId, item.fields[FINDING_CLASS_FIELD]])).toEqual([
      ["source-0", "absent"],
      ["source-1", "identical"],
    ]);
    // The proposal's own values ride along, so the successor can draft from the
    // same item it dispositioned rather than re-reading a second source.
    expect(result.items.find((item) => item.itemId === "source-0")?.fields.title).toBe("Fresh");
  });

  it("describes the SAME verdicts in both views, so the report and the run cannot disagree", () => {
    const result = compare([paper("source-0", "Fresh"), paper("source-1", "Known")], [paper("source-1", "Known")]);
    expect(result.items.map((item) => `${item.itemId}:${String(item.fields[FINDING_CLASS_FIELD])}`))
      .toEqual(result.findings.map((finding) => `${finding.identity}:${finding.findingClass}`));
  });
});

describe("a group dispositions by verdict", () => {
  it("drafts the absent identity and LEAVES the colliding one alone", () => {
    const compared = compare([paper("source-0", "Fresh"), paper("source-1", "Known")], [paper("source-1", "Known")]);
    const drafts = absentDrafts(compared.items);
    expect(drafts.map((draft) => draft.sourceItemId)).toEqual(["source-0"]);
  });

  it("drafts NOTHING when every proposal collides — the run has nothing to propose", () => {
    const compared = compare([paper("source-1", "Known")], [paper("source-1", "Known")]);
    const drafts = absentDrafts(compared.items);
    expect(drafts).toEqual([]);
  });
});

/** Compile only proposals that reconciliation classified as absent. */
function absentDrafts(evidence: readonly PackEvidenceItemV1[]) {
  return compileIntents({
    body: gatedBody("absent"), evidence, bounds: BOUNDS,
    identities: { runId: "prr_t", principal: "pack-runtime", hostTimestamp: "2026-08-17T00:00:00.000Z" },
  }).drafts;
}
