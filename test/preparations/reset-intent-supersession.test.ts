/**
 * @file test/preparations/reset-intent-supersession.test.ts
 * @description The supported exit for a reset that recorded its intent and stopped.
 *
 * A first-pass reset writes an unsigned intent marker and waits for the operator to
 * return with the continuation secret. If the preparation key becomes healthy in the
 * meantime — or the marker was planted by anyone able to write the tree — that unit
 * blocks lifecycle mutation and holds reference completeness. Supersession is the
 * exit, and it has to be reachable in exactly that case: the eligibility check for a
 * NEW reset refuses a healthy key, so ordering supersession behind it left the state
 * with no way out.
 *
 * The exit is deliberately narrow. A pre-plan intent authorises nothing, so clearing
 * it destroys nothing; but as soon as the continuation leg has materialised key
 * material or custody, the unit is no longer a marker and this path must refuse rather
 * than delete authority-adjacent state.
 */

import { gateDecision } from "./lifecycle-fixture.js";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { useTempRoot } from "../fixtures/temp-root.js";
import { readPreparationKey } from "../../src/preparations/key-epoch.js";
import { preparationKeyFile, preparationQuarantineUnitPaths } from "../../src/preparations/paths.js";
import { canonicalBytes } from "../../src/profile/templates/signing/canonical.js";
import { preparationKeyEpochId } from "../../src/preparations/run-integrity.js";
import {
  buildResetIntent, resetContinuationDigest, signPendingResetKey,
} from "../../src/preparations/receipts.js";
import {
  FORCED_KEY_CONFIRMATION, MISSING_KEY_CONFIRMATION, resetPreparationKeyEpochLocked,
} from "../../src/preparations/reset.js";
import { resolvePreparationLifecyclePending } from "../../src/preparations/recovery.js";
import { enumeratePreparationReferences } from "../../src/preparations/references.js";
import { expectCompletedSweep } from "./lifecycle-fixture.js";
import { preparationPaths } from "../../src/preparations/paths.js";
import { LIFECYCLE_ACTOR, removePreparationKey, stagePreparation } from "./lifecycle-fixture.js";
import { recordFirstPassIntent } from "./reset-intent-helpers.js";

const AT = "2026-07-20T05:00:00.000Z";
const UNIT = "rst-supersedesupersedesupersedes";

/** Ask for supersession explicitly, the way an operator who lost a token would. */
const supersede = (root: string) =>
  resetPreparationKeyEpochLocked(root, {
    actor: LIFECYCLE_ACTOR, at: AT, confirmation: MISSING_KEY_CONFIRMATION, supersedePendingReset: true,
  });

/** A structurally valid intent bound to `boundTo`, committing to an unknown secret. */
const intentBoundTo = (boundTo: string) => buildResetIntent({
  unitId: boundTo, reason: "missing-key", confirmation: MISSING_KEY_CONFIRMATION,
  continuationDigest: resetContinuationDigest(randomBytes(32)), actor: LIFECYCLE_ACTOR, at: AT,
});

/** Plant a structurally valid, self-bound intent-only unit and return its paths. */
async function plantIntentOnlyUnit(root: string, unitId = UNIT) {
  const paths = preparationQuarantineUnitPaths(root, unitId);
  await mkdir(paths.unitRoot, { recursive: true });
  await writeFile(paths.resetIntentFile, canonicalBytes(intentBoundTo(unitId)));
  return paths;
}

describe("healthy-key intent-only supersession", () => {
  const root = useTempRoot();

  it("clears a stale intent and leaves the lifecycle usable again", async () => {
    const { binding } = await stagePreparation(root.dir);
    expect((await readPreparationKey(root.dir)).status).toBe("ok");
    const keyBefore = await readFile(preparationKeyFile(root.dir));
    await plantIntentOnlyUnit(root.dir);

    expect((await resolvePreparationLifecyclePending(root.dir)).status).not.toBe("clean");
    expect((await enumeratePreparationReferences(root.dir)).complete).toBe(false);

    const outcome = await supersede(root.dir);
    expect(outcome.status).toBe("pending-intent-superseded");

    // No key or preparation authority was touched by clearing a marker.
    expect((await readFile(preparationKeyFile(root.dir))).equals(keyBefore)).toBe(true);
    expect((await resolvePreparationLifecyclePending(root.dir)).status).toBe("clean");
    expect((await enumeratePreparationReferences(root.dir)).complete).toBe(true);

    // The subsystem is genuinely usable, not merely quiet: a real lifecycle operation
    // must COMPLETE. Accepting null here would pass on a sweep that found nothing to do,
    // which proves nothing about whether the block was actually lifted.
    await rm(preparationPaths(root.dir, binding.workspaceId).runFile(binding.runId));
    await expectCompletedSweep(root.dir, AT);
  });

  it("still refuses a new reset when the key is healthy and nothing was superseded", async () => {
    await stagePreparation(root.dir);
    await expect(supersede(root.dir)).rejects.toMatchObject({ code: "key-healthy" });
  });
});

describe("intent-only supersession refuses materialized continuation state", () => {
  const root = useTempRoot();

  /** Assert supersession refuses and leaves the unit's contents untouched. */
  const expectRefused = async (): Promise<void> => {
    await expect(supersede(root.dir)).rejects.toMatchObject({ code: "key-healthy" });
    const paths = preparationQuarantineUnitPaths(root.dir, UNIT);
    await expect(readFile(paths.resetIntentFile)).resolves.toBeTruthy();
  };

  it("refuses a unit holding staged pending-key material", async () => {
    await stagePreparation(root.dir);
    const paths = await plantIntentOnlyUnit(root.dir);
    const key = randomBytes(32);
    await writeFile(paths.pendingResetKeyFile, canonicalBytes(signPendingResetKey(randomBytes(32), {
      unitId: UNIT, keyEpochId: preparationKeyEpochId(key), key: key.toString("base64"),
    })));
    await expectRefused();
  });

  it("refuses a unit holding an owned old-key custody object", async () => {
    await stagePreparation(root.dir);
    const paths = await plantIntentOnlyUnit(root.dir);
    await mkdir(paths.bytesRoot, { recursive: true });
    await writeFile(paths.byteObjectFile("old-key"), "prior key bytes");
    await expectRefused();
  });

  it("refuses a unit holding an unknown leaf", async () => {
    await stagePreparation(root.dir);
    const paths = await plantIntentOnlyUnit(root.dir);
    await writeFile(`${paths.unitRoot}/unexpected.json`, "{}");
    await expectRefused();
  });

  it("refuses a unit whose intent does not bind to it", async () => {
    await stagePreparation(root.dir);
    const paths = await plantIntentOnlyUnit(root.dir);
    await writeFile(paths.resetIntentFile, canonicalBytes(intentBoundTo("rst-someotherunitsomeotherunitxx")));
    await expectRefused();
  });

  it("accepts a unit holding only an empty owned bytes directory", async () => {
    await stagePreparation(root.dir);
    const paths = await plantIntentOnlyUnit(root.dir);
    await mkdir(paths.bytesRoot, { recursive: true });
    expect((await supersede(root.dir)).status).toBe("pending-intent-superseded");
    expect((await resolvePreparationLifecyclePending(root.dir)).status).toBe("clean");
  });

  it("never deletes staged continuation material when a reset is requested afterwards", async () => {
    // codex round-16 blocker: the narrow path correctly skipped a materialized unit,
    // but execution fell through to a broad cleanup that deleted the staged key and
    // intent before opening a replacement reset.
    const { unitId, continuation } = await recordFirstPassIntent(root.dir, AT);
    await expect(resetPreparationKeyEpochLocked(root.dir, {
      actor: LIFECYCLE_ACTOR, at: AT, confirmation: MISSING_KEY_CONFIRMATION, continuation,
      faults: { afterPendingKeyStaged: async () => { throw new Error("crash"); } },
    })).rejects.toThrow("crash");
    const paths = preparationQuarantineUnitPaths(root.dir, unitId);
    const stagedBefore = await readFile(paths.pendingResetKeyFile);

    await expect(supersede(root.dir)).rejects.toMatchObject({ code: "reset-already-pending" });

    expect((await readFile(paths.pendingResetKeyFile)).equals(stagedBefore)).toBe(true);
    await expect(readFile(paths.resetIntentFile)).resolves.toBeTruthy();
    // The operator's own continuation still works, which is what "recoverable" means.
    expect((await resetPreparationKeyEpochLocked(root.dir, {
      actor: LIFECYCLE_ACTOR, at: AT, confirmation: MISSING_KEY_CONFIRMATION, continuation,
    })).status).toBe("completed");
  });

  it("refuses to supersede using the wrong confirmation class", async () => {
    await stagePreparation(root.dir);
    await plantIntentOnlyUnit(root.dir);
    await expect(resetPreparationKeyEpochLocked(root.dir, {
      actor: LIFECYCLE_ACTOR, at: AT, confirmation: FORCED_KEY_CONFIRMATION, supersedePendingReset: true,
    })).rejects.toMatchObject({ code: "key-healthy" });
    await expect(readFile(preparationQuarantineUnitPaths(root.dir, UNIT).resetIntentFile)).resolves.toBeTruthy();
  });

  it("refuses an intent carrying an unknown field", async () => {
    await stagePreparation(root.dir);
    const paths = await plantIntentOnlyUnit(root.dir);
    const tampered = { ...intentBoundTo(UNIT), attackerField: "extra" };
    await writeFile(paths.resetIntentFile, canonicalBytes(tampered));
    await expectRefused();
  });

  it("leaves the intent marker intact when the bytes directory cannot be removed", async () => {
    await stagePreparation(root.dir);
    const paths = await plantIntentOnlyUnit(root.dir);
    const outside = `${paths.unitRoot}-outside-bytes`;
    await mkdir(outside, { recursive: true });
    await symlink(outside, paths.bytesRoot);
    await expect(supersede(root.dir)).rejects.toMatchObject({ code: "key-healthy" });
    // The marker is the commit point, so a refused unit keeps it.
    await expect(readFile(paths.resetIntentFile)).resolves.toBeTruthy();
  });

  it("refuses an intent recording a confirmation its reason does not demand", async () => {
    await stagePreparation(root.dir);
    const paths = await plantIntentOnlyUnit(root.dir);
    await writeFile(paths.resetIntentFile, canonicalBytes({ ...intentBoundTo(UNIT), confirmation: "not-a-real-confirmation" }));
    await expectRefused();
  });

  it("refuses an intent whose nested actor carries an unknown field", async () => {
    await stagePreparation(root.dir);
    const paths = await plantIntentOnlyUnit(root.dir);
    const base = intentBoundTo(UNIT);
    await writeFile(paths.resetIntentFile, canonicalBytes({
      ...base, actor: { ...base.actor, attackerField: "extra" },
    }));
    await expectRefused();
  });

  it("refuses a unit it cannot examine", async () => {
    await stagePreparation(root.dir);
    const paths = await plantIntentOnlyUnit(root.dir);
    await chmod(paths.unitRoot, 0o000);
    try {
      await expect(supersede(root.dir)).rejects.toBeTruthy();
    } finally {
      await chmod(paths.unitRoot, 0o700);
    }
  });
});
