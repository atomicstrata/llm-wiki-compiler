/**
 * @file src/compiler/compile-write.ts
 * @description The compile→trust PAGE-WRITE ADAPTER — the thin seam through which
 * `compile`'s concept/query page writes are routed through the unified write
 * planner ({@link planPageMutation}) and the guarded executor
 * ({@link applyApprovedMutationsLocked}), instead of writing bytes directly.
 *
 * Routing compile's writes through the planner subjects every compiled page to
 * the SAME mandatory trust floor (path-confinement, resource-limit, frontmatter)
 * and the SAME journalled atomicity contract ("partial application of an approved
 * batch is a bug") that the `review approve` path already gets — a single seam,
 * per CLP Invariant 4.
 *
 * THREE CONTRACTS this adapter preserves, distinct from a raw executor call:
 *
 *  - SKIP, NOT ABORT. `compile` is per-page resilient: one malformed/oversized
 *    page must never sink the whole compile. So a floor-BLOCKED page (the planner
 *    returns `planned: []`, e.g. a resource-limit violation) is collected into
 *    {@link SkippedWrite} and RETURNED — the call does NOT throw — while every
 *    OTHER (allowed) page in the set still writes. This mirrors the page-skipping
 *    posture of `validateWikiPage`.
 *
 *  - ONE JOURNALLED BATCH. All ALLOWED pages in the set are planned, then applied
 *    as a SINGLE journalled batch, so a mid-batch crash reverts to the full
 *    pre-state rather than leaving compile's output half-written.
 *
 *  - EMPTY ⇒ NO-OP. An empty allowed set opens NO journal batch. Opening a batch
 *    for zero writes would create a spurious "incomplete-compile" recovery window
 *    (a pending journal with nothing to revert), so when nothing is allowed the
 *    adapter touches no journal at all.
 *
 * LOCK PRECONDITION. This adapter uses the LOCK-FREE executor core
 * {@link applyApprovedMutationsLocked}: `compile` already holds the project lock
 * for its whole pipeline, so the self-locking {@link applyApprovedMutations} would
 * re-acquire the same lock and self-deadlock. The CALLER MUST already hold the
 * project lock before invoking {@link applyCompilePageWritesLocked}.
 */

import {
  planPageMutation,
  type PlannedMutation,
} from "../trust/planner.js";
import {
  applyApprovedMutationsLocked,
  type ApplyOptions,
} from "../trust/executor.js";
import { COMPILE_ORIGIN } from "../trust/checks.js";

/**
 * The two DEFAULT wiki page namespaces `compile` writes into. These are the BARE
 * namespace stems (`concepts`/`queries`) the raw planner expects — it builds the
 * full `wiki/<namespace>/<slug>.md` path itself, so the `wiki/` prefix is NOT
 * included here (passing the `CONCEPTS_DIR` constant would double the prefix).
 */
export type CompilePageNamespace = "concepts" | "queries";

/** One compiled page to write: its namespace, slug stem, and full markdown body. */
export interface CompilePageWrite {
  /** The bare wiki namespace (`concepts` or `queries`). */
  namespace: CompilePageNamespace;
  /** The page's raw slug stem (no extension, no directory). */
  slug: string;
  /** The full markdown body (frontmatter + prose) to write. */
  body: string;
}

/** A page the planner BLOCKED at the floor, returned (not thrown) so compile continues. */
export interface SkippedWrite {
  /** The compile write that was skipped. */
  item: CompilePageWrite;
  /** Why it was skipped — `floor:<decision>` (e.g. `floor:deny`). */
  reason: string;
}

/**
 * Plan a set of compile page writes, PARTITIONING them into the allowed plan and
 * the floor-skipped set. Each item goes through {@link planPageMutation} as a
 * `raw` (default-page) target with `origin:"compile"`, `reviewRouted:false`, and
 * `allowOverwrite:true` (compile recompiles existing pages). A page the planner
 * blocks (returns `planned: []`) is collected into `skipped` rather than aborting
 * — preserving compile's per-page resilience — while allowed pages accumulate
 * their planned mutations for a single executor batch.
 *
 * @param root - Absolute project root the writes must stay confined to.
 * @param items - The compiled pages to plan.
 * @returns The accumulated allowed plan and the floor-skipped pages.
 */
async function planCompilePageWrites(
  root: string,
  items: CompilePageWrite[],
): Promise<{ planned: PlannedMutation[]; skipped: SkippedWrite[] }> {
  const planned: PlannedMutation[] = [];
  const skipped: SkippedWrite[] = [];
  for (const it of items) {
    const r = await planPageMutation({
      root,
      target: { kind: "raw", directory: it.namespace, slug: it.slug },
      body: it.body,
      origin: COMPILE_ORIGIN,
      reviewRouted: false,
      allowOverwrite: true,
    });
    if (r.planned.length === 0) {
      skipped.push({ item: it, reason: `floor:${r.decision}` });
    } else {
      planned.push(...r.planned);
    }
  }
  return { planned, skipped };
}

/**
 * Plan + apply a set of compile page writes as ONE journalled batch (only the
 * allowed pages), under the caller's already-held project lock.
 *
 * PRECONDITION: the caller MUST already hold the project lock — this routes
 * through the LOCK-FREE executor core {@link applyApprovedMutationsLocked}, which
 * acquires nothing. (`compile` holds the lock for its whole pipeline; the
 * self-locking entry point would re-acquire and self-deadlock.)
 *
 * SKIP, NOT ABORT: a floor-blocked page is returned in `skipped` (reason starts
 * `floor:`), NOT thrown — every other allowed page in the set still writes.
 *
 * EMPTY ⇒ NO-OP: when no page is allowed (every item skipped, or `items` empty),
 * NO journal batch is opened — avoiding a false incomplete-compile recovery
 * window for a batch with nothing to apply.
 *
 * @param root - Absolute project root.
 * @param items - The compiled pages to write.
 * @param opts - Optional injectable write primitive (for fault injection).
 * @returns The floor-skipped pages (allowed pages are written as a side effect).
 */
export async function applyCompilePageWritesLocked(
  root: string,
  items: CompilePageWrite[],
  opts: ApplyOptions = {},
): Promise<{ skipped: SkippedWrite[] }> {
  const { planned, skipped } = await planCompilePageWrites(root, items);
  if (planned.length > 0) {
    await applyApprovedMutationsLocked(root, planned, opts);
  }
  return { skipped };
}
