/**
 * @file test/storage/preparation-run-genesis-binding.test.ts
 * @description The preparation run's genesis as the ONE body it already is,
 * `createPreparationRunWith` over `PreparationRunWriteSteps`, with no project.
 * The body existed before this file (it is only newly exported); this file adds
 * the memory witness it lacked.
 *
 * HOW IT IS BUILT. Memory steps answer the key and the genesis publication and
 * log each call, so the order is pinned: the budget re-proof before any read, the
 * key's absent, unreadable and wrong-epoch refusals before any write, the one
 * create-only publication of a signed record that authenticates under the key,
 * and a collision's diagnostic reading the run back.
 *
 * NOT SHOWN HERE: the durable create-only write and the signed record's shape;
 * the run-store and run-integrity suites show those.
 */

import { describe, expect, it } from "bun:test";
import { mintPreparationId, mintPreparationRunId } from "../../src/preparations/ids.js";
import { preparationKeyEpochId, preparationRunBinding, verifyPreparationRunIntegrity } from "../../src/preparations/run-integrity.js";
import { parsePreparationRun } from "../../src/preparations/run-parse.js";
import { createPreparationRunWith, type PreparationRunWriteSteps } from "../../src/preparations/run-store.js";

const KEY = Buffer.alloc(32, 9);
const BUDGET = { maximumPhaseInstances: 1, maximumEvidenceRefs: 3, maximumBrokerRequests: 0, maximumEffects: 0, maximumTransitions: 4, controlTransitionAllowance: 16 };

/** One genesis input under `keyEpochId` (the key's own by default). */
const input = (keyEpochId = preparationKeyEpochId(KEY)) => ({
  runId: mintPreparationRunId(), preparationId: mintPreparationId(), manifestDigest: `sha256:${"c".repeat(64)}`, workspaceId: "research",
  keyEpochId, actor: { id: "operator", surface: "cli" }, at: "2026-10-14T00:00:00.000Z", controlTransitionAllowance: 16,
}) as never;

/** Memory write steps answering `key`; a `collision` publication asks for its diagnostic. Each call logged. */
function stepsOf(log: string[], key: object = { status: "ok", key: KEY, keyEpochId: preparationKeyEpochId(KEY) }, collision = false): PreparationRunWriteSteps & { published: string[] } {
  const published: string[] = [];
  return {
    published,
    readKey: async () => { log.push("key"); return key as never; },
    readRun: async () => { log.push("read-back"); return { status: "ok" } as never; },
    publishGenesis: async (binding, serialized, collisionMessage) => {
      log.push(`publish ${binding.runId}`);
      if (collision) throw new Error(await collisionMessage());
      published.push(serialized);
    },
    readEvidence: async () => { throw new Error("unasked evidence read"); },
    replaceRun: async () => { throw new Error("unasked replacement"); },
  };
}

describe("the preparation run genesis over its write steps", () => {
  it("G1 publishes one signed record that authenticates under the key, and returns it parsed", async () => {
    const log: string[] = [];
    const steps = stepsOf(log);
    const genesis = input() as { runId: string; preparationId: string };
    const run = await createPreparationRunWith(steps, genesis as never, BUDGET);
    const binding = preparationRunBinding(run);
    const reparsed = parsePreparationRun(steps.published[0]!, binding);
    expect([log, run.runId, run.preparationId, verifyPreparationRunIntegrity(reparsed, KEY, binding)]).toEqual([["key", `publish ${genesis.runId}`], genesis.runId, genesis.preparationId, true]);
  });

  it("G2 refuses an over-ceiling budget before the key, and an absent, unreadable or wrong-epoch key before any write", async () => {
    const log: string[] = [];
    await expect(createPreparationRunWith(stepsOf(log), input(), { ...BUDGET, maximumPhaseInstances: 257 })).rejects.toThrow("maximum phase instances exceed the launch ceiling");
    expect(log).toEqual([]);
    await expect(createPreparationRunWith(stepsOf(log, { status: "absent" }), input(), BUDGET)).rejects.toThrow("preparation integrity key is missing");
    await expect(createPreparationRunWith(stepsOf(log, { status: "unavailable" }), input(), BUDGET)).rejects.toThrow("preparation integrity key is unreadable");
    await expect(createPreparationRunWith(stepsOf(log), input(`sha256:${"d".repeat(64)}` as never), BUDGET)).rejects.toThrow("preparation run key epoch mismatch");
    expect(log).toEqual(["key", "key", "key"]);
  });

  it("G3 a create collision reads the run back for its diagnostic and writes nothing", async () => {
    const log: string[] = [];
    const steps = stepsOf(log, undefined, true);
    await expect(createPreparationRunWith(steps, input(), BUDGET)).rejects.toThrow("preparation run genesis already exists: ok");
    expect([log.map((line) => line.split(" ")[0]), steps.published]).toEqual([["key", "publish", "read-back"], []]);
  });
});
