/**
 * @file test/preparations/lifecycle-supersession-resume.test.ts
 * @description The crash contract PLA-MAP-R22 states, tested rather than reasoned.
 *
 * Clearing an intent-only unit removes its empty `bytes/` directory FIRST and its
 * intent marker LAST, so the marker's absence is the single durable signal that
 * the unit was superseded. The map row asserts that a crash BETWEEN those two
 * removals is recoverable: the marker is still present, `bytes/` is already gone,
 * the unit still classifies intent-only, and the same clear repeats and completes.
 *
 * That claim was written from reading the classifier. This program's rule is that
 * a crash claim is tested, not reasoned — a recovery path nobody executes is a
 * recovery path nobody knows works.
 *
 * Note the fixture detail that makes this real: pass one writes ONLY the intent
 * marker, with no `bytes/` directory. The empty-`bytes/` state this exercises
 * arises from a pass two that created the directory and then died, which is
 * exactly why `clearResetIntentUnit` takes `hasEmptyBytesDirectory` at all.
 */

import { appendFile, chmod, mkdir, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { useTempRoot } from "../fixtures/temp-root.js";
import {
  MISSING_KEY_CONFIRMATION, resetPreparationKeyEpochLocked,
} from "../../src/preparations/reset.js";
import { LIFECYCLE_ACTOR, removePreparationKey, stagePreparation } from "./lifecycle-fixture.js";
import { preparationQuarantineUnitPaths } from "../../src/preparations/paths.js";

const AT = "2026-08-01T00:00:00.000Z";
const root = useTempRoot();
const RESET = { actor: LIFECYCLE_ACTOR, at: AT, confirmation: MISSING_KEY_CONFIRMATION };

/** Pass one, which writes the intent marker and nothing else. */
async function pendingIntentUnit(dir: string) {
  await stagePreparation(dir);
  await removePreparationKey(dir);
  const first = await resetPreparationKeyEpochLocked(dir, RESET);
  if (first.status !== "intent-recorded") throw new Error(`no intent: ${first.status}`);
  return {
    ...preparationQuarantineUnitPaths(dir, first.unitId),
    continuation: { unitId: first.unitId, token: first.continuationToken },
  };
}

/** Stage a pending key, then die before it is published. */
async function crashAfterStaging(dir: string, continuation: { unitId: string; token: string }) {
  await expect(resetPreparationKeyEpochLocked(dir, {
    ...RESET, continuation,
    faults: { afterPendingKeyStaged: async () => { throw new Error("crash"); } },
  })).rejects.toThrow("crash");
}

/** Supersede every eligible intent-only unit, as a fresh reset does. */
function supersede(dir: string) {
  return resetPreparationKeyEpochLocked(dir, { ...RESET, supersedePendingReset: true });
}

describe("an unreadable reset-intent marker", () => {
  it("says the marker is unreadable, not that it is absent", async () => {
    // Review reproduced a hard lockout from ONE damaged file, with no quarantine
    // unit involved: pass two reported "the named reset unit has no pending
    // intent" while pass one refused because the marker was still detected. The
    // two legs disagreed about the same file because `openContinuation`
    // collapsed a three-way read into `!== "ok"` and `resetIntentLeafPresence`
    // did not — the C1 defect at a sibling call site in the same file.
    //
    // The state is still terminal for that unit and the operator repairs it out
    // of band. What must not happen is the operator being told something FALSE
    // about which file to look at.
    const paths = await pendingIntentUnit(root.dir);
    await chmod(paths.resetIntentFile, 0o000);

    await expect(resetPreparationKeyEpochLocked(root.dir, {
      ...RESET, continuation: paths.continuation,
    })).rejects.toMatchObject({ code: "continuation-unreadable" });
  });

  it("still reports a genuinely absent marker as absent", async () => {
    // The control. Without it, the test above could pass by reporting every
    // continuation failure as unreadable, which would be the same conflation
    // pointing the other way.
    const paths = await pendingIntentUnit(root.dir);
    await rm(paths.resetIntentFile);

    await expect(resetPreparationKeyEpochLocked(root.dir, {
      ...RESET, continuation: paths.continuation,
    })).rejects.toMatchObject({ code: "continuation-mismatch" });
  });
});

describe("an unreadable staged reset key", () => {
  it("refuses in its own words instead of colliding with a create-only write", async () => {
    // Review reproduced this: crash after staging, damage the staged key, and
    // every route out refuses. The fall-through re-mints, but
    // `stagePendingResetKey` writes CREATE-ONLY, so it collides with the very
    // file that could not be read — surfacing as an untyped "atomic no-replace
    // destination already exists", with the remaining advice being to continue
    // with the token, the one action that provably throws.
    //
    // SHAPE MATTERS, and both chmod AND a symlink are the wrong probe here: each
    // refuses earlier at the destructive-scan gate, so the test would pass for
    // the wrong reason. That trap has now caught four separate probes across two
    // reviewers and me. Only an OVERSIZE staged key isolates this read.
    const paths = await pendingIntentUnit(root.dir);
    await crashAfterStaging(root.dir, paths.continuation);
    await appendFile(paths.pendingResetKeyFile, " ".repeat(OVERSIZE_BYTES));

    await expect(resetPreparationKeyEpochLocked(root.dir, {
      ...RESET, continuation: paths.continuation,
    })).rejects.toMatchObject({ code: "pending-key-unreadable" });
  });

  it("refuses a staged key that is readable but does not authenticate", async () => {
    // The tenth instance, one branch from the ninth. `invalid` was folded into
    // `absent`, and `absent` is the ONLY branch licensed to fall through to the
    // create-only write — so a malformed or unauthenticated staged key collided
    // exactly as an unreadable one did. The bad-body path is attacker-relevant:
    // everything in a reset unit is attacker-influenceable.
    const paths = await pendingIntentUnit(root.dir);
    await crashAfterStaging(root.dir, paths.continuation);
    await writeFile(paths.pendingResetKeyFile, "{ not json");

    await expect(resetPreparationKeyEpochLocked(root.dir, {
      ...RESET, continuation: paths.continuation,
    })).rejects.toMatchObject({ code: "pending-key-invalid" });
  });

  it("still stages fresh when the key is genuinely absent", async () => {
    // The control that keeps the refusal honest. `absent` must STILL fall
    // through — the invariant is "only a leaf provably not there may be treated
    // as absent", not "nothing may ever be staged". Removing the file after the
    // crash is the one state where creating it is correct.
    const paths = await pendingIntentUnit(root.dir);
    await crashAfterStaging(root.dir, paths.continuation);
    await rm(paths.pendingResetKeyFile);

    const done = await resetPreparationKeyEpochLocked(root.dir, {
      ...RESET, continuation: paths.continuation,
    });
    expect(done.status).toBe("completed");
  });

  it("still resumes a readable staged key after the same crash", async () => {
    // The control: without the damage, the identical crash-and-resume sequence
    // completes, so the refusal above is caused by the fault and not the fixture.
    const paths = await pendingIntentUnit(root.dir);
    await crashAfterStaging(root.dir, paths.continuation);

    const done = await resetPreparationKeyEpochLocked(root.dir, {
      ...RESET, continuation: paths.continuation,
    });
    expect(done.status).toBe("completed");
  });
});

describe("superseding an intent-only unit after a partial clear", () => {
  it("still supersedes when bytes/ is already gone and the marker remains", async () => {
    // The exact mid-clear state: `bytes/` removed, marker still present. If the
    // classifier treated a missing `bytes/` as materialized, this unit would be
    // stranded — permanently unsupersedable, with no operation able to reach it.
    const paths = await pendingIntentUnit(root.dir);
    await mkdir(paths.bytesRoot, { recursive: true });
    await rmdir(paths.bytesRoot);

    const fresh = await supersede(root.dir);
    expect(fresh.status).toBe("intent-recorded");
  });

  it("clears the empty bytes/ directory and the marker together", async () => {
    // The whole-step control for the test above: from the full intent-only shape
    // WITH an empty bytes/ directory, superseding leaves neither behind. Without
    // this, the test above could pass because superseding never inspects bytes/.
    const paths = await pendingIntentUnit(root.dir);
    await mkdir(paths.bytesRoot, { recursive: true });

    await supersede(root.dir);

    // The superseded unit keeps its directory; what must be gone is the marker,
    // which is the single durable signal, and the empty bytes/ directory.
    const remaining = await readdir(paths.unitRoot);
    expect(remaining).not.toContain(path.basename(paths.bytesRoot));
    expect(remaining).not.toContain(path.basename(paths.resetIntentFile));
  });
});

/** Comfortably past the leaf reader's ceiling, so the read fails as unreadable. */
const OVERSIZE_BYTES = 5 * 1024 * 1024;
