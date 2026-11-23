/**
 * @file src/portable/scale/catalog.ts
 * @description The maintained metadata catalog of the authority-only store:
 * every bound path with its digest, size, revision, labels and title, kept
 * SORTED and PARTITIONED BY LABEL SET at every bind.
 *
 * This is what makes a keyset cursor real. A listing page is a binary-search
 * seek in each partition the caller is cleared for, then the page: the seek is
 * logarithmic in the catalog, not constant, and nothing outside the page is
 * read. A partition the caller is not cleared for is never opened. No listing
 * ever collects every name and slices.
 *
 * The catalog is maintained by the authority in the same step as the bind it
 * describes. It carries two counters. The ROOT moves on every committed bind
 * and is what a cursor is fenced to. The LABEL EPOCH is project-wide and moves
 * only when the labels bound to an EXISTING path change, whichever operation
 * changed them; a derived index is fenced to it.
 */

import type { LabelSet } from "../contracts.js";
import { normalizeLabels } from "../digest.js";
import type { CatalogPage, ListPageQuery, ObjectStat, ScaleCounters } from "./paged-store.js";

/** Above this many new paths in one partition, a bind sorts once instead of inserting one by one. */
const BULK_SORT_THRESHOLD = 32;

/** One label set's sorted paths. */
interface Partition { labels: LabelSet; paths: string[] }

/** The canonical key of a label set. */
export function labelSetKey(labels: LabelSet): string {
  return JSON.stringify(normalizeLabels(labels));
}
