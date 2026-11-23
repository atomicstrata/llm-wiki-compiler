/**
 * @file src/compiler/batch/detect.ts
 * @description The first PLAN phases of a batch compile: the LISTING and
 * change DETECTION, reproducing the incumbent `detectChanges` with bounded
 * memory.
 *
 * LISTING. The selected Markdown sources are walked into `f:<file>` rows,
 * STREAMING each directory's entries (one open directory per level, bounded
 * depth); their key order is the incumbent's sorted listing order. Each is then hashed (one file resident at a time) and the
 * through the bounded source reader (`./sources.ts`) and the
 * SOURCE-SET DIGEST is a rolling SHA-256 of `(file, hash)` in that order: a
 * resume recomputes it before any effect and refuses on any difference.
 *
 * DETECTION. `d:<seq>` rows in incumbent order: the listing, each `new`,
 * `changed` or `unchanged` against its compile-state entry (a point lookup),
 * then every compile-state source missing from the listing as `deleted` (in
 * insertion order), `deselected` when the selection no longer takes it. Each
 * row also carries the status this run acts on: the incumbent prompt-modifier
 * promotion. (The incumbent pending-candidate rule never applies: a batch
 * compile refuses before any effect while a review candidate is pending.)
 */

import { createHash } from "node:crypto";
import { promptModifiersChanged } from "../prompt-modifiers.js";
import { diskStreamingDirectory, type StreamingLocalDirectory } from "../../storage/disk-local-reads.js";
import type { LegacyLocalReads } from "../../storage/legacy-local-reads.js";
import { isSourceExcluded, isSourceSelected, loadSourceSelectionFrom, type SourceSelection } from "../../sources/selection.js";
import { SOURCES_DIR } from "../../utils/constants.js";
import type { SourceChange } from "../../utils/types.js";
import { CompileStateError, ORDINAL_LIMIT } from "../../cstate/contracts.js";
import { BatchCompileError, seqKey } from "./contracts.js";
import { inheritPublished } from "./inherit.js";
import { readSourceBounded } from "./sources.js";
import type { BatchRun } from "./run-store.js";
import type { StateSnapshot } from "./state-reads.js";
import { report } from "./report.js";

/** A listing row. */
export interface ListedSourceV1 { readonly hash: string | null; readonly bytes: number }
/** A detected-change row. */
export interface DetectedRowV1 { readonly file: string; readonly detected: SourceChange["status"]; readonly scoped: SourceChange["status"]; readonly reason?: "deselected" }

/** The deepest source directory a walk descends into; deeper nesting refuses rather than growing the walk's frontier. */
export const MAX_SOURCE_DEPTH = 64;

/**
 * Walk one directory of the selection, handing each selected source to
 * `record`, streaming its entries and recursing as the selection allows: the
 * frontier is one open directory per level, at most {@link MAX_SOURCE_DEPTH} levels.
 */
async function walkSelected(directory: StreamingLocalDirectory, prefix: string, selection: SourceSelection, depth: number, record: (id: string) => Promise<void>): Promise<void> {
  if (depth > MAX_SOURCE_DEPTH) throw new Error(`sources/${prefix} is nested deeper than ${MAX_SOURCE_DEPTH} directories; a batch compile refuses rather than walk it`);
  for await (const entry of directory.entries(prefix)) {
    const id = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (isSourceExcluded(id, selection)) continue;
    if (entry.kind === "file" && id.endsWith(".md")) await record(id);
    else if (entry.kind === "directory" && selection.recursive) await walkSelected(directory, id, selection, depth + 1, record);
  }
}

/** Walk every selected source of the project at `root` (nothing when the sources directory is absent). */
async function walkSources(root: string, reads: LegacyLocalReads, record: (id: string) => Promise<void>): Promise<void> {
  const directory = await diskStreamingDirectory(root, SOURCES_DIR);
  if (directory !== null) await walkSelected(directory, "", await loadSourceSelectionFrom(reads), 0, record);
}

/** The listing phase: the streamed walk, then one hash per source (resumable after the last hashed file). */
export async function runListing(run: BatchRun, root: string, reads: LegacyLocalReads): Promise<void> {
  if (run.meta.cursor.walked !== true) {
    // One unit with the walk: what superseded runs may have published (`./inherit.ts`).
    await inheritPublished(run);
    await walkSources(root, reads, async (id) => { await run.put(`f:${id}`, { hash: null, bytes: 0 }); run.counters.listed += 1; });
    await run.checkpoint({ cursor: { walked: true } });
  }
  await hashListing(run);
  // Derived from the listing, so a redo after an early publication cannot count a source twice.
  run.counters.hashed = run.counters.listed;
  await run.advance("detect");
}

/** Hash every listed source after the cursor, checkpointing every batch. */
async function hashListing(run: BatchRun): Promise<void> {
  let pending = 0;
  const from = run.meta.cursor.hashedAfter as string | undefined;
  for await (const row of run.scan("f:", from === undefined ? undefined : `${from}\0`)) {
    if ((row.v as ListedSourceV1).hash !== null) continue;
    const read = await readSourceBounded(run.root, row.k.slice(2));
    await run.put(row.k, { hash: read.hash, bytes: read.bytes });
    if ((pending += 1) >= run.meta.batchSize) { await run.checkpoint({ cursor: { walked: true, hashedAfter: row.k } }); pending = 0; }
  }
}

/** Refuse a run whose inputs changed since its listing. */
const listingChanged = (what: string): never => {
  throw new BatchCompileError("compile_batch_inputs_changed", `${what} changed since the batch compile run listed its sources; run the compile with --restart to start over from the current inputs`);
};

/**
 * Re-walk and re-hash every selected source against the run's COMPLETE
 * listing: the walk must find exactly the listed sources (same membership and
 * count) with their listed hashes. A resumed attempt runs this before any
 * phase after the listing, so a source added, deleted or edited while the
 * run was interrupted (even during its listing) refuses before any effect.
 */
export async function assertListingCurrent(run: BatchRun, reads: LegacyLocalReads): Promise<void> {
  let walked = 0;
  await walkSources(run.root, reads, async (id) => {
    walked += 1;
    const listed = (await run.get(`f:${id}`)) as ListedSourceV1 | undefined;
    if (listed === undefined) listingChanged(`the source set (sources/${id.slice(0, 80)} is new)`);
    if ((await readSourceBounded(run.root, id)).hash !== listed!.hash) listingChanged(`sources/${id.slice(0, 80)}`);
  });
  if (walked !== run.counters.listed) listingChanged("the source set (a listed source is gone)");
}

/** The source-set digest of the listing: `(file, hash)` in listing order. */
export async function sourceSetDigest(run: BatchRun): Promise<string> {
  const digest = createHash("sha256");
  for await (const row of run.scan("f:")) digest.update(`${row.k.slice(2)}\0${(row.v as ListedSourceV1).hash}\n`);
  return digest.digest("hex");
}

/** Classify one listed source against its previous hash. */
function classify(previous: string | undefined, hash: string): SourceChange["status"] {
  if (previous === undefined) return "new";
  return previous === hash ? "unchanged" : "changed";
}

/** Append one detected row. */
async function detectedRow(run: BatchRun, seq: number, row: DetectedRowV1): Promise<void> {
  await run.put(seqKey("d:", seq), row);
  await run.put(`k:${row.file}`, seq);
}

/**
 * The detection phase: listed sources against the state, then the state's
 * missing sources. A source detected `unchanged` is acted on as `changed`
 * when the prompt-modifier selection changed, as the classic compile promotes it.
 */
export async function runDetection(run: BatchRun, state: StateSnapshot, reads: LegacyLocalReads): Promise<void> {
  const promote = promptModifiersChanged(state.meta.promptModifiers ?? undefined);
  let seq = 0;
  for await (const row of run.scan("f:")) {
    const file = row.k.slice(2);
    const detected = classify((await state.source(file))?.hash, (row.v as ListedSourceV1).hash as string);
    const promoted = detected === "unchanged" && promote;
    await detectedRow(run, seq++, { file, detected, scoped: promoted ? "changed" : detected });
  }
  const selection = await loadSourceSelectionFrom(reads);
  for await (const file of state.sourcesInOrder()) {
    if ((await run.get(`f:${file}`)) !== undefined) continue;
    await detectedRow(run, seq++, { file, detected: "deleted", scoped: "deleted", ...(isSourceSelected(file, selection) ? {} : { reason: "deselected" as const }) });
    await report(run, { kind: "deleted", file });
  }
  run.counters.detected = seq;
  run.counters.deleted = await countScoped(run, "deleted");
  run.counters.unchanged = await countScoped(run, "unchanged");
  await assertOrdinalsAvailable(state, await countDetected(run, "new"));
  await run.advance("closure");
}

/** How many listed sources the state does not hold (each may need a new ordinal). */
async function countDetected(run: BatchRun, status: SourceChange["status"]): Promise<number> {
  let count = 0;
  for await (const row of run.scan("d:")) if ((row.v as DetectedRowV1).detected === status) count += 1;
  return count;
}

/** Refuse, before any page or state effect, a run whose new sources would pass the compile state's ordinal limit. */
async function assertOrdinalsAvailable(state: StateSnapshot, fresh: number): Promise<void> {
  if (state.meta.nextOrdinal + fresh <= ORDINAL_LIMIT) return;
  throw new CompileStateError("compile_state_unavailable", `${fresh} new sources would pass the compile state's ${ORDINAL_LIMIT} source ordinals; nothing was written`);
}

/** How many detected rows this run acts on with `status`. */
async function countScoped(run: BatchRun, status: SourceChange["status"]): Promise<number> {
  let count = 0;
  for await (const row of run.scan("d:")) if ((row.v as DetectedRowV1).scoped === status) count += 1;
  return count;
}
