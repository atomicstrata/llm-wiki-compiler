/**
 * @file test/preparation-capacity-matrix-store.test.ts
 * @description Exact cap-boundary coverage for the one durable-store capacity
 * dimension that a real operator can drive to its limit through the binary:
 * `MAX_ACTIVE_PREPARATIONS_PER_WORKSPACE` (`src/preparations/constants.ts:103`),
 * projected at `src/preparations/stage.ts:188` and enforced by
 * `assertStageCapacity` (`src/preparations/capacity.ts:102`).
 *
 * Exactly the cap is staged and every one must succeed; the next must produce
 * the typed refusal and leave a byte-identical store. Both halves are asserted,
 * so the test is red if the boundary is off by one in either direction — and
 * staging is the actor here, so a refusal that left an orphaned evidence object
 * or a manifest without its run would be invisible to `preparation list`.
 *
 * FINDING, now fixed and pinned by the last two describes: a refusal on a project
 * that has never staged used to leave a durable `preparation-runs.runkey`,
 * because resolving the key epoch MINTS one on a project that has none and it ran
 * ahead of every gate. NO refusal an operator can drive out of a first-ever stage
 * mints it now — the epoch is minted in memory and published only by the durable
 * phase. The pins here assert the exact delta in both directions: empty before
 * AND empty after, exactly one key minted on success, and a stable epoch
 * afterwards. The in-process half of the property, the key-epoch seam itself, and
 * the crash state live in `preparation-stage-residue.test.ts`.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_SEED, KEY_LEAF, controlAllowanceCeiling, expectStoreUnchanged, keyEpochOf,
  leafNames, planFor, projectWith, refusalReason, stage, stagedRunId, storeInventory,
} from "./preparation-capacity-fixture.js";
import { MAX_ACTIVE_PREPARATIONS_PER_WORKSPACE } from "../src/preparations/constants.js";
import { stagePreparationLocked } from "../src/preparations/stage.js";
import { fixturePlan, stageRequest } from "./preparations/store-fixture.js";
import type { StageDocuments } from "./preparation-capacity-fixture.js";

/** A project whose plan and seed stage one preparation per invocation. */
async function stageableProject(suffix: string): Promise<StageDocuments> {
  return projectWith(suffix, JSON.stringify(planFor(DEFAULT_SEED)), JSON.stringify(DEFAULT_SEED));
}

/**
 * Occupy `count` slots of the workspace through the staging transaction.
 *
 * The FILL is in process; both boundary crossings below stay on the binary. A
 * stage is a whole subprocess against a store that grows with every one, and
 * nine of them are setup rather than evidence — they cost more suite time than
 * every other case in this matrix combined, which is enough to push unrelated
 * subprocess tests past their own timeouts. `stagePreparationLocked` is exactly
 * what the CLI calls once it has normalized the document, so the slots it
 * occupies are the same slots the projection counts.
 */
async function occupySlots(cwd: string, count: number): Promise<void> {
  for (let filled = 0; filled < count; filled += 1) {
    const staged = await stagePreparationLocked(cwd, stageRequest(fixturePlan()));
    expect(staged.status).toBe("staged");
  }
}

describe("active preparations per workspace", () => {
  it("admits the preparation that reaches the cap and refuses the next", async () => {
    const documents = await stageableProject("capws");
    await occupySlots(documents.cwd, MAX_ACTIVE_PREPARATIONS_PER_WORKSPACE - 1);

    // The invocation that lands EXACTLY on the cap, and the one after it.
    const atCap = await stage(documents);
    const refused = await expectStoreUnchanged(documents.cwd, () => stage(documents));
    // One refusal could be a transient. The cap is a standing property of the
    // workspace, so a second attempt must refuse identically and still leave
    // nothing behind — including nothing the first refusal half-created.
    const again = await expectStoreUnchanged(documents.cwd, () => stage(documents));

    expect(stagedRunId(atCap)).toMatch(/^prr_/u);
    expect(refusalReason(refused))
      .toBe("staging refused: preparation staging exceeds the workspace-preparations cap");
    expect(refusalReason(again)).toBe(refusalReason(refused));
  }, 120_000);
});

/**
 * Every refusal an operator can drive out of a first-ever stage through the binary.
 *
 * The two are structurally DIFFERENT, which is why both are needed. The allowance
 * is proven from the plan alone, so its gate sits ahead of the key epoch outright.
 * The supersession edge resolves against the manifest, which binds the epoch id,
 * so its gate can only run once the epoch exists — it is green because the epoch
 * is minted in memory and published later, not because anything moved.
 */
const FIRST_STAGE_REFUSALS = [
  {
    label: "the declared control allowance",
    planText: () => JSON.stringify(planFor(DEFAULT_SEED)),
    extraArgs: () => ["--allowance", String(controlAllowanceCeiling() + 1)],
    reason: /control transition allowance exceeds/u,
  },
  {
    label: "an unresolvable supersession edge",
    planText: () => JSON.stringify(planFor(DEFAULT_SEED, (plan) => {
      plan.supersedesPreparationId = `prp_${"a".repeat(32)}`;
    })),
    extraArgs: () => [],
    reason: /supersedes a dangling target/u,
  },
] as const;

describe("residue left by a refusal on a never-staged project", () => {
  for (const [index, refusal] of FIRST_STAGE_REFUSALS.entries()) {
    it(`leaves the store exactly as it found it: ${refusal.label}`, async () => {
      // The reason string is load-bearing as a DEPTH probe: both are raised
      // inside the staging transaction, so a refusal short-circuited earlier by
      // document validation could not produce either one and this would not pass
      // for a store the command never opened.
      const documents = await projectWith(
        `capkey-residue-${index}`, refusal.planText(), JSON.stringify(DEFAULT_SEED),
      );
      const before = await storeInventory(documents.cwd);

      const refused = await stage(documents, refusal.extraArgs());

      expect(refusalReason(refused)).toMatch(refusal.reason);
      // Both directions, named. Asserting only `after == before` would pass on a
      // store that was already dirty, and asserting only emptiness afterwards
      // would pass if the refusal had deleted something it found.
      expect(before).toEqual([]);
      expect(await storeInventory(documents.cwd)).toEqual([]);
      expect(await keyEpochOf(documents.cwd)).toBeNull();
    });
  }

  it("mints exactly one key epoch on success and keeps it stable", async () => {
    // The other half of the same property: the reorder must not have moved the
    // mint out of the SUCCESS path. A staged preparation still mints, and the
    // second staging reuses that epoch rather than minting a second one.
    const documents = await stageableProject("capkey-mint-once");
    expect(await storeInventory(documents.cwd)).toEqual([]);

    expect((await stagePreparationLocked(documents.cwd, stageRequest(fixturePlan()))).status).toBe("staged");
    const minted = await keyEpochOf(documents.cwd);
    expect((await stagePreparationLocked(documents.cwd, stageRequest(fixturePlan()))).status).toBe("staged");

    expect(minted).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(await keyEpochOf(documents.cwd)).toBe(minted);
    expect(leafNames(await storeInventory(documents.cwd)).filter((leaf) => leaf === KEY_LEAF)).toEqual([KEY_LEAF]);
  }, 60_000);

  it("leaves a store that already holds a key byte-identical on a refusal", async () => {
    // The second-stage case. `expectStoreUnchanged` is vacuous on an empty store,
    // so the precondition — a key and a whole staged preparation already on disk
    // — is asserted rather than assumed.
    const documents = await stageableProject("capkey-second");
    expect((await stagePreparationLocked(documents.cwd, stageRequest(fixturePlan()))).status).toBe("staged");
    expect(leafNames(await storeInventory(documents.cwd))).toContain(KEY_LEAF);

    const refused = await expectStoreUnchanged(documents.cwd, () =>
      stage(documents, ["--allowance", String(controlAllowanceCeiling() + 1)]));

    expect(refusalReason(refused)).toMatch(/control transition allowance exceeds/u);
  }, 60_000);
});
