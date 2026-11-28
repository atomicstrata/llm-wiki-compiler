/**
 * @file src/cstate/verify.ts
 * @description Explicit read-only FULL VERIFICATION of the segmented compile
 * state (`./contracts.ts`), streaming every row once with bounded memory:
 * - EVERY live row is a source, order, owner or frozen row (any other is a
 *   problem);
 * - every source row is keyed by a representable source path, carries an
 *   ordinal below the next free one, and holds a source entry the incumbent
 *   state reader accepts;
 * - the order index is EXACTLY the sources: each source's ordinal has its
 *   order row naming it, and there are as many order rows as sources (so no
 *   two sources share an ordinal);
 * - the owner index is EXACTLY the sources' concepts: each concept of each
 *   source has its owner row naming it, and the stored owner rows are
 *   exactly that many, so none is missing or extra;
 * - every order, owner and frozen row is well formed; each frozen row's
 *   position has its frozen-order row naming it, and there are as many
 *   frozen-order rows as frozen slugs (so no position is claimed twice); no
 *   frozen row exists without the meta's frozen list;
 * - the meta's counts match the rows, the segments match their digests, and
 *   `state.json` (the legacy backup) still has the imported bytes.
 * It reports health for THIS RESPONSE only and writes nothing.
 */

import { legacyBytesUnchanged, legacyDriftMessage, ProblemSample } from "../history/contracts.js";
import type { HistoryVerification } from "../history/events-read.js";
import { isSafeFilenameComponent } from "../profile/identity.js";
import type { SegmentStore } from "../segments/store.js";
import { withVerificationReads } from "../segments/verification-cache.js";
import { storageOf, verifyStore } from "../segments/verify.js";
import { isValidSourceEntry } from "../utils/state-shape.js";
import type { SourceState } from "../utils/types.js";
import {
  compileStateMetaOf, FROZEN_ORDER_PREFIX, frozenOrderKey, FROZEN_PREFIX, isRepresentableSourceKey, isSourceRow, MAX_STATE_FILE_BYTES, ORDER_PREFIX, orderKey, OWNER_PREFIX, ownerKey, parseOrderKey,
  parseOwnerKey, SOURCE_PREFIX, type CompileStateMeta,
} from "./contracts.js";
import { openCompileState } from "./store.js";

/** What one streamed pass over every live row counted. */
interface RowTally { sources: number; orders: number; owners: number; storedOwners: number; frozen: number; frozenOrders: number }

/**
 * Check one source row: its key and shape, its ordinal (below the next free
 * one, and its order row names this source), its entry, and that each of its
 * concepts has its owner row; returns the owner rows it needs.
 */
async function checkSource(store: SegmentStore, meta: CompileStateMeta, file: string, value: unknown, problems: ProblemSample): Promise<number> {
  const label = file.slice(0, 80);
  if (!isRepresentableSourceKey(file)) problems.note(`source row key ${JSON.stringify(label)} cannot key a compile-state row`);
  if (!isSourceRow(value) || !isValidSourceEntry(value.v)) { problems.note(`source row ${label} is not a valid source entry`); return 0; }
  if (value.o >= meta.nextOrdinal || (await store.get(orderKey(value.o))) !== file) problems.note(`source ${label} has no order row for its ordinal ${value.o}`);
  const slugs = new Set((value.v as SourceState).concepts);
  for (const slug of slugs) {
    if ((await store.get(ownerKey(slug, value.o))) !== file) problems.note(`source ${label} is missing its owner row for ${slug.slice(0, 80)}`);
  }
  return slugs.size;
}

/** Whether a named source is representable. */
const namesSource = (value: unknown): boolean => typeof value === "string" && isRepresentableSourceKey(value);

/** Whether a frozen row is well formed under `meta`, and the frozen-order row of its position names it back. */
async function frozenRowValid(store: SegmentStore, meta: CompileStateMeta, key: string, value: unknown): Promise<boolean> {
  const slug = key.slice(FROZEN_PREFIX.length);
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) >= meta.frozen || !isSafeFilenameComponent(slug)) return false;
  return (await store.get(frozenOrderKey(value as number))) === slug;
}

/** Whether an order row is well formed under `meta`. */
function orderRowValid(meta: CompileStateMeta, key: string, value: unknown): boolean {
  const ordinal = parseOrderKey(key);
  return ordinal !== null && ordinal < meta.nextOrdinal && namesSource(value);
}

/** Whether an owner row is well formed under `meta`. */
function ownerRowValid(meta: CompileStateMeta, key: string, value: unknown): boolean {
  const owner = parseOwnerKey(key);
  return owner !== null && owner.ordinal < meta.nextOrdinal && isSafeFilenameComponent(owner.slug) && namesSource(value);
}

/** Whether a frozen-order row is well formed under `meta`. */
function frozenOrderRowValid(meta: CompileStateMeta, key: string, value: unknown): boolean {
  const at = parseOrderKey(key, FROZEN_ORDER_PREFIX);
  return at !== null && at < meta.frozen && typeof value === "string" && isSafeFilenameComponent(value);
}

/** Whether an order, owner, frozen-order or frozen row is well formed under `meta`. */
async function indexRowValid(store: SegmentStore, meta: CompileStateMeta, key: string, value: unknown): Promise<boolean> {
  if (key.startsWith(ORDER_PREFIX)) return orderRowValid(meta, key, value);
  if (key.startsWith(OWNER_PREFIX)) return ownerRowValid(meta, key, value);
  if (key.startsWith(FROZEN_ORDER_PREFIX)) return frozenOrderRowValid(meta, key, value);
  return frozenRowValid(store, meta, key, value);
}

/** Stream EVERY live row once: each namespace is checked and counted; any other row is a problem. */
async function tallyRows(store: SegmentStore, meta: CompileStateMeta, problems: ProblemSample): Promise<RowTally> {
  const tally: RowTally = { sources: 0, orders: 0, owners: 0, storedOwners: 0, frozen: 0, frozenOrders: 0 };
  const counted = { [ORDER_PREFIX]: "orders", [OWNER_PREFIX]: "storedOwners", [FROZEN_PREFIX]: "frozen", [FROZEN_ORDER_PREFIX]: "frozenOrders" } as const;
  for await (const row of store.scan()) {
    const prefix = row.k.slice(0, 2);
    if (prefix === SOURCE_PREFIX) {
      tally.sources += 1;
      tally.owners += await checkSource(store, meta, row.k.slice(SOURCE_PREFIX.length), row.v, problems);
    } else if (prefix === ORDER_PREFIX || prefix === OWNER_PREFIX || prefix === FROZEN_PREFIX || prefix === FROZEN_ORDER_PREFIX) {
      tally[counted[prefix]] += 1;
      if (!(await indexRowValid(store, meta, row.k, row.v))) problems.note(`row ${row.k.slice(0, 80)} is malformed`);
    } else {
      problems.note(`row ${row.k.slice(0, 80)} is outside the compile state's source, order, owner and frozen rows`);
    }
  }
  return tally;
}

/** Note every count the meta states that the rows contradict. */
function checkCounts(meta: CompileStateMeta, counted: RowTally, problems: ProblemSample): void {
  if (!meta.frozenPresent && counted.frozen > 0) problems.note(`the manifest records no frozen list, but ${counted.frozen} frozen rows are stored`);
  if (counted.storedOwners !== counted.owners) problems.note(`the owner index holds ${counted.storedOwners} rows, the sources' concepts need ${counted.owners}`);
  if (counted.orders !== counted.sources) problems.note(`the order index holds ${counted.orders} rows for ${counted.sources} sources`);
  if (counted.frozenOrders !== counted.frozen) problems.note(`the frozen-order index holds ${counted.frozenOrders} rows for ${counted.frozen} frozen slugs`);
  if (meta.sources !== counted.sources || meta.owners !== counted.storedOwners || meta.frozen !== counted.frozen) {
    problems.note(`the manifest counts ${meta.sources}/${meta.owners}/${meta.frozen} sources/owners/frozen, ${counted.sources}/${counted.storedOwners}/${counted.frozen} are stored`);
  }
}

/** Full verification of the segmented compile state of `root`. */
export async function verifyCompileState(root: string): Promise<HistoryVerification> {
  return withVerificationReads(await openCompileState(root), async (store) => {
    const meta = compileStateMetaOf(store);
    const problems = new ProblemSample();
    const tally = await tallyRows(store, meta, problems);
    checkCounts(meta, tally, problems);
    const storage = storageOf(await verifyStore(store));
    if (!(await legacyBytesUnchanged(root, meta.legacy, MAX_STATE_FILE_BYTES))) problems.note(legacyDriftMessage(meta.legacy));
    return { ok: problems.count === 0, records: tally.sources, problemCount: problems.count, problems: problems.sample, storage };
  });
}
