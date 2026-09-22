/**
 * @file test/preparation-sdk-authority.test.ts
 * @description R-5 / D-10-9, as the ONE test this whole lane is gated on: the
 * SDK principal is genuinely narrower than the local operator, and the grant
 * check refuses when a grant is missing.
 *
 * WHY IT HAD TO BE THE SDK. `effectivePreparationGrants` unions the entire
 * local-operator set into any `cli` principal (`principals.ts:149`), so the
 * grant check on the CLI path CANNOT fail — the shipped commands say so in
 * their own comments. A check that cannot fail is not evidence of
 * authorization, and every "the grant is enforced" claim made before a second
 * surface existed was unfalsifiable. An `sdk` principal holds exactly its
 * explicit grants, so here the check has a red state to reach.
 *
 * THE PAIR IS THE POINT. The first test observes the refusal; the second makes
 * the single-field mutation that should remove it — one grant in the
 * constructor — and watches the same call succeed. Either alone proves nothing:
 * a refusal test passes against code that refuses everything, and a success test
 * passes against code that authorizes everything.
 *
 * AND THE REFUSAL IS OBSERVED ON DISK, not only in the throw. A throw can be
 * raised after the work has already committed, so `expectMissingGrant` re-reads
 * the run's durable state as part of the same assertion.
 *
 * The PROTOTYPE-CHAIN variants of these refusals live in the sibling file
 * `preparation-sdk-prototype-authority.test.ts`; an unpolluted suite cannot
 * distinguish the fixed facade from the broken one.
 */

import { describe, expect, it } from "vitest";
import { createWiki } from "../src/sdk/wiki.js";
import type { PreparationGrant } from "../src/preparations/service.js";
import {
  MUTATING_GRANTS, expectMissingGrant, expectRunFailed, expectStagedBy, lastTransitionActor,
  projectWithRun, stageDocuments, stageableProject,
} from "./preparation-sdk-fixture.js";

/** A project with one `planned` run, plus an SDK facade over it. */
async function sdkOver(suffix: string, grants: readonly PreparationGrant[]) {
  const { cwd, binding } = await projectWithRun(suffix);
  return { cwd, binding, wiki: createWiki({ root: cwd, preparation: { id: "sdk-test", grants } }) };
}

describe("an SDK principal holds only what it was granted", () => {
  it("REFUSES a mutation it has no grant for, and the run does not move", async () => {
    const { cwd, binding, wiki } = await sdkOver("sdkfailnogrant", []);
    await expectMissingGrant(wiki.failPreparation(binding.runId), cwd, binding);
  });

  it("STOPS refusing when the missing grant is present — the mutation", async () => {
    const { cwd, binding, wiki } = await sdkOver("sdkfailgrant", MUTATING_GRANTS);
    await expectRunFailed(wiki.failPreparation(binding.runId), cwd, binding);
  });

  it("defaults to NO grants when the embedder names none", async () => {
    // Fail closed: an embedder that says nothing about authority gets none,
    // rather than inheriting whatever the process happens to be able to do.
    const { cwd, binding } = await projectWithRun("sdkdefault");
    const wiki = createWiki({ root: cwd });
    await expectMissingGrant(wiki.failPreparation(binding.runId), cwd, binding);
  });

  it("COPIES the embedder's grants array rather than aliasing it", async () => {
    // The service re-reads the principal's grants on every call, so an alias is
    // a live channel: `push` after construction would escalate a facade that
    // had already been built fail-closed. Aliasing instead of copying survives
    // the entire suite without this.
    const { cwd, binding } = await projectWithRun("sdkgrantsalias");
    const grants: PreparationGrant[] = [];
    const wiki = createWiki({ root: cwd, preparation: { id: "sdk-test", grants } });

    grants.push("preparation.run");

    await expectMissingGrant(wiki.failPreparation(binding.runId), cwd, binding);
  });

  it("READS without any grant at all", async () => {
    // D-10-13 makes `list` grant-free, and this is what makes the refusals above
    // statements about the GRANT rather than about the facade being misbuilt: an
    // ungranted principal reaches the service perfectly well for a read.
    const { binding, wiki } = await sdkOver("sdkread", []);
    const listing = await wiki.listPreparations();
    expect(listing.runs.map((row) => row.runId)).toContain(binding.runId);
  });
});

describe("staging through the SDK is charged the same grant", () => {
  it("REFUSES to stage without the grant, leaving no run behind", async () => {
    const cwd = await stageableProject("sdkstagenogrant");
    const wiki = createWiki({ root: cwd, preparation: { grants: [] } });
    await expect(wiki.stagePreparation(await stageDocuments())).rejects.toMatchObject({
      code: "missing-grant",
    });
    // Nothing was staged — read back through a facade that could have seen it.
    const listing = await createWiki({ root: cwd }).listPreparations();
    expect(listing.runs).toEqual([]);
  });

  it("STAGES once the grant is present — the mutation", async () => {
    const cwd = await stageableProject("sdkstagegrant");
    const wiki = createWiki({ root: cwd, preparation: { grants: MUTATING_GRANTS } });
    const result = await wiki.stagePreparation(await stageDocuments());
    expect(result.status).toBe("staged");
  });

  it("records the SDK identity on a FAIL transition too, not only on staging", async () => {
    // THE SIBLING GAP, found by grepping this suite for per-operation controls
    // after the capture-before-await one turned out to cover `fail` and not
    // `stage`. The actor assertion had the mirror-image hole: staging was
    // checked, and the transition `fail` writes — which calls
    // `preparationRunActor(principal)` at its own separate seam — was not.
    // Hardcoding an actor in `service-fail.ts` would have survived.
    const { cwd, binding } = await projectWithRun("sdkfailactor");
    const wiki = createWiki({
      root: cwd, preparation: { id: "embedder-9", grants: MUTATING_GRANTS },
    });
    await expectRunFailed(wiki.failPreparation(binding.runId), cwd, binding);
    expect(await lastTransitionActor(cwd, binding))
      .toMatchObject({ id: "embedder-9", surface: "sdk" });
  });

  it("records the SDK identity as the actor, never the CLI operator", async () => {
    // The principal is the SERVICE's, not a borrowed one: a facade that reused
    // the local-operator principal would stage successfully and write
    // `cli-operator` onto the durable record.
    const cwd = await stageableProject("sdkactor");
    const wiki = createWiki({
      root: cwd, preparation: { id: "embedder-7", grants: MUTATING_GRANTS },
    });
    await expectStagedBy(wiki, cwd, { id: "embedder-7", surface: "sdk" });
  });
});
