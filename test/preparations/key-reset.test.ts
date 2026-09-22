/**
 * @file test/preparations/key-reset.test.ts
 * @description Missing/unreadable-key project reset (design sections 25.3, 25.4).
 * The reset is two-invocation and bound by an operator-carried one-time continuation
 * secret: the first confirmed pass records only an unsigned intent (committing to the
 * secret's digest), mints no key, and returns the secret; only a rerun that presents
 * the secret quarantines all preparation authority and installs one fresh epoch. Every
 * file in the reset unit is attacker-influenceable, so a planted intent or key can
 * never drive a completion without the secret. The staged key is persisted for
 * crash-resumption and removed once the reset completes. A distinct confirmation is
 * required for the forced path, a healthy key is never reset, and the epoch is single.
 */

import { gateDecision } from "./lifecycle-fixture.js";
import type { PreparationRunId } from "../../src/preparations/ids.js";
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { PREPARATION_PRUNE_REGISTRY, preparationPaths } from "../../src/preparations/paths.js";
import { expectCompletedSweep } from "./lifecycle-fixture.js";
import { describe, expect, it } from "vitest";
import { useTempRoot } from "../fixtures/temp-root.js";
import { readPreparationKey } from "../../src/preparations/key-epoch.js";
import { preparationKeyFile, preparationQuarantineUnitPaths } from "../../src/preparations/paths.js";
import { scanPreparationInventory } from "../../src/preparations/capacity.js";
import { canonicalBytes } from "../../src/profile/templates/signing/canonical.js";
import { preparationKeyEpochId } from "../../src/preparations/run-integrity.js";
import { buildResetIntent, resetContinuationDigest, signPendingResetKey } from "../../src/preparations/receipts.js";
import {
  FORCED_KEY_CONFIRMATION, MISSING_KEY_CONFIRMATION, PreparationResetError, resetPreparationKeyEpochLocked,
  type ResetFaultsForTest, type ResetKeyEpochResult,
} from "../../src/preparations/reset.js";
import {
  LIFECYCLE_ACTOR, makePreparationKeyUnreadable, removePreparationKey, stagePreparation, sweepStagedThenCrashed,
} from "./lifecycle-fixture.js";

const AT = "2026-07-20T03:00:00.000Z";
const reset = (root: string, confirmation: string, continuation?: { unitId: string; token: string }) =>
  resetPreparationKeyEpochLocked(root, { actor: LIFECYCLE_ACTOR, at: AT, confirmation, continuation });

/** The unit id and one-time secret returned by a first-pass intent. */
const intentContinuation = (result: ResetKeyEpochResult): { unitId: string; token: string } => {
  if (result.status !== "intent-recorded") throw new Error("expected an intent-recorded pass one");
  return { unitId: result.unitId, token: result.continuationToken };
};

/** Drive both passes of a missing-key reset with the real operator continuation. */
const completeMissingKeyReset = async (dir: string): Promise<ResetKeyEpochResult> =>
  reset(dir, MISSING_KEY_CONFIRMATION, intentContinuation(await reset(dir, MISSING_KEY_CONFIRMATION)));

describe("missing-key project reset", () => {
  const root = useTempRoot();

  it("records an intent and returns a continuation secret on the first pass", async () => {
    await stagePreparation(root.dir);
    await removePreparationKey(root.dir);
    const pass1 = await reset(root.dir, MISSING_KEY_CONFIRMATION);
    expect(pass1.status).toBe("intent-recorded");
    expect(intentContinuation(pass1).token).toHaveLength(44);
    expect((await readPreparationKey(root.dir)).status).toBe("absent");
  });

  it("quarantines all authority and installs one fresh epoch on the token-bearing rerun", async () => {
    const { binding } = await stagePreparation(root.dir);
    await removePreparationKey(root.dir);
    const pass2 = await completeMissingKeyReset(root.dir);
    expect(pass2.status).toBe("completed");
    expect((await readPreparationKey(root.dir)).status).toBe("ok");
    const inventory = await scanPreparationInventory(root.dir);
    expect(inventory.runIds.has(binding.runId)).toBe(false);
    expect(inventory.manifests.length).toBe(0);
    expect(inventory.quarantine.bytes).toBeGreaterThan(0);
  });

  it("refuses a second bare pass rather than leaving two pending intents", async () => {
    await stagePreparation(root.dir);
    await removePreparationKey(root.dir);
    await reset(root.dir, MISSING_KEY_CONFIRMATION);
    await expect(reset(root.dir, MISSING_KEY_CONFIRMATION)).rejects.toMatchObject({ code: "reset-already-pending" });
    expect((await readPreparationKey(root.dir)).status).toBe("absent");
  });

  it("supersedes a pending intent only when explicitly asked, invalidating its token", async () => {
    await stagePreparation(root.dir);
    await removePreparationKey(root.dir);
    const stale = intentContinuation(await reset(root.dir, MISSING_KEY_CONFIRMATION));
    const fresh = await resetPreparationKeyEpochLocked(root.dir, {
      actor: LIFECYCLE_ACTOR, at: AT, confirmation: MISSING_KEY_CONFIRMATION, supersedePendingReset: true,
    });
    expect(fresh.status).toBe("intent-recorded");
    await expect(reset(root.dir, MISSING_KEY_CONFIRMATION, stale)).rejects.toMatchObject({ code: "continuation-mismatch" });
    expect((await reset(root.dir, MISSING_KEY_CONFIRMATION, intentContinuation(fresh))).status).toBe("completed");
  });

  it("refuses a malformed or unmatched continuation token", async () => {
    await stagePreparation(root.dir);
    await removePreparationKey(root.dir);
    const { unitId } = intentContinuation(await reset(root.dir, MISSING_KEY_CONFIRMATION));
    await expect(reset(root.dir, MISSING_KEY_CONFIRMATION, { unitId, token: "not-a-token" })).rejects.toMatchObject({ code: "continuation-mismatch" });
    await expect(reset(root.dir, MISSING_KEY_CONFIRMATION, { unitId, token: randomBytes(32).toString("base64") })).rejects.toMatchObject({ code: "continuation-mismatch" });
  });

  it("refuses the ordinary reset when the key is unreadable, not missing", async () => {
    await stagePreparation(root.dir);
    await makePreparationKeyUnreadable(root.dir);
    await expect(reset(root.dir, MISSING_KEY_CONFIRMATION)).rejects.toMatchObject({ code: "confirmation-mismatch" });
  });

  it("refuses to reset a healthy key epoch", async () => {
    await stagePreparation(root.dir);
    await expect(reset(root.dir, MISSING_KEY_CONFIRMATION)).rejects.toBeInstanceOf(PreparationResetError);
    await expect(reset(root.dir, MISSING_KEY_CONFIRMATION)).rejects.toMatchObject({ code: "key-healthy" });
  });

  it("removes the plaintext staged key and the intent marker once the reset completes", async () => {
    await stagePreparation(root.dir);
    await removePreparationKey(root.dir);
    const done = await completeMissingKeyReset(root.dir);
    if (done.status !== "completed") throw new Error("reset did not complete");
    const paths = preparationQuarantineUnitPaths(root.dir, done.unitId);
    await expect(lstat(paths.pendingResetKeyFile)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(paths.resetIntentFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("takes custody of sweep bytes staged under the epoch it replaces", async () => {
    const unitId = await sweepStagedThenCrashed(root.dir, AT);
    const unitRoot = path.join(root.dir, ".llmwiki", PREPARATION_PRUNE_REGISTRY, unitId);
    expect((await readdir(unitRoot)).some((entry) => entry.startsWith("pending-delete-"))).toBe(true);
    await removePreparationKey(root.dir);
    const done = await completeMissingKeyReset(root.dir);
    if (done.status !== "completed") throw new Error("reset did not complete");
    // The ENTIRE unit is quarantined under the fresh epoch — receipts included, since a
    // receipt left behind is authenticated by the dead key and breaks every later sweep.
    expect(done.receipt.objects.some((object) => object.logicalPath.includes(unitId))).toBe(true);
    expect(await readdir(unitRoot)).toEqual([]);
    // The project is usable again: not merely staging, but the LIFECYCLE operations
    // whose authority the reset replaced.
    const staged = await stagePreparation(root.dir);
    expect(staged.binding.runId).toBeTruthy();
    await rm(preparationPaths(root.dir, staged.binding.workspaceId).runFile(staged.binding.runId));
    await expectCompletedSweep(root.dir, AT);
  });

  it("refuses the reset when a prune unit is an empty symlink rather than a real directory", async () => {
    await stagePreparation(root.dir);
    const registry = path.join(root.dir, ".llmwiki", PREPARATION_PRUNE_REGISTRY);
    const outside = path.join(root.dir, "..", "outside-empty-unit");
    await mkdir(outside, { recursive: true });
    await mkdir(registry, { recursive: true });
    await symlink(outside, path.join(registry, "swp-plantedplantedplantedplanted"));
    await removePreparationKey(root.dir);
    try {
      const pass1 = await reset(root.dir, MISSING_KEY_CONFIRMATION);
      await expect(reset(root.dir, MISSING_KEY_CONFIRMATION, intentContinuation(pass1)))
        .rejects.toThrow(/prune registry cannot be enumerated/);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("stages a fresh durable preparation after a completed reset", async () => {
    await stagePreparation(root.dir);
    await removePreparationKey(root.dir);
    await completeMissingKeyReset(root.dir);
    const staged = await stagePreparation(root.dir);
    expect(staged.binding.runId).toBeTruthy();
  });
});

describe("reset ignores an attacker-influenceable reset unit", () => {
  const root = useTempRoot();

  /** Assert a bare reset refuses with `key-healthy` and destroys no live authority. */
  const expectRefusedIntact = async (runId: PreparationRunId): Promise<void> => {
    await expect(reset(root.dir, MISSING_KEY_CONFIRMATION)).rejects.toMatchObject({ code: "key-healthy" });
    const inventory = await scanPreparationInventory(root.dir);
    expect(inventory.runIds.has(runId)).toBe(true);
    expect(inventory.manifests.length).toBeGreaterThan(0);
  };

  /** Crash a missing-key reset at one durable seam, then assert the rerun completes. */
  const resumesAfterCrash = async (runId: PreparationRunId, faults: ResetFaultsForTest): Promise<void> => {
    await removePreparationKey(root.dir);
    const continuation = intentContinuation(await reset(root.dir, MISSING_KEY_CONFIRMATION));
    const crash = resetPreparationKeyEpochLocked(root.dir, { actor: LIFECYCLE_ACTOR, at: AT, confirmation: MISSING_KEY_CONFIRMATION, continuation, faults });
    await expect(crash).rejects.toThrow("crash");
    const resumed = await reset(root.dir, MISSING_KEY_CONFIRMATION, continuation);
    expect(resumed.status).toBe("completed");
    expect((await scanPreparationInventory(root.dir)).runIds.has(runId)).toBe(false);
  };

  it("records intent instead of completing when a full reset unit is planted and the key is absent", async () => {
    await stagePreparation(root.dir);
    await removePreparationKey(root.dir);
    const unitId = "rst-plantedplantedplantedplanted";
    const paths = preparationQuarantineUnitPaths(root.dir, unitId);
    await mkdir(paths.unitRoot, { recursive: true });
    const attackerSecret = randomBytes(32);
    const intent = buildResetIntent({ unitId, reason: "missing-key", confirmation: MISSING_KEY_CONFIRMATION, continuationDigest: resetContinuationDigest(attackerSecret), actor: LIFECYCLE_ACTOR, at: AT });
    await writeFile(paths.resetIntentFile, canonicalBytes(intent));
    const forged = randomBytes(32);
    await writeFile(paths.pendingResetKeyFile, canonicalBytes(signPendingResetKey(attackerSecret, { unitId, keyEpochId: preparationKeyEpochId(forged), key: forged.toString("base64") })));
    await expect(reset(root.dir, MISSING_KEY_CONFIRMATION)).rejects.toMatchObject({ code: "reset-already-pending" });
    expect((await readPreparationKey(root.dir)).status).toBe("absent");
    expect((await scanPreparationInventory(root.dir)).manifests.length).toBeGreaterThan(0);
  });

  it("refuses a planted reset-intent while the key is healthy and quarantines nothing", async () => {
    const { binding } = await stagePreparation(root.dir);
    expect((await readPreparationKey(root.dir)).status).toBe("ok");
    const unitId = "rst-healthyhealthyhealthyhealthy";
    const paths = preparationQuarantineUnitPaths(root.dir, unitId);
    await mkdir(paths.unitRoot, { recursive: true });
    const intent = buildResetIntent({ unitId, reason: "missing-key", confirmation: MISSING_KEY_CONFIRMATION, continuationDigest: resetContinuationDigest(randomBytes(32)), actor: LIFECYCLE_ACTOR, at: AT });
    await writeFile(paths.resetIntentFile, canonicalBytes(intent));
    await expectRefusedIntact(binding.runId);
  });

  it("refuses a token-bearing rerun when the key is restored between the two invocations", async () => {
    const { binding } = await stagePreparation(root.dir);
    await removePreparationKey(root.dir);
    const continuation = intentContinuation(await reset(root.dir, MISSING_KEY_CONFIRMATION));
    await writeFile(preparationKeyFile(root.dir), randomBytes(32).toString("base64"), { encoding: "utf8", mode: 0o600 });
    await expect(reset(root.dir, MISSING_KEY_CONFIRMATION, continuation)).rejects.toMatchObject({ code: "key-healthy" });
    expect((await scanPreparationInventory(root.dir)).runIds.has(binding.runId)).toBe(true);
  });

  it("refuses a token whose intent was copied into another unit", async () => {
    await stagePreparation(root.dir);
    await removePreparationKey(root.dir);
    const continuation = intentContinuation(await reset(root.dir, MISSING_KEY_CONFIRMATION));
    const copiedId = "rst-aaaacopiedcopiedcopiedcopied";
    const copied = preparationQuarantineUnitPaths(root.dir, copiedId);
    await mkdir(copied.unitRoot, { recursive: true });
    const original = preparationQuarantineUnitPaths(root.dir, continuation.unitId);
    await writeFile(copied.resetIntentFile, await readFile(original.resetIntentFile));
    await expect(reset(root.dir, MISSING_KEY_CONFIRMATION, { unitId: copiedId, token: continuation.token }))
      .rejects.toMatchObject({ code: "continuation-mismatch" });
    expect((await readPreparationKey(root.dir)).status).toBe("absent");
  });

  it("refuses a signed planned receipt copied over the completed receipt name", async () => {
    const { binding } = await stagePreparation(root.dir);
    await removePreparationKey(root.dir);
    const continuation = intentContinuation(await reset(root.dir, MISSING_KEY_CONFIRMATION));
    const crash = resetPreparationKeyEpochLocked(root.dir, {
      actor: LIFECYCLE_ACTOR, at: AT, confirmation: MISSING_KEY_CONFIRMATION, continuation,
      faults: { afterPlanned: async () => { throw new Error("crash"); } },
    });
    await expect(crash).rejects.toThrow("crash");
    const paths = preparationQuarantineUnitPaths(root.dir, continuation.unitId);
    await writeFile(paths.completedReceiptFile, await readFile(paths.plannedReceiptFile));
    await expect(reset(root.dir, MISSING_KEY_CONFIRMATION, continuation)).rejects.toThrow(/does not bind this unit and kind/);
    expect((await scanPreparationInventory(root.dir)).runIds.has(binding.runId)).toBe(true);
  });

  it("refuses a new intent when an existing unit is unreadable rather than assuming none", async () => {
    await stagePreparation(root.dir);
    await removePreparationKey(root.dir);
    const { unitId } = intentContinuation(await reset(root.dir, MISSING_KEY_CONFIRMATION));
    const paths = preparationQuarantineUnitPaths(root.dir, unitId);
    await chmod(paths.unitRoot, 0o000);
    try {
      await expect(reset(root.dir, MISSING_KEY_CONFIRMATION)).rejects.toMatchObject({ code: "reset-already-pending" });
    } finally {
      await chmod(paths.unitRoot, 0o700);
    }
  });

  it("resumes a reset that crashed after publishing the active key and completes", async () => {
    const { binding } = await stagePreparation(root.dir);
    await resumesAfterCrash(binding.runId, { afterKeyMint: async () => { throw new Error("crash"); } });
  });

  it("resumes a reset that crashed after staging the pending key and completes", async () => {
    const { binding } = await stagePreparation(root.dir);
    await resumesAfterCrash(binding.runId, { afterPendingKeyStaged: async () => { throw new Error("crash"); } });
  });
});

describe("forced unreadable-key reset", () => {
  const root = useTempRoot();

  it("moves the unreadable key into quarantine before minting a fresh epoch", async () => {
    await stagePreparation(root.dir);
    await makePreparationKeyUnreadable(root.dir);
    const intent = await reset(root.dir, FORCED_KEY_CONFIRMATION);
    expect(intent.status).toBe("intent-recorded");
    const done = await reset(root.dir, FORCED_KEY_CONFIRMATION, intentContinuation(intent));
    if (done.status !== "completed") throw new Error("reset did not complete");
    expect((await readPreparationKey(root.dir)).status).toBe("ok");
    const oldKey = preparationQuarantineUnitPaths(root.dir, done.unitId).byteObjectFile("old-key");
    await expect(readFile(oldKey, "utf8")).resolves.toBe("not-a-valid-key");
  });
});
