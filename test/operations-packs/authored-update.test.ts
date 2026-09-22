/**
 * @file test/operations-packs/authored-update.test.ts
 * @description Authoring a page UPDATE (AS-1 §4.7's "update a field").
 *
 * AN UPDATE IS ONLY SAFE BECAUSE OF ITS PRECONDITION. Proposal and apply are
 * separated in time, so an update authored against page bytes that have since
 * changed must CONFLICT rather than overwrite — otherwise a reviewed edit
 * silently clobbers whatever the page became in between. The precondition is
 * the digest of the bytes the draft was computed against, carried from the
 * reconcile snapshot, and these cases pin that it is present and correct.
 *
 * AN UPDATE WITH NO SOURCEABLE PRECONDITION IS REFUSED, not downgraded to a
 * create or authored unconstrained: both would be blind overwrites of a page
 * the operator never saw.
 */

import { describe, expect, it } from "vitest";
import { compileIntents } from "../../src/operations-packs/handlers/intent-compile.js";
import {
  CURRENT_BYTES_FIELD, CURRENT_DIGEST_FIELD,
} from "../../src/operations-packs/runtime/store-snapshot.js";
import type { PackEvidenceItemV1 } from "../../src/operations-packs/handlers/types.js";
import type { IntentPhaseBodyV2 } from "../../src/operations-packs/recipe-types.js";

const BOUNDS = { maximumItems: 16, maximumOutputBytes: 65_536 } as const;
const IDENTITIES = { runId: "prr_t", principal: "pack-runtime", hostTimestamp: "2026-08-17T00:00:00.000Z" };
const DIGEST = "a".repeat(64);

/** An intent body drafting an update of one page field. */
function updateBody(): IntentPhaseBodyV2 {
  return {
    intentTemplateRef: "intent.wiki-artifact",
    intents: [{
      mutationKind: "artifact-update", targetProfileClass: "papers",
      fieldMappings: [
        { targetField: "title", source: "phase-input", ref: "title" },
        { targetField: "stage", source: "phase-input", ref: "stage" },
      ],
    }],
  } as unknown as IntentPhaseBodyV2;
}

/** An intent body removing one page. */
function deleteBody(): IntentPhaseBodyV2 {
  return {
    intentTemplateRef: "intent.wiki-artifact",
    intents: [{
      mutationKind: "artifact-delete", targetProfileClass: "papers",
      fieldMappings: [
        { targetField: "title", source: "phase-input", ref: "title" },
        { targetField: "stage", source: "phase-input", ref: "stage" },
      ],
    }],
  } as unknown as IntentPhaseBodyV2;
}

/** One compared item, optionally carrying the on-disk identity. */
function compared(withCurrent: boolean): PackEvidenceItemV1 {
  return {
    itemId: "source-0",
    fields: {
      title: "Alpha effects", stage: "reviewed",
      ...(withCurrent ? { [CURRENT_DIGEST_FIELD]: DIGEST, [CURRENT_BYTES_FIELD]: 128 } : {}),
    },
  };
}

/** Compile one update draft from the given evidence. */
function draftFrom(item: PackEvidenceItemV1) {
  return compileIntents({ body: updateBody(), evidence: [item], bounds: BOUNDS, identities: IDENTITIES });
}

describe("authoring an artifact-update", () => {
  it("carries the on-disk digest it was computed against as its precondition", () => {
    const draft = draftFrom(compared(true)).drafts[0]!;
    expect(draft.mutationKind).toBe("artifact-update");
    expect(draft.expectedCurrent).toEqual({ digest: DIGEST, byteCount: 128 });
  });

  it("REFUSES when the evidence carries no current digest", () => {
    // Never downgraded to a create and never authored unconstrained: both are
    // blind overwrites of a page the operator never saw.
    expect(() => draftFrom(compared(false)))
      .toThrow(/no current-page digest/);
  });

  it("writes every mapped field, so an update cannot silently drop one", () => {
    // The dangerous case is not a mismatched precondition — that parks — but a
    // payload that quietly loses fields the page already had.
    const draft = draftFrom(compared(true)).drafts[0]!;
    expect(draft.fields).toEqual({ title: "Alpha effects", stage: "reviewed" });
  });
});

describe("an update draft compiled through the REAL reconcile output", () => {
  it("sources its precondition from reconcile, not from hand-built evidence", async () => {
    // The control this suite was missing. Its other cases construct the
    // reserved on-disk fields themselves, which passes even when reconcile
    // never publishes them — exactly the bypass that let an unreachable
    // `artifact-update` look tested.
    const { reconcileEvidence } = await import("../../src/operations-packs/handlers/reconcile.js");
    const stored: PackEvidenceItemV1 = {
      itemId: "source-0",
      fields: {
        title: "Alpha effects", stage: "reviewed",
        [CURRENT_DIGEST_FIELD]: DIGEST, [CURRENT_BYTES_FIELD]: 128,
      },
    };
    const compared = reconcileEvidence({
      body: {
        reconcilePolicyId: "reconcile.default", comparedEvidenceClass: "papers",
        findingClasses: ["absent", "identical", "conflicting"],
      },
      proposed: [{ itemId: "source-0", fields: { title: "Alpha effects", stage: "reviewed" } }],
      snapshot: [stored], bounds: BOUNDS,
    } as never);

    const draft = compileIntents({
      body: updateBody(), evidence: compared.items, bounds: BOUNDS, identities: IDENTITIES,
    }).drafts[0]!;
    expect(draft.expectedCurrent).toEqual({ digest: DIGEST, byteCount: 128 });
  });

  it("formats its payload as a PAGE, never as canonical JSON", async () => {
    // An update authored as a page write whose payload was JSON would overwrite
    // the markdown page with JSON on apply.
    const { draftPayloadBytes } = await import("../../src/operations-packs/handlers/page-payload.js");
    const bytes = draftPayloadBytes({
      mutationKind: "artifact-update", targetProfileClass: "papers",
      fields: { title: "Alpha effects", stage: "reviewed" },
    } as never).toString("utf8");
    expect(bytes.startsWith("---")).toBe(true);
    expect(bytes).toContain("title:");
  });
});

describe("authoring an artifact-delete", () => {
  it("carries the on-disk digest it was computed against, like an update", () => {
    const draft = compileIntents({
      body: deleteBody(), evidence: [compared(true)], bounds: BOUNDS, identities: IDENTITIES,
    }).drafts[0]!;
    expect(draft.mutationKind).toBe("artifact-delete");
    expect(draft.expectedCurrent).toEqual({ digest: DIGEST, byteCount: 128 });
  });

  it("REFUSES without a precondition — a delete of a page nobody saw", () => {
    expect(() => compileIntents({
      body: deleteBody(), evidence: [compared(false)], bounds: BOUNDS, identities: IDENTITIES,
    })).toThrow(/no current-page digest/);
  });
});
