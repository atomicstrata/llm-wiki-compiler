/**
 * @file src/scale/downgrade-archive-reader.ts
 * @description READ-ONLY access to the archives a scale-down retained, so
 * batch run reports stay pageable on the smaller layout.
 *
 * - {@link listScaleArchives}: every evidence directory under
 *   `.llmwiki/scale-downgrade/` that holds a completed scale-down: its plan
 *   parsed strictly (digest recomputed) and its receipt cross-bound to that
 *   plan (fence revision, target, runs, last run, archived stores),
 *   with the target, fence revision, archived run inventory and the compile
 *   state's last run (which `state.json` has no field for).
 * - {@link readArchivedReport}: one page of an archived run's report, read by
 *   the SAME report reader `compile --report` uses (its capped, closed line
 *   validation and its cursors), through an IMMUTABLE store view rooted at the
 *   archived run store. Before any read, the archived indexed directory must
 *   still be exactly the object the receipt names and the run must be one the
 *   receipt lists. The run store's manifest must be exactly the one the bound
 *   plan recorded (its SHA-256 over the same confined bytes the parser gets),
 *   so an older checkpoint restored beneath the unchanged directory refuses.
 *
 * The archived view has no write, publication or collection: those members
 * throw `indexed_store_invalid_write`. It registers no reader lease (nothing
 * ever collects, retires or restores an archive) and opens every leaf through
 * the confined, no-follow, single-link open.
 */

import { createHash } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readReport, type ReportPageV1 } from "../compiler/batch/report.js";
import { RUN_STORE_PREFIX } from "../compiler/batch/contracts.js";
import { IndexedStoreError, MANIFEST_LEAF, MAX_SEGMENT_MANIFEST_BYTES, STORE_NAME_PATTERN } from "../segments/contracts.js";
import { listStoreLeaves, positionedReader, type SegmentStoreIo } from "../segments/io.js";
import { canonicalRoot } from "../segments/reader-lease.js";
import { listConfinedDirBounded } from "../utils/confined-dir.js";
import { openConfinedLeaf, readConfinedLeafBuffer } from "../utils/confined-read.js";
import { archivedIndexed } from "./downgrade-archive.js";
import { DOWNGRADE_DIR, MAX_DOWNGRADE_PLAN_BYTES, ScaleDowngradeError, type DowngradeRunV1 } from "./downgrade-contracts.js";
import { at, identityAt, sameObject } from "./downgrade-fs.js";
import { readReceipt, type DowngradeReceiptV1 } from "./downgrade-journal.js";
import { parseDowngradePlan, type DowngradePlanV1 } from "./downgrade-plan.js";

/** Most evidence directories one listing reads. */
const MAX_ARCHIVES = 1_000;
/** Most leaves one archived store lists. */
const MAX_STORE_LEAVES = 100_000;
/** Hex digits of an archive cursor's binding. */
const CURSOR_BINDING_CHARS = 24;

/** One retained scale-down archive. */
export interface ScaleArchiveV1 {
  /** The evidence directory's name under `.llmwiki/scale-downgrade/`. */
  readonly name: string;
  readonly target: string;
  readonly fenceRevision: number;
  readonly runs: readonly DowngradeRunV1[];
  readonly lastRun: string | null;
}

/** Refuse a write to an archived store. */
function immutable(): never {
  throw new IndexedStoreError("indexed_store_invalid_write", "an archived store is read-only");
}

/** The immutable store view of `store` in the archived indexed directory `relDir`, its manifest bytes required to have SHA-256 `manifestSha256`. */
function archivedStoreIo(root: string, relDir: string, store: string, manifestSha256: string): SegmentStoreIo {
  if (!STORE_NAME_PATTERN.test(store)) throw new IndexedStoreError("indexed_store_invalid_write", `invalid store name ${store}`);
  const dir = at(root, path.posix.join(relDir, store));
  return {
    store,
    readManifest: async () => {
      const read = await readConfinedLeafBuffer(root, path.join(dir, MANIFEST_LEAF), dir, MAX_SEGMENT_MANIFEST_BYTES, { requireSingleLink: true });
      if (read.kind === "unavailable") throw new IndexedStoreError("indexed_store_unavailable", `the archived manifest of ${store} is unreadable`);
      if (read.kind === "absent") return { kind: "absent" };
      // The digest is taken over exactly the bytes handed to the parser: no second open can differ.
      if (createHash("sha256").update(read.body).digest("hex") !== manifestSha256) invalid(`the archived manifest of ${store} is not the one its plan recorded`);
      return { kind: "ok", bytes: read.body };
    },
    openSegment: async (name) => {
      const opened = await openConfinedLeaf(root, path.join(dir, name), dir, { requireSingleLink: true });
      if (opened.kind !== "confirmed") throw new IndexedStoreError("indexed_store_corrupt", `archived segment ${store}/${name} is missing or not a confined regular file`);
      return positionedReader(opened.handle, opened.size);
    },
    writeSegment: async () => immutable(),
    publishManifest: async () => immutable(),
    listLeaves: (max) => listStoreLeaves(root, path.posix.join(relDir, store), Math.min(max, MAX_STORE_LEAVES)),
  };
}

/** One archive: its evidence directory, its strictly parsed plan, and its receipt cross-bound to that plan. */
interface BoundArchive {
  readonly dir: string;
  readonly plan: DowngradePlanV1;
  readonly receipt: DowngradeReceiptV1;
}

/** Refuse an archive that is not what it claims. */
function invalid(message: string): never {
  throw new ScaleDowngradeError("scale_downgrade_archive_invalid", message);
}

/** Refuse unless `receipt` says exactly what `plan` planned for fence revision `fence`. */
function assertCrossBound(name: string, plan: DowngradePlanV1, receipt: DowngradeReceiptV1, fence: number): void {
  const { inventory } = plan;
  const bound = receipt.fenceRevision === fence && inventory.record.revision + 1 === fence && receipt.target === inventory.target && receipt.lastRun === inventory.lastRun
    && isDeepStrictEqual(receipt.runs, inventory.runs) && isDeepStrictEqual(receipt.archive.stores, inventory.stores.map((store) => store.name));
  if (!bound) invalid(`archive ${name}: its receipt does not match its plan`);
}

/** The archive named `name`, or null when the directory holds no completed scale-down (no plan or no receipt). */
async function archiveOf(root: string, name: string): Promise<BoundArchive | null> {
  const match = /^(\d{1,16})-([0-9a-f]{12})$/.exec(name);
  if (match === null) return null;
  const dir = path.posix.join(DOWNGRADE_DIR, name);
  const read = await readConfinedLeafBuffer(root, at(root, `${dir}/plan.json`), at(root, dir), MAX_DOWNGRADE_PLAN_BYTES, { requireSingleLink: true });
  if (read.kind === "absent") return null;
  if (read.kind !== "ok") invalid(`archive ${name}: its plan cannot be read`);
  const plan = parseDowngradePlan(read.body.toString("utf8"), root);
  if (!plan.digest.startsWith(match[2]!)) invalid(`archive ${name}: its plan is another scale-down's`);
  const receipt = await readReceipt(root, dir, plan.digest);
  if (receipt === null) return null;
  assertCrossBound(name, plan, receipt, Number(match[1]));
  return { dir, plan, receipt };
}

/** The manifest SHA-256 the bound plan recorded for archived store `store` (refused when it records none). */
function plannedManifest(name: string, archive: BoundArchive, store: string): string {
  const entry = archive.plan.inventory.stores.find((candidate) => candidate.name === store);
  if (entry === undefined) invalid(`archive ${name}: its plan records no manifest for ${store}`);
  return entry.manifestSha256;
}

/** The binding a report cursor of `runId` in archive `archive` carries. */
function cursorBinding(root: string, name: string, archive: BoundArchive, runId: string): string {
  return createHash("sha256").update(`${root}\0${name}\0${archive.plan.digest}\0${runId}`).digest("hex").slice(0, CURSOR_BINDING_CHARS);
}

/** The incumbent report cursor inside an archive cursor issued for exactly this root, archive, plan and run. */
function innerCursor(cursor: string | undefined, binding: string): string | undefined {
  if (cursor === undefined) return undefined;
  const match = /^a1\.([0-9a-f]+)\.(r1\.[0-9a-f]{12}\.\d{1,12})$/.exec(cursor);
  if (match === null || match[1] !== binding) invalid("the report cursor was not issued for this archived run; restart without it");
  return match[2];
}

/** Every retained scale-down archive of the project at `root`, by name. */
export async function listScaleArchives(project: string): Promise<ScaleArchiveV1[]> {
  const root = await canonicalRoot(project);
  const listing = await listConfinedDirBounded(root, DOWNGRADE_DIR, MAX_ARCHIVES);
  if (listing.kind === "absent") return [];
  if (listing.kind !== "ok") throw new ScaleDowngradeError("scale_downgrade_partial", `${DOWNGRADE_DIR} cannot be listed in full`);
  const archives: ScaleArchiveV1[] = [];
  for (const entry of [...listing.entries].sort((a, b) => a.name.localeCompare(b.name))) {
    const archive = entry.kind === "directory" ? await archiveOf(root, entry.name) : null;
    if (archive !== null) archives.push({ name: entry.name, target: archive.receipt.target, fenceRevision: archive.receipt.fenceRevision, runs: archive.receipt.runs, lastRun: archive.receipt.lastRun });
  }
  return archives;
}

/**
 * One page of archived run `runId`'s report in archive `name`, read through
 * the immutable view. Its cursor is bound to this root, archive, plan and run:
 * a cursor of another archive or of `compile --report` is refused.
 */
export async function readArchivedReport(project: string, name: string, runId: string, cursor?: string): Promise<ReportPageV1> {
  const root = await canonicalRoot(project);
  const archive = await archiveOf(root, name);
  if (archive === null) invalid(`${name} is not a retained scale-down archive`);
  if (!archive.receipt.runs.some((run) => run.runId === runId)) invalid(`archive ${name} holds no batch run ${runId}`);
  const archived = archivedIndexed(archive.dir);
  const current = await identityAt(root, archived);
  if (current === null || !sameObject(current, archive.receipt.archive.indexed as Parameters<typeof sameObject>[0])) invalid(`the archived stores of ${name} are not the object its receipt names`);
  const store = `${RUN_STORE_PREFIX}${runId}`;
  const manifestSha256 = plannedManifest(name, archive, store);
  const binding = cursorBinding(root, name, archive, runId);
  const page = await readReport(root, runId, innerCursor(cursor, binding), archivedStoreIo(root, archived, store, manifestSha256));
  return page.cursor === undefined ? page : { ...page, cursor: `a1.${binding}.${page.cursor}` };
}
