/**
 * @file test/preparation-sdk-prune-sweep.test.ts
 * @description The SDK half of the destructive pair: `prunePreparation` and
 * `sweepPreparations` are reachable by an embedder, and reachable ONLY with the
 * destructive grant.
 *
 * WHY THE GRANT PAIR IS THE WHOLE FILE'S SPINE (R-5). These two cost
 * `preparation.quarantine`, NOT the `preparation.run` token that stages and
 * fails runs, and that separation is the only thing standing between "this
 * embedder may work with preparations" and "this embedder may irreversibly
 * delete their bytes". So each verb is tested twice: refused with the run grant
 * alone, and succeeding once the destructive token is added. Either half alone
 * is satisfied by code that refuses everything or authorizes everything, and the
 * mutation between them is a single constructor field.
 *
 * THE REFUSALS ARE OBSERVED ON DISK. A throw can be raised after the work has
 * committed, so every refusal here re-reads the store and asserts the bytes are
 * still there — which for a delete is the assertion that actually matters.
 */

import { readFile, rm } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createWiki } from "../src/sdk/wiki.js";
import type { PreparationGrant } from "../src/preparations/service.js";
import { preparationPaths, preparationPruneUnitPaths } from "../src/preparations/paths.js";
import { scanPreparationInventory } from "../src/preparations/capacity.js";
import { emptyWorkspace } from "./preparation-cli-fixture.js";
import { driveToFailed, stagePreparation } from "./preparations/lifecycle-fixture.js";

/** The token this operation family costs, so no test guesses it. */
const DESTRUCTIVE_GRANTS: readonly PreparationGrant[] = ["preparation.quarantine"];
/** The token that stages and drives runs — deliberately NOT enough to delete. */
const RUN_GRANTS: readonly PreparationGrant[] = ["preparation.run"];
/** Far enough in the past that the thirty-day floor is cleared by real time. */
const LONG_AGO = "2026-01-01T00:00:00.000Z";

/** A project holding one prunable terminal run, with an SDK facade over it. */
async function prunableSdk(suffix: string, grants: readonly PreparationGrant[]) {
  const cwd = await emptyWorkspace(suffix);
  const { binding } = await stagePreparation(cwd);
  await driveToFailed(cwd, binding, LONG_AGO);
  return { cwd, runId: binding.runId, wiki: createWiki({ root: cwd, preparation: { id: "sdk-test", grants } }) };
}

/** A project holding one provably-orphaned preparation, with an SDK facade. */
async function orphanedSdk(suffix: string, grants: readonly PreparationGrant[]) {
  const cwd = await emptyWorkspace(suffix);
  const { binding } = await stagePreparation(cwd);
  await rm(preparationPaths(cwd, binding.workspaceId).runFile(binding.runId), { force: true });
  return { cwd, wiki: createWiki({ root: cwd, preparation: { id: "sdk-test", grants } }) };
}

/** The actor a completed lifecycle receipt durably attests. */
async function receiptActor(cwd: string, unitId: string): Promise<unknown> {
  const receipt = JSON.parse(await readFile(
    preparationPruneUnitPaths(cwd, unitId).completedReceiptFile, "utf8",
  )) as { actor: { id: string; surface: string } };
  return receipt.actor;
}

/** How many preparations the store still holds — the refusal's real assertion. */
async function manifestCount(cwd: string): Promise<number> {
  return (await scanPreparationInventory(cwd)).manifests.length;
}

describe("prune requires the destructive grant, not the run grant", () => {
  it("REFUSES an embedder holding only `preparation.run`, and deletes nothing", async () => {
    const { cwd, runId, wiki } = await prunableSdk("sdkprunenogrant", RUN_GRANTS);
    await expect(wiki.prunePreparation(runId)).rejects.toMatchObject({ code: "missing-grant" });
    expect(await manifestCount(cwd)).toBe(1);
  });

  it("STOPS refusing when the destructive grant is present — the mutation", async () => {
    const { cwd, runId, wiki } = await prunableSdk("sdkprunegrant", DESTRUCTIVE_GRANTS);
    expect(await wiki.prunePreparation(runId)).toMatchObject({ status: "pruned", runId });
    expect(await manifestCount(cwd)).toBe(0);
  });

  it("defaults to no grants at all when the embedder names none", async () => {
    const { cwd, runId, wiki } = await prunableSdk("sdkprunedefault", []);
    await expect(wiki.prunePreparation(runId)).rejects.toMatchObject({ code: "missing-grant" });
    expect(await manifestCount(cwd)).toBe(1);
  });
});

describe("sweep requires the destructive grant, not the run grant", () => {
  it("REFUSES an embedder holding only `preparation.run`, and deletes nothing", async () => {
    const { cwd, wiki } = await orphanedSdk("sdksweepnogrant", RUN_GRANTS);
    await expect(wiki.sweepPreparations()).rejects.toMatchObject({ code: "missing-grant" });
    expect(await manifestCount(cwd)).toBe(1);
  });

  it("STOPS refusing when the destructive grant is present — the mutation", async () => {
    const { cwd, wiki } = await orphanedSdk("sdksweepgrant", DESTRUCTIVE_GRANTS);
    expect(await wiki.sweepPreparations()).toMatchObject({ status: "swept" });
    expect(await manifestCount(cwd)).toBe(0);
  });
});

describe("the signed receipt attests the HOST's principal, not the local operator", () => {
  it("stamps the SDK identity and surface onto the durable prune receipt", async () => {
    // The actor is what an audit reads back off the receipt months later, so it
    // must name whoever the host authenticated rather than the process that
    // happened to run. On the `cli` surface this cell cannot fail — a local
    // principal holds the operator set by transport — so it is asserted where
    // the two identities genuinely differ.
    const { cwd, runId, wiki } = await prunableSdk("sdkpruneactor", DESTRUCTIVE_GRANTS);
    const outcome = await wiki.prunePreparation(runId);
    expect(outcome).toMatchObject({ status: "pruned" });
    if (outcome.status !== "pruned") return;
    expect(await receiptActor(cwd, outcome.unitId)).toEqual({ id: "sdk-test", surface: "sdk" });
  });

  it("stamps it onto the durable SWEEP receipt too", async () => {
    // ITS OWN CALL SITE, so its own case. Prune and sweep each stamp the actor
    // in their own operation module rather than through a shared body, and a
    // mutant that hardcoded the local operator on sweep survived the whole
    // suite while prune's case went red — the sibling that did not inherit.
    const { cwd, wiki } = await orphanedSdk("sdksweepactor", DESTRUCTIVE_GRANTS);
    const outcome = await wiki.sweepPreparations();
    expect(outcome).toMatchObject({ status: "swept" });
    if (outcome.status !== "swept") return;
    expect(await receiptActor(cwd, outcome.unitId)).toEqual({ id: "sdk-test", surface: "sdk" });
  });
});

describe("the SDK cannot aim these verbs with anything but their argument", () => {
  it("takes no options object on either verb, so nothing inherited can be read", async () => {
    // The prototype-pollution class has nothing to attach to here: `prune` takes
    // one primitive and `sweep` takes nothing, so there is no caller OBJECT
    // whose chain could supply a field the embedder never wrote. This asserts
    // the shape rather than the absence of a defect, because the shape is what
    // makes the defect unrepresentable.
    const { wiki } = await orphanedSdk("sdksweeparity", DESTRUCTIVE_GRANTS);
    expect(wiki.sweepPreparations.length).toBe(0);
    expect(wiki.prunePreparation.length).toBe(1);
  });

  it("keeps a planted prototype property out of a granted prune", async () => {
    const planted = Object.prototype as unknown as Record<string, unknown>;
    planted.runId = "prr_planted";
    try {
      const { cwd, runId, wiki } = await prunableSdk("sdkpruneproto", DESTRUCTIVE_GRANTS);
      expect(await wiki.prunePreparation(runId)).toMatchObject({ status: "pruned", runId });
      expect(await manifestCount(cwd)).toBe(0);
    } finally {
      delete planted.runId;
    }
  });
});
