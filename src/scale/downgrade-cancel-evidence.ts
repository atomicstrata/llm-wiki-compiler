/**
 * @file src/scale/downgrade-cancel-evidence.ts
 * @description The EVIDENCE DIRECTORY a pre-install cancel relies on, read
 * strictly and confined, never trusted by name alone (design v2 §7, Root
 * correction 3).
 *
 * - The directory is listed IN FULL. Only `plan.json`, `attempt-<n>`
 *   directories and the cancel's own named leaves may be there, each of its
 *   expected kind; anything else refuses. Nothing is ever deleted.
 * - `plan.json` must parse as exactly the held plan.
 * - Attempt names are canonical: `attempt-1` to `attempt-1000`, no leading
 *   zero (`attempt-01`, `attempt-0` and `attempt-1001` are unknown names).
 * - Each attempt directory may hold only `staged/` and an optional
 *   `stage.json`. A `stage.json` is read for THAT attempt (its recorded number
 *   must be the directory's) and must bind exactly the plan's units and prior
 *   files (`assertStageMatchesPlan`). Every staged file must sit at the staged
 *   path of one of the plan's present units, as a regular single-link file,
 *   and every directory under `staged/` must be an ancestor of such a path:
 *   an unknown directory refuses even when it is EMPTY. Any other path or
 *   kind refuses.
 * - At most ONE attempt is complete, and it is the LATEST: staging creates a
 *   new attempt only while no complete one exists (`latestStage`), so a
 *   complete attempt followed by another, or two complete attempts, is
 *   evidence this code never wrote, and refuses.
 * - In the complete attempt, every staged object must still be at its staged
 *   path with the identity the manifest bound: installation moves it away, so
 *   a missing or different object means installation may have begun.
 */

import { lstat } from "node:fs/promises";
import path from "node:path";
import { listConfinedDirBounded } from "../utils/confined-dir.js";
import { readConfinedLeafBuffer } from "../utils/confined-read.js";
import { MAX_DOWNGRADE_PLAN_BYTES, ScaleDowngradeError } from "./downgrade-contracts.js";
import { at, identityAt, sameObject } from "./downgrade-fs.js";
import { CANCEL_LEAF, readStageOf, stagedPath, type StageManifestV1 } from "./downgrade-journal.js";
import { parseDowngradePlan, type DowngradePlanV1 } from "./downgrade-plan.js";
import { assertStageMatchesPlan } from "./downgrade-stage.js";

/** Most staging attempts one scale-down keeps (the journal's own cap). */
const MAX_ATTEMPTS = 1_000;
/** Most entries an evidence or staged directory may hold. */
const MAX_ENTRIES = 10_000;
/** A canonical attempt directory's name (no leading zero; the number is checked against MAX_ATTEMPTS too). */
const ATTEMPT = /^attempt-([1-9]\d{0,3})$/u;
/** The plan leaf of every evidence directory. */
const PLAN_LEAF = "plan.json";

/** Refuse a cancel whose proof clause failed; nothing was written. */
export function notCancellable(clause: string, detail: string): never {
  throw new ScaleDowngradeError("scale_downgrade_not_cancellable", `${clause}: ${detail}; nothing was written`);
}

/** Refuse unless `plan.json` in `dir` is a confined regular single-link file holding exactly `plan`. */
export async function assertPlanLeaf(root: string, dir: string, plan: DowngradePlanV1): Promise<void> {
  const leaf = at(root, path.posix.join(dir, PLAN_LEAF));
  const read = await readConfinedLeafBuffer(root, leaf, path.dirname(leaf), MAX_DOWNGRADE_PLAN_BYTES, { requireSingleLink: true });
  if (read.kind !== "ok") notCancellable("P7", `${dir}/${PLAN_LEAF} is not a readable plan`);
  let digest: string;
  try { digest = parseDowngradePlan(read.body.toString("utf8"), root).digest; } catch { return notCancellable("P7", `${dir}/${PLAN_LEAF} does not parse as a plan`); }
  if (digest !== plan.digest) notCancellable("P7", `${dir}/${PLAN_LEAF} holds another plan`);
}

/**
 * The attempt numbers of evidence directory `dir`, ascending, after checking
 * every entry: `plan.json` (required), `attempt-<n>` directories, and the
 * names in `ownLeaves` (this cancel's leaves the caller expects), all files.
 */
export async function evidenceAttempts(root: string, dir: string, plan: DowngradePlanV1, ownLeaves: readonly string[]): Promise<number[]> {
  const listing = await listConfinedDirBounded(root, dir, MAX_ATTEMPTS + 8);
  if (listing.kind !== "ok") return notCancellable("P7", `${dir} cannot be listed in full`);
  const attempts: number[] = [];
  for (const entry of listing.entries) {
    const match = ATTEMPT.exec(entry.name);
    if (match !== null && entry.kind === "directory" && Number(match[1]) <= MAX_ATTEMPTS) attempts.push(Number(match[1]));
    else if (entry.kind !== "file" || (entry.name !== PLAN_LEAF && !ownLeaves.includes(entry.name))) notCancellable("P7", `${dir} holds an unexpected ${entry.kind} ${entry.name.slice(0, 80)}`);
  }
  if (!listing.entries.some((entry) => entry.name === PLAN_LEAF)) notCancellable("P7", `${dir} has no ${PLAN_LEAF}`);
  await assertPlanLeaf(root, dir, plan);
  return attempts.sort((a, b) => a - b);
}

/** Every directory that is an ancestor of one of `files`, below `top` (exclusive of the files themselves). */
function ancestorsUnder(top: string, files: ReadonlySet<string>): Set<string> {
  const dirs = new Set<string>();
  for (const file of files) {
    for (let dir = path.posix.dirname(file); dir.startsWith(`${top}/`); dir = path.posix.dirname(dir)) dirs.add(dir);
  }
  return dirs;
}

/**
 * Every file under `relDir` (confined, recursive), refusing any entry that is
 * neither a regular file nor a directory in `allowedDirs` (an ancestor of a
 * unit's staged path), so an unknown directory refuses even when empty.
 */
async function filesUnder(root: string, relDir: string, allowedDirs: ReadonlySet<string>, budget: { left: number }): Promise<string[]> {
  const listing = await listConfinedDirBounded(root, relDir, MAX_ENTRIES);
  if (listing.kind === "absent") return [];
  if (listing.kind !== "ok") return notCancellable("P7", `${relDir} cannot be listed in full`);
  const files: string[] = [];
  for (const entry of listing.entries) {
    budget.left -= 1;
    if (budget.left < 0) notCancellable("P7", `${relDir} holds more entries than a staging attempt can`);
    const child = path.posix.join(relDir, entry.name);
    if (entry.kind === "directory" && !allowedDirs.has(child)) notCancellable("P7", `${child} is a directory no staged unit path passes through`);
    if (entry.kind === "directory") files.push(...await filesUnder(root, child, allowedDirs, budget));
    else if (entry.kind === "file") files.push(child);
    else notCancellable("P7", `${child} is a ${entry.kind}`);
  }
  return files;
}

/** Refuse unless the file at `relPath` is a regular file with exactly one link. */
async function assertSingleLinkFile(root: string, relPath: string): Promise<void> {
  const stat = await lstat(at(root, relPath), { bigint: true }).catch(() => null);
  if (stat === null || !stat.isFile() || stat.nlink !== 1n) notCancellable("P7", `${relPath} is not a regular single-link file`);
}

/** One attempt directory of an evidence directory: the evidence directory, the attempt number and its own path. */
interface AttemptRef {
  readonly dir: string;
  readonly attempt: number;
  readonly relDir: string;
}

/** Whether an attempt directory entry is one it may hold: the `staged` directory or the `stage.json` file. */
function isAttemptEntry(entry: { readonly name: string; readonly kind: string }): boolean {
  return (entry.name === "staged" && entry.kind === "directory") || (entry.name === "stage.json" && entry.kind === "file");
}

/** Refuse unless the attempt directory lists in full and holds nothing but its expected entries. */
async function assertAttemptListing(root: string, relDir: string): Promise<void> {
  const listing = await listConfinedDirBounded(root, relDir, 2);
  if (listing.kind !== "ok") return notCancellable("P7", `${relDir} cannot be listed`);
  for (const entry of listing.entries) {
    if (!isAttemptEntry(entry)) notCancellable("P7", `${relDir} holds an unexpected ${entry.kind} ${entry.name.slice(0, 80)}`);
  }
}

/** The attempt's stage manifest (null while the attempt is incomplete); one that does not bind exactly the plan refuses. */
async function matchingManifest(root: string, plan: DowngradePlanV1, ref: AttemptRef): Promise<StageManifestV1 | null> {
  const manifest = await readStageOf(root, ref.dir, ref.attempt, plan.digest);
  if (manifest !== null) {
    try { assertStageMatchesPlan(manifest, plan); } catch (error) { notCancellable("P7", `${ref.relDir}/stage.json: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return manifest;
}

/** Refuse unless every file under the attempt's `staged/` is the staged path of a present plan unit, as a regular single-link file. */
async function assertStagedFiles(root: string, plan: DowngradePlanV1, ref: AttemptRef): Promise<void> {
  const allowed = new Set(plan.inventory.units.filter((unit) => unit.present).map((unit) => stagedPath(ref.dir, ref.attempt, unit.relPath)));
  const stagedTop = path.posix.join(ref.relDir, "staged");
  for (const file of await filesUnder(root, stagedTop, ancestorsUnder(stagedTop, allowed), { left: MAX_ENTRIES })) {
    if (!allowed.has(file)) notCancellable("P7", `${file} is not the staged path of one of the plan's units`);
    await assertSingleLinkFile(root, file);
  }
}

/** Check one attempt directory (its listing, its manifest, then its staged files); returns its manifest when it is complete. */
async function attemptEvidence(root: string, dir: string, plan: DowngradePlanV1, attempt: number): Promise<StageManifestV1 | null> {
  const ref: AttemptRef = { dir, attempt, relDir: path.posix.join(dir, `attempt-${attempt}`) };
  await assertAttemptListing(root, ref.relDir);
  const manifest = await matchingManifest(root, plan, ref);
  await assertStagedFiles(root, plan, ref);
  return manifest;
}

/** Refuse unless every staged object of the complete `manifest` is still at its staged path, as the object it bound. */
async function assertStagedInPlace(root: string, dir: string, manifest: StageManifestV1): Promise<void> {
  for (const unit of manifest.units) {
    if (unit.staged === null) continue;
    const found = await identityAt(root, stagedPath(dir, manifest.attempt, unit.relPath));
    if (found === null || !sameObject(found, unit.staged)) notCancellable("P6", `the staged file of ${unit.relPath} is not where staging left it (installation may have begun)`);
  }
}

/**
 * The complete stage manifest the cancel relies on, or null when no attempt is
 * complete, after checking the whole evidence directory (see the file comment).
 */
export async function stagingEvidence(root: string, dir: string, plan: DowngradePlanV1, ownLeaves: readonly string[]): Promise<StageManifestV1 | null> {
  const attempts = await evidenceAttempts(root, dir, plan, ownLeaves);
  const complete: StageManifestV1[] = [];
  for (const attempt of attempts) {
    const manifest = await attemptEvidence(root, dir, plan, attempt);
    if (manifest !== null) complete.push(manifest);
  }
  if (complete.length > 1) notCancellable("P7", `${dir} holds ${complete.length} complete staging attempts`);
  const [manifest] = complete;
  if (manifest === undefined) return null;
  if (manifest.attempt !== attempts[attempts.length - 1]) notCancellable("P7", `${dir} holds an attempt after the complete attempt ${manifest.attempt}`);
  await assertStagedInPlace(root, dir, manifest);
  return manifest;
}

/** Re-export the cancel fence for the existing apply and bootstrap callers. */
export { assertNotCancelled } from "./downgrade-journal.js";
