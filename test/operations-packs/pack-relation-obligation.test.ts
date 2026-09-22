/**
 * @file test/operations-packs/pack-relation-obligation.test.ts
 * @description G4b obligation units: the relation row authors a complete
 * Milestone A relation create from one closed draft convention (relation-type /
 * from / to structural, every other field an attribute), with BOTH postcondition
 * members derived pre-apply from the draft's own canonical content; a mixed
 * page+relation draft set authors both rows with pages FIRST and the relation
 * depending on the page its endpoints name; and the two kinds whose premises
 * still hold keep refusing by name — the refusal table must not silently narrow.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { authorPackObligation } from "../../src/operations-packs/runtime/materializer-obligation.js";
import { packPolicyContractFor } from "../../src/operations-packs/runtime/policy-contract.js";
import type { PackIntentDraftV1 } from "../../src/operations-packs/handlers/types.js";
import { canonicalBytes } from "../../src/profile/templates/signing/canonical.js";
import type { EntityId } from "../../src/profile/types.js";
import { relationContentHash } from "../../src/relations/digest.js";
import { deriveAttemptId, derivePhaseInstanceId, singleExpansionIdentity } from "../../src/preparations/ids.js";
import { draftPayloadBytes } from "../../src/operations-packs/handlers/page-payload.js";
import type { EvidenceRefV1 } from "../../src/preparations/types.js";
import { compileCitesRelationAction } from "./runtime-fixture.js";

/** One authenticated draft: the payload digest binds its own published fields. */
function draftOf(
  mutationKind: string, sourceItemId: string, fields: Record<string, string | number | boolean>,
): PackIntentDraftV1 {
  const hex = createHash("sha256")
    .update(draftPayloadBytes({ mutationKind, targetProfileClass: "wiki-page", fields }))
    .digest("hex");
  return {
    sourceItemId, mutationKind, targetProfileClass: "wiki-page",
    payloadDigest: `sha256:${hex}`, fields,
  } as unknown as PackIntentDraftV1;
}

/** The obligation input for one draft set, contract-bound to the relation action. */
async function obligationInput(drafts: readonly PackIntentDraftV1[]) {
  const action = await compileCitesRelationAction({ relationType: "cites", from: "papers/a", to: "papers/b" });
  const attemptId = deriveAttemptId(derivePhaseInstanceId({
    manifestDigest: `sha256:${"a".repeat(64)}`, logicalPhaseId: "propose",
    expansionIdentity: singleExpansionIdentity(),
  }), 0);
  const evidenceRef = {
    kind: "host-output", mediaType: "application/json", provenanceLabel: "pack-intent-compile-output",
    digest: `sha256:${"b".repeat(64)}`, byteCount: 1, sensitivity: "normal",
    retention: "until-handoff", untrusted: true,
    producer: { kind: "host", contractDigest: action.materializationSpec.handlerContractDigest },
  } as unknown as EvidenceRefV1;
  return {
    contract: packPolicyContractFor(action), drafts, evidenceRef, attemptId,
    producerContractDigest: action.materializationSpec.handlerContractDigest,
  };
}

const RELATION_FIELDS = { "relation-type": "cites", from: "papers/a", to: "papers/b", confidence: 1 } as const;

describe("G4b: the relation obligation row", () => {
  it("authors a relation create whose postcondition is derived from its own content", async () => {
    const input = await obligationInput([draftOf("relation-upsert", "source-0", { ...RELATION_FIELDS })]);
    const obligation = authorPackObligation(input);
    const mutation = obligation.targets[0]!.draft as {
      kind: string; attributes: Record<string, unknown>;
      postcondition: { digest: string; recordId: string };
    };
    expect(mutation.kind).toBe("relation");
    expect(mutation.attributes).toEqual({ confidence: 1 });
    // THE STORE'S OWN HASH, over exactly the shape it persists — a second shape
    // here would attest a quantity the store never writes.
    const expectedHex = relationContentHash({
      type: "cites", from: "papers/a" as EntityId, to: "papers/b" as EntityId,
      attributes: { confidence: 1 }, evidence: undefined,
    });
    expect(mutation.postcondition.digest).toBe(`sha256:${expectedHex}`);
    expect(mutation.postcondition.recordId).toBe(`rel_${expectedHex.slice(0, 16)}`);
    expect(obligation.payloadRefs).toHaveLength(0);
  });

  it("refuses a relation draft missing a structural member by name", async () => {
    const { "relation-type": relationType, from, confidence } = RELATION_FIELDS;
    const input = await obligationInput([draftOf("relation-upsert", "source-0", { "relation-type": relationType, from, confidence })]);
    expect(() => authorPackObligation(input)).toThrow(/required to field/);
  });

  it("authors a MIXED set pages-first with the relation depending on its endpoint page", async () => {
    const page = draftOf("artifact-upsert", "source-0", { title: "Alpha" });
    // The page's identity is entity:wiki-page:source-0; point the relation at it.
    const relation = draftOf("relation-upsert", "source-0",
      { "relation-type": "cites", from: "wiki-page/source-0", to: "papers/b" });
    const obligation = authorPackObligation(await obligationInput([relation, page]));
    expect(obligation.targets.map((target) => (target.draft as { kind: string }).kind)).toEqual(["page", "relation"]);
    expect(obligation.targets[1]!.dependsOnLogicalIdentities).toEqual(["entity:wiki-page:source-0"]);
    expect(obligation.completedIdentities).toEqual(["source-0"]);
  });

  it("keeps refusing the two kinds whose premises still hold, by name", async () => {
    for (const kind of ["projection-register", "lifecycle-transition"]) {
      const input = await obligationInput([draftOf(kind, "source-0", { title: "x" })]);
      expect(() => authorPackObligation(input), kind).toThrow(/cannot be authored/);
    }
  });
});
