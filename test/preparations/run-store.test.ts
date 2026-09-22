/**
 * @file test/preparations/run-store.test.ts
 * @description Durable whole-file transition replacement contract against a real
 * staged preparation: an ordinary append advances the record, the reserved park
 * move reaches recovery-required, the handoff writer binds a verified bundle to
 * the exact chain tip, and abandonment requires confirmation plus verified
 * residual evidence. A stale predecessor is refused.
 */

import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { useTempRoot } from "../fixtures/temp-root.js";
import { parseSha256Digest } from "../../src/capability-providers/ids.js";
import { preparationPaths } from "../../src/preparations/paths.js";
import { readPreparationKey } from "../../src/preparations/key-epoch.js";
import { preparationManifestDigest } from "../../src/preparations/manifest-parse.js";
import { preparationRunPredecessor } from "../../src/preparations/run-integrity.js";
import {
  appendAbandonedTransitionLocked, appendHandoffStartedTransitionLocked,
  appendHandoffTransitionLocked, appendHeadroomExhaustedControl,
  appendPreparationTransitionLocked, readPreparationRun,
} from "../../src/preparations/run-store.js";
import { deriveHandoffId } from "../../src/preparations/ids.js";
import { mintBundleId, mintOperationRunId } from "../../src/operation-bundles/ids.js";
import { stagePreparationLocked } from "../../src/preparations/stage.js";
import { fixturePlan, seedDigest, stageRequest } from "./store-fixture.js";
import type { PreparationRunBinding } from "../../src/preparations/run-types.js";

const root = useTempRoot();
const ACTOR = { id: "operator", surface: "cli" } as const;
const PHASE = `phi_${"a".repeat(64)}` as const;

/** Stage a preparation and return its authenticated run binding. */
async function stageBinding(): Promise<PreparationRunBinding> {
  const staged = await stagePreparationLocked(root.dir, stageRequest(fixturePlan()));
  if (staged.status !== "staged") throw new Error("not staged");
  const key = await readPreparationKey(root.dir);
  if (key.status !== "ok") throw new Error("no key");
  return {
    runId: staged.manifest.runId, preparationId: staged.manifest.preparationId, workspaceId: staged.manifest.workspaceId,
    manifestDigest: preparationManifestDigest(staged.manifest), keyEpochId: key.keyEpochId,
  };
}

/** Read the current authenticated predecessor for a binding. */
async function predecessor(binding: PreparationRunBinding) {
  const read = await readPreparationRun(root.dir, binding);
  if (read.status !== "ok") throw new Error(`run ${read.status}`);
  return preparationRunPredecessor(read.run);
}

describe("preparation run store transitions", () => {
  it("advances an ordinary transition then parks on the reserved control move", async () => {
    const binding = await stageBinding();
    await appendPreparationTransitionLocked(root.dir, binding, await predecessor(binding), {
      type: "phase-started", stateAfter: "running", actor: ACTOR, at: "2026-07-20T00:01:00.000Z",
      payload: { kind: "phase", phaseInstanceId: PHASE, phaseState: "running" },
    });
    const parked = await appendHeadroomExhaustedControl(root.dir, binding, await predecessor(binding), ACTOR, "2026-07-20T00:02:00.000Z");
    expect(parked.state).toBe("recovery-required");
  });

  it("refuses a stale predecessor", async () => {
    const binding = await stageBinding();
    const stale = await predecessor(binding);
    await appendPreparationTransitionLocked(root.dir, binding, stale, {
      type: "phase-started", stateAfter: "running", actor: ACTOR, at: "2026-07-20T00:01:00.000Z",
      payload: { kind: "phase", phaseInstanceId: PHASE, phaseState: "running" },
    });
    await expect(appendPreparationTransitionLocked(root.dir, binding, stale, {
      type: "paused", stateAfter: "paused", actor: ACTOR, at: "2026-07-20T00:03:00.000Z", payload: { kind: "none" },
    })).rejects.toThrow(/predecessor/);
  });

  it("records reserved identities then binds the settled handoff from durable state", async () => {
    const binding = await stageBinding();
    const path = [
      { type: "phase-started", stateAfter: "running", payload: { kind: "phase", phaseInstanceId: PHASE, phaseState: "running" } },
      { type: "handoff-ready", stateAfter: "handoff-ready", payload: { kind: "none" } },
    ] as const;
    let at = 0;
    for (const step of path) {
      await appendPreparationTransitionLocked(root.dir, binding, await predecessor(binding), { ...step, actor: ACTOR, at: `2026-07-20T00:0${++at}:00.000Z` });
    }
    const preHandoff = await predecessor(binding);
    const reservedBundleId = mintBundleId();
    const digest = parseSha256Digest(`sha256:${"e".repeat(64)}`);
    await appendHandoffStartedTransitionLocked(root.dir, binding, preHandoff, {
      actor: ACTOR, at: "2026-07-20T00:07:00.000Z", start: {
        handoffId: deriveHandoffId(binding.runId, preHandoff.chainTip), reservedBundleId,
        reservedOperationRunId: mintOperationRunId(), bundleManifestDigest: digest, genesisAuthorityDigest: digest,
        preHandoffTransitionHash: preHandoff.chainTip, originEvidenceDigest: digest, evidenceCopyDigest: digest,
      },
    });
    const handed = await appendHandoffTransitionLocked(root.dir, binding, await predecessor(binding), {
      actor: ACTOR, at: "2026-07-20T00:09:00.000Z",
    });
    expect(handed.state).toBe("handed-off");
    expect(handed.handoff?.bundleId).toBe(reservedBundleId);
  });

  it("surfaces a tampered record as a distinct integrity-invalid code", async () => {
    const binding = await stageBinding();
    const file = preparationPaths(root.dir, binding.workspaceId).runFile(binding.runId);
    const record = JSON.parse(await readFile(file, "utf8"));
    record.integrity = `${record.integrity.slice(0, -1)}${record.integrity.endsWith("0") ? "1" : "0"}`;
    await writeFile(file, JSON.stringify(record), "utf8");
    const read = await readPreparationRun(root.dir, binding);
    expect(read).toMatchObject({ status: "unavailable", code: "run-integrity-invalid" });
  });

  it("abandons only with confirmation and verified residual evidence", async () => {
    const binding = await stageBinding();
    const plan = fixturePlan();
    await appendPreparationTransitionLocked(root.dir, binding, await predecessor(binding), {
      type: "recovery-required", stateAfter: "recovery-required", actor: ACTOR, at: "2026-07-20T00:01:00.000Z",
      payload: { kind: "problem", code: "preparation-effect-outcome-unknown" },
    });
    const abandoned = await appendAbandonedTransitionLocked(root.dir, binding, await predecessor(binding), {
      actor: ACTOR, at: "2026-07-20T00:02:00.000Z", confirmResidualState: true,
      findings: [{ code: "residual-effect", evidence: plan.initialInputSet }],
    });
    expect(abandoned.state).toBe("abandoned");
    expect(abandoned.residualFindings).toHaveLength(1);
    expect(seedDigest()).toHaveLength(64);
  });
});
