/**
 * @file Reconstruct a stage journal body from the already bound plan and
 * files that have not moved. This reads no part of the interrupted manifest.
 * The publication writer must still compare its exact bytes and names.
 */
import { realpath } from "node:fs/promises";
import path from "node:path";
import { INDEXED_DIR } from "../segments/contracts.js";
import { listConfinedDirBounded, type ConfinedDirEntry } from "../utils/confined-dir.js";
import { resolveRealDir } from "../utils/path-confine.js";
import { durableTempPath } from "../utils/atomic-write-no-replace-durable.js";
import { ScaleDowngradeError } from "./downgrade-contracts.js";
import { leafDigest, type ObjectIdentityV1 } from "./downgrade-fs.js";
import type { StageManifestV1 } from "./downgrade-journal.js";
import type { DowngradePlanV1 } from "./downgrade-plan.js";

/** Refuse without changing any stage names. */
function refuse(relative: string, reason: string): never {
  throw new ScaleDowngradeError("scale_downgrade_partial", `${relative}: ${reason}; retain the staging evidence`);
}

/** Accept only the file or absence named by the plan, with a read bounded by its exact length. */
async function sourceIdentity(root: string, relative: string, sha256: string | null, bytes: number): Promise<ObjectIdentityV1 | null> {
  const read = await leafDigest(root, relative, bytes);
  if (sha256 === null && bytes === 0 && read.kind === "absent") return null;
  if (sha256 !== null && read.kind === "ok" && read.bytes === bytes && read.sha256 === sha256) return read.identity;
  return refuse(relative, "file no longer matches the plan before installation");
}

/** Build only the expected directory and file names of this attempt. */
function stageTree(manifest: Pick<StageManifestV1, "units">): Map<string, Map<string, ConfinedDirEntry["kind"]>> {
  const directories = new Map<string, Map<string, ConfinedDirEntry["kind"]>>([
    [".", new Map([["stage.json", "file"], [durableTempPath("stage.json"), "file"]])],
  ]);
  for (const unit of manifest.units) {
    if (unit.staged === null) continue;
    let child = path.posix.join("staged", unit.relPath);
    let kind: ConfinedDirEntry["kind"] = "file";
    while (child !== ".") {
      const parent = path.posix.dirname(child);
      const entries = directories.get(parent) ?? new Map<string, ConfinedDirEntry["kind"]>();
      entries.set(path.posix.basename(child), kind);
      directories.set(parent, entries);
      child = parent;
      kind = "directory";
    }
  }
  return directories;
}

/** Require the complete expected attempt tree without following directory aliases. */
async function assertStageTree(root: string, attemptDir: string, manifest: Pick<StageManifestV1, "units">): Promise<void> {
  for (const [directory, expected] of stageTree(manifest)) {
    const relative = path.posix.join(attemptDir, directory);
    const listing = await listConfinedDirBounded(root, relative, expected.size);
    if (listing.kind !== "ok" || listing.entries.length !== expected.size
        || listing.entries.some(({ name, kind }) => expected.get(name) !== kind)) {
      refuse(relative, "attempt tree contains missing or foreign entries");
    }
  }
}

/** Reject aliases at any component of a directory path. */
async function isRealProjectDir(root: string, relative: string): Promise<boolean> {
  const directory = await resolveRealDir(root, relative);
  return directory !== null && await realpath(directory).catch(() => null) === path.join(root, relative);
}

/** Derive the original publisher's inputs without taking identities or digests from the journal leaf. */
export async function stageBeforeInstall(root: string, attemptDir: string, plan: DowngradePlanV1): Promise<Pick<StageManifestV1, "units" | "priors">> {
  if (root !== plan.root || !(await isRealProjectDir(root, attemptDir)) || !(await isRealProjectDir(root, INDEXED_DIR))) {
    refuse(attemptDir, "stage and indexed parents must still be real project directories");
  }
  const units: StageManifestV1["units"][number][] = [];
  for (const unit of plan.inventory.units) {
    const relative = path.posix.join(attemptDir, "staged", unit.relPath);
    const staged = await sourceIdentity(root, relative, unit.sha256, unit.bytes);
    if (unit.present !== (staged !== null)) refuse(relative, "staged presence differs from the plan");
    units.push({ ...unit, staged });
  }
  await assertStageTree(root, attemptDir, { units });
  const priors: StageManifestV1["priors"][number][] = [];
  for (const { relPath, sha256, bytes } of plan.inventory.priors) {
    priors.push({ relPath, sha256, identity: await sourceIdentity(root, relPath, sha256, bytes) });
  }
  return { units, priors };
}
