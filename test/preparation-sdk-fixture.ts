/**
 * @file test/preparation-sdk-fixture.ts
 * @description Shared fixtures for the preparation SDK suites, following the
 * precedent of `preparation-cli-fixture.ts`.
 *
 * Extracted when the authority suite and the prototype-pollution suite grew four
 * clone groups between them. Both halves assert the same thing about a refused
 * mutation — the rejection AND that the run did not move — and that pairing is
 * the half a copy loses first: a test asserting only the throw passes against
 * code that refuses after committing.
 */

import { expect } from "vitest";
import type { PreparationGrant } from "../src/preparations/service.js";
import type { Wiki } from "../src/sdk/types.js";
import { emptyWorkspace } from "./preparation-cli-fixture.js";

/** Prove a facade lacks both destructive escape grants before testing its permitted route. */
export async function expectNoRecoveryAuthority(wiki: Wiki, runId: string): Promise<void> {
  await expect(wiki.cancelPreparation(runId)).rejects.toMatchObject({ code: "missing-grant" });
  await expect(wiki.recoverPreparation(runId)).rejects.toMatchObject({ code: "missing-grant" });
}

/** The binding fields these fixtures need from a staged run. */
export interface StagedBinding {
  readonly workspaceId: string;
  readonly runId: string;
}

/** A project holding exactly one `planned` run. */
export async function projectWithRun(
  suffix: string,
): Promise<{ cwd: string; binding: StagedBinding }> {
  const cwd = await emptyWorkspace(suffix);
  const { stagePreparation } = await import("./preparations/lifecycle-fixture.js");
  const { binding } = await stagePreparation(cwd);
  return { cwd, binding };
}

/** An initialized project with no runs, ready to be staged into. */
export async function stageableProject(suffix: string): Promise<string> {
  const { initializedWorkspace } = await import("./preparation-cli-fixture.js");
  return initializedWorkspace(suffix);
}

/** The plan and seed documents an SDK caller would hold in memory. */
export async function stageDocuments(): Promise<{
  planDocument: string; seedDocument: string;
}> {
  const { fixturePlan } = await import("./preparations/store-fixture.js");
  return {
    planDocument: JSON.stringify(fixturePlan()),
    seedDocument: JSON.stringify({ seed: "initial-input", version: 1 }),
  };
}

/**
 * Assert one mutation refused for want of a grant, AND that nothing moved.
 *
 * The durable re-read is the load-bearing half. A refusal that threw after
 * committing satisfies the rejection alone, so the two assertions travel
 * together and cannot be separated by a copy.
 */
export async function expectMissingGrant(
  attempt: Promise<unknown>, cwd: string, binding: StagedBinding,
): Promise<void> {
  await expect(attempt).rejects.toMatchObject({ code: "missing-grant" });
  const { runStateOf } = await import("./preparation-cli-fixture.js");
  expect(await runStateOf(cwd, binding)).toBe("planned");
}

/**
 * Assert one mutation SUCCEEDED, and that the run durably moved.
 *
 * The mirror of {@link expectMissingGrant}, and it travels with it: a refusal
 * test alone passes against code that refuses everything.
 */
export async function expectRunFailed(
  attempt: Promise<unknown>, cwd: string, binding: StagedBinding,
): Promise<void> {
  expect(await attempt).toEqual({ status: "failed", runId: binding.runId });
  const { runStateOf } = await import("./preparation-cli-fixture.js");
  expect(await runStateOf(cwd, binding)).toBe("failed");
}

/** Stage through the facade and assert who the durable manifest credits. */
export async function expectStagedBy(
  wiki: Pick<Wiki, "stagePreparation">, cwd: string,
  expected: { id: string; surface: string },
): Promise<void> {
  const result = await wiki.stagePreparation(await stageDocuments());
  expect(result.status).toBe("staged");
  const { onlyManifest } = await import("./preparation-cli-fixture.js");
  const manifest = await onlyManifest(cwd, (result as { workspaceId: string }).workspaceId);
  expect(manifest.createdBy).toMatchObject(expected);
}

/**
 * The control-transition budget one staged run DURABLY recorded.
 *
 * Read off disk rather than from the result: the budget is not in any result
 * DTO, so an in-memory assertion could not witness it at all.
 */
export async function stagedAllowance(cwd: string, workspaceId: string): Promise<number | undefined> {
  const path = await import("node:path");
  const { readdir, readFile } = await import("node:fs/promises");
  const directory = path.join(cwd, ".llmwiki", "workspaces", workspaceId, "preparation-runs");
  const [leaf] = await readdir(directory);
  const run = JSON.parse(await readFile(path.join(directory, leaf as string), "utf8")) as {
    controlTransitionAllowance?: number;
  };
  return run.controlTransitionAllowance;
}

/** The actor one run's most recent transition durably credits. */
export async function lastTransitionActor(
  cwd: string, binding: StagedBinding,
): Promise<{ id?: string; surface?: string } | undefined> {
  const { readPreparationRun } = await import("../src/preparations/run-store.js");
  const read = await readPreparationRun(cwd, binding as never);
  if (read.status !== "ok") return undefined;
  const transitions = read.run.transitions as readonly { actor?: { id?: string; surface?: string } }[];
  return transitions[transitions.length - 1]?.actor;
}

/** The grant set the mutating operations cost, for the granted-path fixtures. */
export const MUTATING_GRANTS: readonly PreparationGrant[] = ["preparation.run"];

/**
 * Assert one run carries NO gate proof.
 *
 * The durable half of every refused gate decision. A refusal that recorded first
 * and threw afterwards satisfies the returned status alone, so the two assertions
 * travel together — the same pairing {@link expectMissingGrant} exists for.
 */
export async function expectNoGateProof(cwd: string, binding: StagedBinding): Promise<void> {
  const { readPreparationRun } = await import("../src/preparations/run-store.js");
  const { readPreparationKey } = await import("../src/preparations/key-epoch.js");
  const { scanPreparationInventory } = await import("../src/preparations/capacity.js");
  const { bindingFor } = await import("../src/preparations/references.js");
  const key = await readPreparationKey(cwd);
  if (key.status !== "ok") throw new Error(`preparation key is ${key.status}`);
  const manifest = (await scanPreparationInventory(cwd)).manifests
    .find((candidate) => candidate.runId === binding.runId);
  if (manifest === undefined) throw new Error("no manifest for the fixture run");
  const read = await readPreparationRun(cwd, bindingFor(manifest, key.keyEpochId));
  if (read.status !== "ok") throw new Error(`run is ${read.status}`);
  expect(read.run.gateProofs).toHaveLength(0);
}
