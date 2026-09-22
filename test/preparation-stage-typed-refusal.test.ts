/**
 * @file test/preparation-stage-typed-refusal.test.ts
 * @description The manifest loader's rejections are REFUSALS at the
 * pre-publication call site and FAULTS at the write call site, and the typed
 * problems it passes through keep their identity.
 *
 * WHY THE CALL SITE IS THE UNIT, NOT THE LOADER. `parsePreparationManifest` is
 * reached twice in one staging transaction: `materializeManifest` re-parses the
 * candidate before anything is written, and `manifest-store` re-parses the same
 * text again on the way to disk — AFTER the initial evidence is durable. The
 * typed refusal is only honest at the first. A refusal tells a caller nothing
 * happened, so typing the second would report `refused` over evidence already on
 * disk, which is what the last describe block pins.
 *
 * WHAT CLOSES THE CHAIN. Not the service test below — that one is green with the
 * retype reverted, because its error is natively `PreparationPlanError`, and it
 * is here to pin PRE-EXISTING behaviour rather than the change. What closes it is
 * structural: the loader mints a member of `PREPARATION_VALIDATION_PROBLEMS` and
 * the service's allowlist is BUILT from that same tuple, asserted directly
 * rather than inferred across two tests.
 */

import { describe, expect, it } from "vitest";
import { useTempRoot } from "./fixtures/temp-root.js";
import { canonicalBytes } from "../src/profile/templates/signing/canonical.js";
import { createWiki } from "../src/sdk/wiki.js";
import { parsePreparationManifest, type PreparationManifestV1 } from "../src/preparations/manifest-parse.js";
import { writePreparationManifestCreateOnly } from "../src/preparations/manifest-store.js";
import {
  PREPARATION_VALIDATION_PROBLEMS, PreparationBoundsError,
  PreparationIdentityError, PreparationPlanError,
} from "../src/preparations/problems.js";
import { STAGE_REFUSALS } from "../src/preparations/service-stage.js";
import { stagePreparationLocked } from "../src/preparations/stage.js";
import { fixturePlan, SEED_VALUE, seedInput, stageRequest } from "./preparations/store-fixture.js";
import { MUTATING_GRANTS, stageableProject } from "./preparation-sdk-fixture.js";
import type { PreparationInitialInputV1 } from "../src/preparations/initial-inputs.js";

const root = useTempRoot();

/**
 * A facade holding the grants staging costs.
 *
 * The grant set comes from the shared SDK fixture rather than a literal here: a
 * copy that drifted would silently start testing an ungranted caller, and the
 * refusal it produced would look exactly like the one this suite is about.
 */
function grantedWiki(cwd: string) {
  return createWiki({ root: cwd, preparation: { id: "sdk-test", grants: [...MUTATING_GRANTS] } });
}

/** Stage the fixture for real, returning the manifest the host built. */
async function stagedManifest(): Promise<PreparationManifestV1> {
  const staged = await stagePreparationLocked(root.dir, stageRequest());
  if (staged.status !== "staged") throw new Error(`fixture did not stage: ${staged.status}`);
  return staged.manifest;
}

/** Re-parse a durable manifest with one field perturbed, returning the throw. */
function reparseThrow(manifest: PreparationManifestV1, mutate: (root: Record<string, unknown>) => void): unknown {
  const object = JSON.parse(JSON.stringify(manifest)) as Record<string, unknown>;
  mutate(object);
  try {
    parsePreparationManifest(canonicalBytes(object).toString("utf8"));
  } catch (error) { return error; }
  return null;
}

/**
 * Stage one descriptor through the substrate seam, returning what it threw.
 *
 * THE GUARD IS THE INLINE `staged` ASSERTION, not the genesis stage. A dry run
 * against a project with no key epoch PARKS before `prepareStage` — it does not
 * throw — so without that assertion a probe that never reached the loader
 * returns `null` and reads as "admitted". The genesis stage is what makes the
 * key epoch exist; the assertion is what proves the probe got past it. Deleting
 * either one leaves the pin below passing while it covers nothing.
 */
async function stageThrow(inputs: readonly PreparationInitialInputV1[]): Promise<unknown> {
  await stagePreparationLocked(root.dir, stageRequest());
  try {
    const staged = await stagePreparationLocked(root.dir, stageRequest(fixturePlan(), {
      initialInputs: [...inputs], dryRun: true,
    }));
    expect(staged.status).toBe("staged");
  } catch (error) { return error; }
  return null;
}

describe("the loader types the rejections a staging caller can drive", () => {
  it("admits the descriptor the plan declares, having reached the loader", async () => {
    expect(await stageThrow([seedInput()])).toBeNull();
  });

  it("types an evidence label over its bounded-string cap", async () => {
    const caught = await stageThrow([seedInput({ provenanceLabel: "x".repeat(2_048) })]);

    expect(caught).toBeInstanceOf(PreparationPlanError);
    expect((caught as Error).message).toContain("provenanceLabel");
  });

  it("types an evidence field outside its closed enum", async () => {
    const caught = await stageThrow([seedInput({ retention: "forever" })]);

    expect(caught).toBeInstanceOf(PreparationPlanError);
    expect((caught as Error).message).toContain("retention");
  });
});

describe("problems that already carry a dimension pass through intact", () => {
  it("keeps an identity problem's kind and exact message", async () => {
    // Not decoration: the retype flattens an error into a message, so a class
    // that already names its own field has to be excluded from it. Comparing
    // against the same error raised directly is what proves nothing was lost.
    const caught = reparseThrow(await stagedManifest(), (object) => { object.preparationId = "prp_not_a_real_id"; });

    expect(caught).toBeInstanceOf(PreparationIdentityError);
    expect((caught as PreparationIdentityError).kind).toBe("preparation-id");
    expect((caught as Error).message).toBe(new PreparationIdentityError("preparation-id").message);
  });

  it("keeps a bounds problem's dimension and exact message", async () => {
    const caught = reparseThrow(await stagedManifest(), (object) => {
      ((object.plan as Record<string, unknown>).bounds as Record<string, number>).maximumTransitions = 0;
    });

    expect(caught).toBeInstanceOf(PreparationBoundsError);
    expect((caught as PreparationBoundsError).dimension).toBe("transitions");
    expect((caught as Error).message).toBe(new PreparationBoundsError("transitions").message);
  });
});

describe("the allowlist and the loader share one enumeration", () => {
  it("admits the class the loader mints", () => {
    // The structural half of the chain: no inference across two behaviour tests.
    expect(STAGE_REFUSALS).toContain(PreparationPlanError);
  });

  it("is built from the validation tuple rather than restating it", () => {
    expect(STAGE_REFUSALS.slice(0, PREPARATION_VALIDATION_PROBLEMS.length))
      .toEqual([...PREPARATION_VALIDATION_PROBLEMS]);
  });
});

describe("the service returns that class as a refusal envelope", () => {
  it("refuses rather than throws when the loader rejects the manifest", async () => {
    // PRE-EXISTING behaviour, pinned so the surface cannot flatten it — this is
    // green with the retype reverted. The exact string matters: `toContain`
    // would also match the parked arm, which is a different outcome entirely.
    const cwd = await stageableProject("stagetypedrefusal");

    const result = await grantedWiki(cwd).stagePreparation({
      planDocument: JSON.stringify(fixturePlan()),
      seedDocument: JSON.stringify({ seed: "not-the-declared-input" }),
    });

    expect(result).toEqual({
      status: "refused",
      reason: "staging refused: preparation manifest initial evidence omits the plan input set",
    });
  });

  it("still stages the matching seed, so the refusal above is the seed's doing", async () => {
    const cwd = await stageableProject("stagetypedrefusalok");

    const result = await grantedWiki(cwd).stagePreparation({
      planDocument: JSON.stringify(fixturePlan()), seedDocument: JSON.stringify(SEED_VALUE),
    });

    expect(result).toMatchObject({ status: "staged" });
  });
});

describe("the write path refuses to call a late rejection a refusal", () => {
  it("faults rather than refuses when the publish-site re-parse rejects", async () => {
    // Staging materializes evidence BEFORE this write, so a typed throw here
    // would convert to `refused` — "nothing happened" — over durable bytes.
    const manifest = await stagedManifest();
    const broken = JSON.parse(JSON.stringify(manifest)) as PreparationManifestV1;
    broken.initialEvidence[0]!.provenanceLabel = "x".repeat(2_048);

    const caught = await writePreparationManifestCreateOnly(root.dir, broken)
      .then(() => null, (error: unknown) => error);

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("provenanceLabel");
    // DERIVED, not a hand-written class list: a problem added to the tuple is
    // covered here the day it exists.
    expect(PREPARATION_VALIDATION_PROBLEMS.some((problem) => caught instanceof problem)).toBe(false);
  });
});
