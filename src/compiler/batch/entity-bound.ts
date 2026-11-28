/**
 * @file src/compiler/batch/entity-bound.ts
 * @description The batch compile's bound on CUSTOM-PROFILE ENTITY PAGES, which
 * its residual catalog and index steps read (`./residual-catalog.ts`,
 * `./residual-index.ts`): each page body is read through one capped confined
 * read of at most {@link MAX_PAGE_BYTES} (`../../catalog/entity-rows.ts`), and
 * the catalog reconciliation also commits before its pending rows would pass
 * {@link MAX_SYNC_BATCH_BYTES} (a batch then holds at most that, or one
 * entry's serialized rows when a single entry is larger).
 *
 * REFUSALS. A page over the cap refuses the run as `compile_batch_page_too_large`;
 * a page that grew, was swapped, vanished or could not be read while it was
 * read refuses as `compile_batch_source_unreadable`, never silently leaving
 * the page out of the catalog. Both come after the run's state commit, in its
 * residual phase: the run stays resumable, and once the page is fixed the next
 * `compile` resumes it from that step.
 */

import type { EntityPageBound, EntityReadObservation } from "../../catalog/entity-rows.js";
import type { SyncOptions } from "../../catalog/sync.js";
import { BatchCompileError } from "./contracts.js";
import { MAX_PAGE_BYTES } from "./pages.js";

/** Most serialized bytes of pending catalog rows before a reconciliation commits. */
const MAX_SYNC_BATCH_BYTES = 16 * 1024 * 1024;

/** Refuse what a bounded entity read observed instead of a page. */
function refuseEntityRead(observed: EntityReadObservation): never {
  if (observed.kind === "oversize") {
    throw new BatchCompileError("compile_batch_page_too_large", `entity page ${observed.entry} is ${observed.bytes} bytes, over the ${MAX_PAGE_BYTES}-byte batch read cap; shrink or move it, then run compile again to resume this run`);
  }
  throw new BatchCompileError("compile_batch_source_unreadable", `entity page ${observed.entry} changed or could not be read safely while the batch compile read it; run compile again to resume this run`);
}

/** The bound every entity page body a batch compile reads is held to. */
export const BATCH_ENTITY_PAGE_BOUND: EntityPageBound = { maxBytes: MAX_PAGE_BYTES, refuse: refuseEntityRead };

/** The batch compile's catalog reconciliation options. */
export const BATCH_CATALOG_SYNC: SyncOptions = { entityPageBound: BATCH_ENTITY_PAGE_BOUND, maxBatchBytes: MAX_SYNC_BATCH_BYTES };
