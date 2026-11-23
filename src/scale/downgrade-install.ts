/**
 * @file src/scale/downgrade-install.ts
 * @description INSTALLATION of a staged scale-down (steps A6 and A7), driven
 * entirely by the stage manifest's recorded identities, so an interrupted
 * installation resumes by looking, never by trusting a progress counter.
 *
 * For each path, in the manifest's fixed order:
 * 1. its PRIOR file (when one was present) is moved to `prior/<relPath>` by an
 *    identity-bound rename: done when the prior location already holds that
 *    exact object, moved when the path still holds it, a fault otherwise;
 * 2. its STAGED file (when the unit has one) is moved into place by an
 *    identity-bound rename: installed when the path holds exactly the staged
 *    object AND its bytes have the plan's digest, moved when the path is empty
 *    and the staged location holds it, a fault otherwise. An unrelated file at
 *    the path (even with equal bytes) is never adopted.
 * Then every installed file is read back by the incumbent strict reader
 * (A7), from the path itself, with no routed read. A path whose unit has no
 * file must be empty. A move found ALREADY done has both parents synced again
 * before it is relied on. Nothing is rewritten in place and nothing is deleted.
 */

import path from "node:path";
import { ScaleDowngradeError, type DowngradeSeamFn } from "./downgrade-contracts.js";
import { ensureDirectory, finishMove, identityAt, leafDigest, renameBound, sameObject, type ObjectIdentityV1 } from "./downgrade-fs.js";
import { priorPath, stagedPath, type PriorFileV1, type StagedUnitV1, type StageManifestV1 } from "./downgrade-journal.js";
import { readWhole, verifyUnitBytes } from "./downgrade-stage.js";
import { unitCap } from "./downgrade-units.js";

/** Refuse with a partial fault naming what was found. */
function fault(message: string): never {
  throw new ScaleDowngradeError("scale_downgrade_partial", message);
}

/** Whether `relPath` holds exactly `expected`. */
async function holds(root: string, relPath: string, expected: ObjectIdentityV1): Promise<boolean> {
  const current = await identityAt(root, relPath);
  return current !== null && sameObject(current, expected);
}

/** Move one prior file aside, or confirm it already was. */
async function retirePrior(root: string, dir: string, prior: PriorFileV1, seam?: DowngradeSeamFn): Promise<void> {
  if (prior.identity === null) return;
  const retained = priorPath(dir, prior.relPath);
  if (await holds(root, retained, prior.identity)) return finishMove(root, prior.relPath, retained);
  if (!(await holds(root, prior.relPath, prior.identity))) fault(`the prior file ${prior.relPath} is neither in place nor retained`);
  await ensureDirectory(root, path.posix.dirname(retained));
  await renameBound(root, prior.relPath, retained, prior.identity, () => seam?.(`rename:${prior.relPath}`) ?? Promise.resolve());
}

/** Whether `relPath` holds the staged object of `unit` with the plan's digest. */
async function installed(root: string, unit: StagedUnitV1): Promise<boolean> {
  if (!(await holds(root, unit.relPath, unit.staged!))) return false;
  const digest = await leafDigest(root, unit.relPath);
  return digest.kind === "ok" && digest.sha256 === unit.sha256 ? true : fault(`${unit.relPath} holds the staged file but not the plan's bytes`);
}

/** Move one staged file into place, or confirm it already was; a unit without a file needs an empty path. */
async function installUnit(root: string, dir: string, attempt: number, unit: StagedUnitV1, seam?: DowngradeSeamFn): Promise<void> {
  if (unit.staged === null) {
    if ((await identityAt(root, unit.relPath)) !== null) fault(`${unit.relPath} should be empty in the smaller layout but holds something`);
    return;
  }
  const staged = stagedPath(dir, attempt, unit.relPath);
  if (await installed(root, unit)) return finishMove(root, staged, unit.relPath);
  if ((await identityAt(root, unit.relPath)) !== null) fault(`${unit.relPath} holds a file this scale-down did not stage`);
  if (!(await holds(root, staged, unit.staged))) fault(`the staged file of ${unit.relPath} is missing or changed`);
  await ensureDirectory(root, path.posix.dirname(unit.relPath));
  await renameBound(root, staged, unit.relPath, unit.staged, () => seam?.(`rename:${unit.relPath}`) ?? Promise.resolve());
}

/** Install every prior and staged file of `manifest` (A6). */
export async function installStage(root: string, dir: string, manifest: StageManifestV1, seam?: DowngradeSeamFn): Promise<void> {
  for (const prior of manifest.priors) await retirePrior(root, dir, prior, seam);
  for (const unit of manifest.units) await installUnit(root, dir, manifest.attempt, unit, seam);
}

/** Verify every installed file at its own path with the incumbent reader (A7). */
export async function verifyInstalled(root: string, manifest: StageManifestV1): Promise<void> {
  for (const unit of manifest.units) {
    if (unit.staged === null) continue;
    if (!(await installed(root, unit))) fault(`${unit.relPath} is not the installed staged file`);
    const file = { relPath: unit.relPath, present: true, bytes: unit.bytes, sha256: unit.sha256, records: unit.records, cap: unitCap(unit.kind), headDigest: unit.headDigest ?? null };
    await verifyUnitBytes(root, unit, file, await readWhole(root, unit.relPath, file.cap));
  }
}
