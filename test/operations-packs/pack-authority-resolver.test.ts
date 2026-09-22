/**
 * @file test/operations-packs/pack-authority-resolver.test.ts
 * @description THE SLICE-3 STOP GATE. The attempt executor seals the authority
 * under the lock at intent and RE-RESOLVES it under the lock at leg K, committing
 * only when the two snapshots agree (design section 15.3). That comparison is
 * evidence of nothing unless the resolver actually recomputes from authoritative
 * current state — a resolver returning a baked constant compares equal to itself
 * forever and makes the whole gate tautological.
 *
 * So these cases do not assert that two calls agree and stop there. They stage a
 * REAL run, then move the persisted input exposure three different ways and
 * require the digest to follow: a rewritten declaration in the durable manifest
 * DRIFTS it, a different sealed caller input DRIFTS it, and a missing evidence
 * object fails the resolution CLOSED rather than resolving to anything at all.
 */

import { rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalBytes } from "../../src/profile/templates/signing/canonical.js";
import { createPackAuthorityResolver } from "../../src/operations-packs/runtime/authority-resolver.js";
import { derivePhaseInstanceId, singleExpansionIdentity } from "../../src/preparations/ids.js";
import { readPreparationManifest } from "../../src/preparations/manifest-store.js";
import { preparationPaths } from "../../src/preparations/paths.js";
import type {
  AttemptAuthorityContextV1, AttemptAuthorityResolutionV1,
} from "../../src/preparations/attempts/types.js";
import { stagedRunTracker, type StagedPackRunV1 } from "./runtime-fixture.js";

const runs = stagedRunTracker();
const stageAction = (topic?: string): Promise<StagedPackRunV1> => runs.stage(topic);

afterEach(() => runs.cleanupAll());

/** The exact phase identity the attempt executor would resolve authority for. */
function contextFor(run: StagedPackRunV1): AttemptAuthorityContextV1 {
  const phase = run.action.plan.phases[0]!;
  return {
    executor: phase.executor!, logicalPhaseId: phase.logicalPhaseId,
    phaseInstanceId: derivePhaseInstanceId({
      manifestDigest: run.binding.manifestDigest, logicalPhaseId: phase.logicalPhaseId,
      expansionIdentity: singleExpansionIdentity(),
    }),
  };
}

/** Resolve the authority extras for one staged run, as the executor would. */
function resolve(run: StagedPackRunV1): Promise<AttemptAuthorityResolutionV1> {
  return createPackAuthorityResolver({ root: run.root, binding: run.binding }).resolve(contextFor(run));
}

/** The recomputed exposure digest, or a loud failure naming the refusal. */
async function exposureDigest(run: StagedPackRunV1): Promise<string> {
  const resolution = await resolve(run);
  if (resolution.status !== "ok") throw new Error(`unavailable: ${resolution.reason}`);
  return resolution.extras.inputExposureSetDigest;
}

/**
 * Rewrite the persisted manifest with one initial-input DECLARATION changed. The
 * bytes stay canonical and the identity binding intact, so the manifest still
 * loads — only the recorded exposure of the input has moved.
 */
async function mutatePersistedExposure(run: StagedPackRunV1): Promise<void> {
  const read = await readPreparationManifest(run.root, run.binding.workspaceId, run.binding.preparationId);
  if (read.status !== "ok") throw new Error(`manifest ${read.status}`);
  const mutated = {
    ...read.manifest,
    initialEvidence: read.manifest.initialEvidence.map((ref) => ({ ...ref, sensitivity: "private" as const })),
  };
  const paths = preparationPaths(run.root, run.binding.workspaceId);
  await writeFile(paths.manifestFile(run.binding.preparationId), canonicalBytes(mutated));
}

describe("pack authority resolver: the seal-versus-leg-K drift gate", () => {
  it("resolves the SAME exposure digest twice for an unchanged run", async () => {
    const run = await stageAction();

    const seal = await exposureDigest(run);
    const legK = await exposureDigest(run);

    expect(legK).toBe(seal);
    expect(seal).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("DRIFTS when the persisted input exposure is rewritten", async () => {
    const run = await stageAction();
    const seal = await exposureDigest(run);

    await mutatePersistedExposure(run);
    const legK = await exposureDigest(run);

    // A constant resolver reddens exactly here: this is the difference the attempt
    // executor compares, and without it a late result would commit under authority
    // the project no longer records.
    expect(legK).not.toBe(seal);
  });

  it("DRIFTS when the sealed caller input itself differs", async () => {
    // The declarations above are metadata; this moves the INPUT VALUE, so a
    // resolver binding only the manifest's shape and not its content also reddens.
    const first = await exposureDigest(await stageAction("superconductivity"));
    const second = await exposureDigest(await stageAction("ferromagnetism"));

    expect(second).not.toBe(first);
  });

  it("fails CLOSED when a declared initial input is no longer durable", async () => {
    const run = await stageAction();
    const declared = run.action.plan.initialInputSet.digest.replace("sha256:", "");
    const paths = preparationPaths(run.root, run.binding.workspaceId);
    await rm(paths.evidenceFile(run.binding.preparationId, declared));

    expect(await resolve(run)).toEqual({ status: "unavailable", reason: "initial-input-absent" });
  });

  it("declares the exposure digest and NOTHING else", async () => {
    // An allowlist, not a denylist: this action resolves no provider pin, grant,
    // effect plan, broker plan, or backend readiness, and a placeholder in any of
    // them would seal an authority the run does not have.
    const resolution = await resolve(await stageAction());

    expect(resolution.status).toBe("ok");
    expect(Object.keys(resolution.status === "ok" ? resolution.extras : {})).toEqual(["inputExposureSetDigest"]);
  });
});
