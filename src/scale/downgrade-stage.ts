/**
 * @file src/scale/downgrade-stage.ts
 * @description STAGING of an indexed scale-down (step A5): every export unit
 * of the plan streamed into a create-only, durable file of a FRESH attempt
 * directory, then re-read and verified by the incumbent strict reader of
 * that file (`./downgrade-verify.ts`), then bound by identity and digest in
 * the attempt's create-only stage manifest (`./downgrade-journal.ts`).
 *
 * Runs under the fence, inside the scale-down's private access scope (the
 * exports read the indexed stores the fence keeps unchanged). Every staged
 * file must reproduce EXACTLY the digest the plan measured; any difference is
 * a fault (`scale_downgrade_partial`), never adopted. A unit the plan
 * measured as absent writes no file. The prior files are bound by identity
 * and their plan digest at the same time. An interrupted attempt is left as
 * evidence; the next stage uses a new attempt directory.
 */

import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { atomicStreamCreateOnlyDurable } from "../utils/atomic-write.js";
import { readConfinedLeafBuffer } from "../utils/confined-read.js";
import { ScaleDowngradeError, type DowngradeUnitV1 } from "./downgrade-contracts.js";
import type { ExportedEvents } from "./downgrade-export-history.js";
import { at, ensureDirectory, identityAt, leafDigest } from "./downgrade-fs.js";
import { recordStage, stagedPath, type PriorFileV1, type StagedUnitV1, type StageManifestV1 } from "./downgrade-journal.js";
import type { DowngradePlanV1 } from "./downgrade-plan.js";
import { ExportSink, type ExportedFile } from "./downgrade-sink.js";
import { routinesOf, type UnitRoutine } from "./downgrade-units.js";
import { verifyCatalogBytes, verifyCompileStateBytes, verifyEventsBytes, verifyRelationsBytes, verifyVectorBytes } from "./downgrade-verify.js";

/** Refuse with a partial fault. */
function fault(message: string): never {
  throw new ScaleDowngradeError("scale_downgrade_partial", message);
}

/** The routine of `unit` among `routines` (same kind and workspace). */
function routineFor(routines: readonly UnitRoutine[], unit: DowngradeUnitV1): UnitRoutine {
  const routine = routines.find((candidate) => candidate.kind === unit.kind && candidate.workspaceId === unit.workspaceId);
  return routine ?? fault(`the plan's ${unit.kind} unit ${unit.relPath} has no export`);
}

/** Verify `bytes` of `unit` with the incumbent reader of its file. */
export async function verifyUnitBytes(root: string, unit: DowngradeUnitV1, file: ExportedFile, bytes: Buffer): Promise<void> {
  if (unit.kind === "events") return verifyEventsBytes(root, bytes, file as ExportedEvents);
  if (unit.kind === "relations") return verifyRelationsBytes(bytes, file);
  if (unit.kind === "catalog") return verifyCatalogBytes(bytes, file);
  if (unit.kind === "state") return verifyCompileStateBytes(bytes, file);
  return verifyVectorBytes(bytes, file);
}

/** Read the file at `relPath` whole within `cap` (the incumbent readers read it whole too). */
export async function readWhole(root: string, relPath: string, cap: number): Promise<Buffer> {
  const read = await readConfinedLeafBuffer(root, at(root, relPath), path.dirname(at(root, relPath)), cap, { requireSingleLink: true });
  return read.kind === "ok" ? read.body : fault(`${relPath} cannot be read back within its ${cap}-byte cap`);
}

/** Write every byte of `chunk` at the handle's position, looping over short writes. */
async function writeAll(handle: FileHandle, chunk: Buffer): Promise<void> {
  for (let offset = 0; offset < chunk.byteLength;) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);
    if (bytesWritten <= 0) fault("a staged export write made no progress");
    offset += bytesWritten;
  }
}

/** Export one present unit into its staged file; returns the export. */
async function writeStaged(root: string, routine: UnitRoutine, staged: string): Promise<ExportedFile> {
  await ensureDirectory(root, path.posix.dirname(staged));
  let file: ExportedFile | undefined;
  await atomicStreamCreateOnlyDurable(path.dirname(at(root, staged)), path.basename(staged), async (handle) => {
    file = await routine.run((relPath, cap) => new ExportSink(relPath, cap, (chunk) => writeAll(handle, chunk)));
    return file.bytes;
  }, { confineRoot: root, mode: 0o600 });
  return file ?? fault(`${staged} was not produced`);
}

/** Stage one unit: write, read back, verify, and bind it to the plan's digest. */
async function stageUnit(root: string, routine: UnitRoutine, unit: DowngradeUnitV1, staged: string): Promise<StagedUnitV1> {
  if (!unit.present) {
    const file = await routine.run((relPath, cap) => new ExportSink(relPath, cap));
    return file.present ? fault(`${unit.relPath} gained content since the plan`) : { ...unit, staged: null };
  }
  const file = await writeStaged(root, routine, staged);
  const bytes = await readWhole(root, staged, file.cap);
  await verifyUnitBytes(root, unit, file, bytes);
  if (file.sha256 !== unit.sha256 || file.records !== unit.records || (file as Partial<ExportedEvents>).headDigest !== unit.headDigest) fault(`${unit.relPath} does not reproduce the plan's export`);
  const identity = await identityAt(root, staged);
  return identity?.kind === "file" ? { ...unit, staged: identity } : fault(`${staged} vanished after it was written`);
}

/** Bind each prior file to the plan's digest by identity. */
async function bindPriors(root: string, plan: DowngradePlanV1): Promise<PriorFileV1[]> {
  const priors: PriorFileV1[] = [];
  for (const prior of plan.inventory.priors) {
    const digest = await leafDigest(root, prior.relPath);
    const sha256 = digest.kind === "ok" ? digest.sha256 : null;
    if (digest.kind === "unavailable" || sha256 !== prior.sha256) fault(`the prior file ${prior.relPath} changed since the plan`);
    priors.push({ relPath: prior.relPath, sha256, identity: digest.kind === "ok" ? digest.identity : null });
  }
  return priors;
}

/** Stage every unit of `plan` as attempt `attempt` of `dir`, then record and return its manifest. */
export async function stageExports(root: string, plan: DowngradePlanV1, dir: string, attempt: number): Promise<StageManifestV1> {
  const units = plan.inventory.units;
  const workspaces = units.filter((unit) => unit.kind === "catalog").map((unit) => unit.workspaceId!);
  const routines = routinesOf(root, { workspaces, segmentedState: units.some((unit) => unit.kind === "state") });
  const staged: StagedUnitV1[] = [];
  for (const unit of units) staged.push(await stageUnit(root, routineFor(routines, unit), unit, stagedPath(dir, attempt, unit.relPath)));
  const manifest = { plan: plan.digest, attempt, units: staged, priors: await bindPriors(root, plan) };
  await recordStage(root, dir, manifest);
  return { format: "llmwiki-scale-downgrade-stage", version: 1, ...manifest };
}

/** Refuse a stage manifest that does not bind exactly the plan's units and priors. */
export function assertStageMatchesPlan(manifest: StageManifestV1, plan: DowngradePlanV1): void {
  /** The fields of a unit a stage manifest must reproduce from the plan. */
  const strip = (unit: DowngradeUnitV1) => [unit.kind, unit.relPath, unit.workspaceId ?? null, unit.present, unit.bytes, unit.sha256, unit.records, unit.headDigest ?? null];
  const sameUnits = JSON.stringify(manifest.units.map(strip)) === JSON.stringify(plan.inventory.units.map(strip));
  const samePriors = JSON.stringify(manifest.priors.map((prior) => [prior.relPath, prior.sha256])) === JSON.stringify(plan.inventory.priors.map((prior) => [prior.relPath, prior.sha256]));
  if (!sameUnits || !samePriors) fault("the stage manifest does not bind this plan's units and prior files");
}
