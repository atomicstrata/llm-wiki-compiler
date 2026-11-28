/**
 * @file src/catalog/write-through.ts
 * @description Bring the catalog up to date with files a TOOLED writer just
 * changed, under that writer's project lock: one point lookup, one confined
 * stamp and at most one read per changed file, and one commit.
 *
 * A changed file's directory row is advanced only when the stamp the writer
 * captured BEFORE its write still equals the recorded one: then the only
 * change in that directory since the last reconciliation is the writer's
 * own. Otherwise (or when no pre-write stamp was captured, e.g. a nested
 * source directory) the directory stays stale for an explicit reconciliation,
 * and readers say so. A same-tick external change between the writer's two
 * stats cannot be excluded; the reader's racy-window rule reports such a
 * directory as `unverified`.
 */

import path from "node:path";
import type { PageDirectory } from "../export/types.js";
import { sortedByKey, type SegmentRow } from "../segments/contracts.js";
import type { IoCounters } from "../segments/counters.js";
import type { SegmentStore } from "../segments/store.js";
import { SOURCES_DIR } from "../utils/constants.js";
import { dirKey, PAGE_DIRECTORIES, pageKey, sourceKey, type CatalogMeta, type DirStamp } from "./contracts.js";
import { dirStamp, fileStamp, sameStamp, type WalkedEntry } from "./files.js";
import { catalogMetaOf, openCatalog } from "./meta.js";
import { stampOfRow } from "./rows.js";
import { reconcileRows } from "./sync.js";

/** One file a tooled writer changed (created, updated or removed). */
export type CatalogChange =
  | { readonly kind: "page"; readonly dir: PageDirectory; readonly slug: string }
  | { readonly kind: "source"; readonly id: string };

/** The key and project-relative path of a change. */
function located(change: CatalogChange): { key: string; relPath: string } {
  if (change.kind === "source") return { key: sourceKey(change.id), relPath: `${SOURCES_DIR}/${change.id}` };
  const relDir = PAGE_DIRECTORIES.find(([name]) => name === change.dir)![1];
  return { key: pageKey(change.dir, change.slug), relPath: `${relDir}/${change.slug}.md` };
}

/** The count bucket of a key. */
function bucket(key: string): keyof CatalogMeta["counts"] {
  return key.startsWith("s:") ? "sources" : key.startsWith("p:concepts/") ? "concepts" : "queries";
}

/** Rows and count change for one changed file. */
async function changeRows(root: string, store: SegmentStore, change: CatalogChange): Promise<{ rows: SegmentRow[]; delta: number; key: string; relPath: string }> {
  const { key, relPath } = located(change);
  const old = await store.get(key);
  const stamp = await fileStamp(root, relPath, store.counters);
  const entry: WalkedEntry | undefined = stamp === null ? undefined : { key, relPath, stamp };
  const rows = await reconcileRows(root, store, key, entry, old);
  const exists = rows.some((row) => row.k === key && row.d !== 1);
  return { rows, delta: (exists ? 1 : 0) - (old === undefined ? 0 : 1), key, relPath };
}

/** Directory rows advanced for touched directories whose pre-write stamp still matched the recorded one. */
async function advancedDirRows(root: string, store: SegmentStore, touched: ReadonlySet<string>, before: Readonly<Record<string, DirStamp | null>>): Promise<SegmentRow[]> {
  const rows: SegmentRow[] = [];
  for (const relDir of touched) {
    if (!(relDir in before)) continue;
    const key = dirKey(relDir);
    const recorded = await store.get(key);
    if (recorded !== undefined && sameStamp(before[relDir], stampOfRow(key, recorded))) rows.push({ k: key, v: await dirStamp(root, relDir, store.counters) });
  }
  return rows;
}

/** Apply `changes` to the catalog of `root` in one commit. The caller holds the project lock. */
export async function catalogWriteThrough(
  root: string, changes: readonly CatalogChange[], before: Readonly<Record<string, DirStamp | null>>, counters?: IoCounters,
): Promise<void> {
  const store = await openCatalog(root, counters);
  const meta = catalogMetaOf(store);
  const counts = { ...meta.counts };
  const rows: SegmentRow[] = [];
  const touched = new Set<string>();
  for (const change of changes) {
    const result = await changeRows(root, store, change);
    rows.push(...result.rows);
    counts[bucket(result.key)] += result.delta;
    touched.add(path.posix.dirname(result.relPath));
  }
  if (meta.phase === "ready") rows.push(...(await advancedDirRows(root, store, touched, before)));
  sortedByKey(rows);
  await store.commit({ rows, meta: { ...meta, counts } });
}
