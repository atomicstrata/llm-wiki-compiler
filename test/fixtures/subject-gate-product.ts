/**
 * @file test/fixtures/subject-gate-product.ts
 * @description Shared product fixture for verifier-receipt and subject-gate
 * tests. It declares one artifact-producing stage followed by one human gate
 * bound to the process-pinned verifier receipt for that artifact.
 */

import { activateProductLocked } from "../../src/products/binding/activate.js";
import { startProductWorkflow } from "../../src/workflows/start.js";
import { submitStageOutput } from "../../src/workflows/stage-output.js";
import { verifierImplementationDigest } from "../../src/workflows/verifier-registry.js";
import {
  buildActivatableProduct, commitBuilt, FIXTURE_PRINCIPAL,
} from "../products/binding-fixture.js";

export const SUBJECT_VERIFIER_ID = "covered-items/v1";
export const SUBJECT_IMPLEMENTATION_DIGEST = verifierImplementationDigest(
  SUBJECT_VERIFIER_ID, "subject-gate-test-v1",
);

const PROCESS = JSON.stringify({
  schemaVersion: 1, processId: "editorial/v1", terminalDispositions: [],
  verifierImplementations: [{
    verifierId: SUBJECT_VERIFIER_ID, implementationDigest: SUBJECT_IMPLEMENTATION_DIGEST,
  }],
});

const PROFILE = {
  schemaVersion: 1, profileId: "editorial",
  entities: { docs: { directory: "wiki/docs", fields: { title: { type: "string" } } } },
  artifacts: { snapshot: { fileName: "snapshot.json", contentKind: "json", maxBytes: 4096 } },
  workflows: { build: { stages: [
    { id: "check", reads: ["docs"], writes: [], artifactWrites: ["snapshot"] },
    { id: "review", reads: ["docs"], writes: [], gate: "human:editor", subjectGate: {
      outputStageId: "check", artifactType: "snapshot", verifierId: SUBJECT_VERIFIER_ID,
    } },
  ] } },
};

/** Activate the shared process-bound product. */
export async function activateSubjectGateProduct(root: string): Promise<void> {
  const product = buildActivatableProduct("Editorial", PROCESS, PROFILE);
  const digest = await commitBuilt(root, product);
  await activateProductLocked(root, digest, FIXTURE_PRINCIPAL);
}

/** Start a run and record one healthy snapshot artifact on its first stage. */
export async function recordSubjectSnapshot(
  root: string, body = '{"coverage":"complete"}', slug = "review-one",
) {
  process.env.LLMWIKI_TRUSTED_WRITE = "*";
  await activateSubjectGateProduct(root);
  const run = await startProductWorkflow(root, "desk-one", "build", {});
  return submitStageOutput(root, run.runId, {
    kind: "artifact", artifactType: "snapshot", slug, body,
  });
}
