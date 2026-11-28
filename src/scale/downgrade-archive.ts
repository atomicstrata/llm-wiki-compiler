/**
 * @file src/scale/downgrade-archive.ts
 * @description The ARCHIVE of an indexed scale-down (step A8) and its
 * receipt: after every incumbent file is installed and verified, the whole
 * `.llmwiki/indexed` directory (every store, batch run stores and their
 * reports included) and the pins directory are MOVED into the scale-down's
 * evidence directory, never deleted, so a later indexed preparation starts
 * from absent stores and no stale store is ever reused against changed files.
 *
 * ORDER. Each directory's identity is recorded in `archive.json` BEFORE its
 * rename; a resumed archive accepts only that identity, at the original or
 * the archived location. Then the archive is VERIFIED: `.llmwiki/indexed` is
 * gone, each archived directory is the recorded object, and its membership is
 * exactly the plan's stores, each manifest with the plan's digest. Only then
 * is the receipt written (create-only); a receipt already present must be
 * this scale-down's. The final activation follows the receipt.
 */

import path from "node:path";
import { INDEXED_DIR } from "../segments/contracts.js";
import { sha256Hex } from "../segments/format.js";
import { listConfinedDirBounded } from "../utils/confined-dir.js";
import { readConfinedLeafBuffer } from "../utils/confined-read.js";
import { MAX_SEGMENT_MANIFEST_BYTES } from "../segments/contracts.js";
import { ScaleDowngradeError, type DowngradeSeamFn } from "./downgrade-contracts.js";
import { at, finishMove, identityAt, renameBound, sameObject, type ObjectIdentityV1 } from "./downgrade-fs.js";
import {
  ARCHIVE_LEAF, checkpointArchive, readArchiveLeaf, recordArchiveLeaf, recordReceipt, type ArchiveLeafV1, type DowngradeReceiptV1, type StageManifestV1,
} from "./downgrade-journal.js";
import { mayHaveEvidenceAlias } from "./downgrade-evidence-write.js";
import type { DowngradePlanV1 } from "./downgrade-plan.js";

/** The pins directory (`../indexed/pins.ts` names the same path). */
const PINS_DIR = ".llmwiki/indexed-pins";
/** The segment manifest leaf of a store. */
const MANIFEST_LEAF = "manifest.json";

/** Refuse with a partial fault. */
function fault(message: string): never {
  throw new ScaleDowngradeError("scale_downgrade_partial", message);
}

/** The archived location of `.llmwiki/indexed` in `dir`. */
export function archivedIndexed(dir: string): string {
  return path.posix.join(dir, "indexed");
}

/** Derive the expected archive journal from the original directories, before either move. */
async function archiveInputs(root: string, dir: string, plan: string): Promise<ArchiveLeafV1> {
  if (await identityAt(root, archivedIndexed(dir)) !== null || await identityAt(root, path.posix.join(dir, "indexed-pins")) !== null) {
    fault("the archive targets must both be absent before recovering or creating its journal");
  }
  const indexed = await identityAt(root, INDEXED_DIR);
  if (indexed?.kind !== "directory") fault(`${INDEXED_DIR} is not the directory this scale-down archives`);
  const pins = await identityAt(root, PINS_DIR);
  if (pins !== null && pins.kind !== "directory") fault(`${PINS_DIR} is not a directory`);
  return { format: "llmwiki-scale-downgrade-archive", version: 1, plan, indexed, pins };
}

/** Checkpoint the archive journal before any move, including a positively bound publication retry. */
export async function prepareArchiveLeaf(root: string, dir: string, plan: string): Promise<ArchiveLeafV1> {
  const linked = await mayHaveEvidenceAlias(root, path.posix.join(dir, ARCHIVE_LEAF));
  const existing = linked ? null : await readArchiveLeaf(root, dir, plan);
  if (existing !== null) {
    await checkpointArchive(root, dir, existing);
    return existing;
  }
  const leaf = await archiveInputs(root, dir, plan);
  if (linked) await checkpointArchive(root, dir, leaf);
  else await recordArchiveLeaf(root, dir, { plan, indexed: leaf.indexed, pins: leaf.pins });
  return leaf;
}

/** Move the directory `from` to `to` while it is exactly `identity`, or confirm it already moved. */
async function moveDirectory(root: string, from: string, to: string, identity: ObjectIdentityV1, seam?: DowngradeSeamFn): Promise<void> {
  const archived = await identityAt(root, to);
  if (archived !== null && sameObject(archived, identity)) return finishMove(root, from, to);
  const original = await identityAt(root, from);
  if (original === null || !sameObject(original, identity)) fault(`${from} is neither in place nor archived`);
  await renameBound(root, from, to, identity, () => seam?.(`rename:${from}`) ?? Promise.resolve());
}

/** Refuse unless the archived stores are exactly the plan's, each manifest with the plan's digest. */
async function assertMembership(root: string, dir: string, plan: DowngradePlanV1): Promise<void> {
  const archived = archivedIndexed(dir);
  const listing = await listConfinedDirBounded(root, archived, plan.inventory.stores.length + 1);
  if (listing.kind !== "ok") fault(`${archived} cannot be listed`);
  const names = listing.entries.map((entry) => entry.name).sort();
  if (JSON.stringify(names) !== JSON.stringify(plan.inventory.stores.map((store) => store.name))) fault(`${archived} does not hold exactly the plan's stores`);
  for (const store of plan.inventory.stores) {
    const leaf = at(root, path.posix.join(archived, store.name, MANIFEST_LEAF));
    const read = await readConfinedLeafBuffer(root, leaf, path.dirname(leaf), MAX_SEGMENT_MANIFEST_BYTES, { requireSingleLink: true });
    if (read.kind !== "ok" || sha256Hex(read.body) !== store.manifestSha256) fault(`the archived manifest of ${store.name} is not the plan's`);
  }
}

/** Verify the archive: the indexed directory gone, each archived directory the recorded object, membership exact. */
async function verifyArchive(root: string, dir: string, plan: DowngradePlanV1, leaf: ArchiveLeafV1): Promise<void> {
  if ((await identityAt(root, INDEXED_DIR)) !== null) fault(`${INDEXED_DIR} still exists after the archive`);
  const indexed = await identityAt(root, archivedIndexed(dir));
  if (indexed === null || !sameObject(indexed, leaf.indexed)) fault("the archived indexed directory is not the recorded one");
  if (leaf.pins !== null) {
    const pins = await identityAt(root, path.posix.join(dir, "indexed-pins"));
    if (pins === null || !sameObject(pins, leaf.pins)) fault("the archived pins directory is not the recorded one");
  }
  await assertMembership(root, dir, plan);
}

/** Archive the indexed stores and pins of `root` into `dir` (A8), verified; returns the archive leaf. */
export async function archiveIndexed(root: string, dir: string, plan: DowngradePlanV1, seam?: DowngradeSeamFn): Promise<ArchiveLeafV1> {
  const leaf = await prepareArchiveLeaf(root, dir, plan.digest);
  await moveDirectory(root, INDEXED_DIR, archivedIndexed(dir), leaf.indexed, seam);
  if (leaf.pins !== null) await moveDirectory(root, PINS_DIR, path.posix.join(dir, "indexed-pins"), leaf.pins, seam);
  await verifyArchive(root, dir, plan, leaf);
  return leaf;
}

/** The receipt of this scale-down: written once after the verified archive, or confirmed. */
export async function ensureReceipt(root: string, dir: string, plan: DowngradePlanV1, fenceRevision: number, leaf: ArchiveLeafV1, stage: StageManifestV1): Promise<DowngradeReceiptV1> {
  const receipt = {
    plan: plan.digest, target: plan.inventory.target, fenceRevision,
    archive: { indexed: leaf.indexed, pins: leaf.pins, stores: plan.inventory.stores.map((store) => store.name) },
    runs: plan.inventory.runs, lastRun: plan.inventory.lastRun, pinLabels: plan.inventory.pins.labels, units: stage.units, priors: stage.priors,
  };
  await recordReceipt(root, dir, receipt);
  return { format: "llmwiki-scale-downgrade-receipt", version: 1, ...receipt };
}
