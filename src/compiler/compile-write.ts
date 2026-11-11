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
 *
 * ONE BODY, TWO DOMAIN COLLABORATORS. {@link applyCompilePageWritesWith} is the
 * one body. It is handed {@link CompilePageWriteSteps}: the planner and the
 * executor entry, each a DOMAIN step with its own semantics, NOT a storage port.
 * The root {@link applyCompilePageWritesLocked} keeps its signature and passes
 * {@link localCompilePageWriteSteps}, which call `planPageMutation` and
 * `applyApprovedMutationsLocked` at call time, so their module spies still see
 * every call. A non-disk caller passes the planner's and the executor's own
 * bound bodies over its raw ports. The caller's `opts` OBJECT is handed through
 * untouched: the hook is read and called on it exactly as before, and the SAME
 * object reaches the executor.
 */

import {
  planPageMutation,
  type PlannedMutation,
  type PlanPageInput,
  type PlanResult,
} from "../trust/planner.js";
import {
  applyApprovedMutationsLocked,
  type ApplyOptions,
} from "../trust/executor.js";
import { COMPILE_ORIGIN } from "../trust/checks.js";

/**
 * The wiki page namespaces `compile` writes into: the default pages
 * (`concepts`/`queries`) and the generated `timeline`. These are the BARE
 * namespace stems the raw planner expects — it builds the
 * full `wiki/<namespace>/<slug>.md` path itself, so the `wiki/` prefix is NOT
 * included here (passing the `CONCEPTS_DIR` constant would double the prefix).
 */
export type CompilePageNamespace = "concepts" | "queries" | "timeline";

/** What every compiled page write carries: its slug stem and its bytes. */
interface CompileWriteBase {
  /** The page's raw slug stem (no extension, no directory). */
  slug: string;
  /** The full markdown body (frontmatter + prose) to write, or, when deleting, the bytes being removed. */
  body: string;
  /** Remove the page instead of writing it; the floor still checks `body`. */
  deleting?: boolean;
}

/**
 * One compiled page to write: a default page under its bare wiki `namespace`
 * (`concepts`, `queries` or `timeline`), or a profile-typed record under its
 * `entityType`, which the planner places at `wiki/<entityType>/` with a typed id.
 */
export type CompilePageWrite = CompileWriteBase & (
  | { namespace: CompilePageNamespace; entityType?: never }
  | { entityType: string; namespace?: never }
);

/** The wiki directory a write lands in: its namespace, or for a typed record its entity type. */
export function compileWriteDirectory(item: CompilePageWrite): string {
  return item.entityType ?? item.namespace;
}

/** A page the planner BLOCKED at the floor, returned (not thrown) so compile continues. */
export interface SkippedWrite {
  /** The compile write that was skipped. */
  item: CompilePageWrite;
  /** Why it was skipped — `floor:<decision>` (e.g. `floor:deny`). */
  reason: string;
}

/** Persist derived-work intent for floor-approved pages before any bytes change. */
export type BeforeCompilePageWrites = (items: CompilePageWrite[]) => Promise<void>;

/** What a compile page write is given: the executor's options plus the derived-work hook. */
export type CompilePageWriteOptions = ApplyOptions & { beforeApply?: BeforeCompilePageWrites };

/**
 * The two DOMAIN steps a compile page write composes. Each carries the full
 * semantics of its own owner (the planner's floor and create/update choice; the
 * executor's replay, guard, journal and writes) and is NOT storage.
 */
export interface CompilePageWriteSteps {
  /** Plan one page. Local: `planPageMutation(input)`. */
  plan(input: PlanPageInput): Promise<PlanResult>;
  /** Apply the allowed plan under the caller's held lock, with the caller's SAME options object. Local: `applyApprovedMutationsLocked(root, planned, opts)`. */
  apply(root: string, planned: PlannedMutation[], opts: CompilePageWriteOptions): Promise<unknown>;
}

/** LOCAL. The incumbent planner and lock-free executor core, called at call time; frozen. In no package index. */
const localCompilePageWriteSteps: CompilePageWriteSteps = Object.freeze({
  plan: (input: PlanPageInput) => planPageMutation(input),
  apply: (root: string, planned: PlannedMutation[], opts: CompilePageWriteOptions) => applyApprovedMutationsLocked(root, planned, opts),
});

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
  steps: CompilePageWriteSteps,
  root: string,
  items: CompilePageWrite[],
): Promise<{ planned: PlannedMutation[]; skipped: SkippedWrite[] }> {
  const planned: PlannedMutation[] = [];
  const skipped: SkippedWrite[] = [];
  for (const it of items) {
    const r = await steps.plan({
      root,
      target: it.entityType !== undefined
        ? { kind: "entity", entityType: it.entityType, slug: it.slug }
        : { kind: "raw", directory: it.namespace, slug: it.slug },
      body: it.body,
      origin: COMPILE_ORIGIN,
      reviewRouted: false,
      allowOverwrite: true,
      deleting: it.deleting,
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
 * @param opts - Optional write primitive and a beforeApply hook for persisting
 *   derived-work intent after floor filtering but before the executor writes.
 * @returns The floor-skipped pages (allowed pages are written as a side effect).
 */
export async function applyCompilePageWritesLocked(
  root: string,
  items: CompilePageWrite[],
  opts: ApplyOptions & { beforeApply?: BeforeCompilePageWrites } = {},
): Promise<{ skipped: SkippedWrite[] }> {
  return applyCompilePageWritesWith(localCompilePageWriteSteps, root, items, opts);
}

/**
 * THE ONE BODY of {@link applyCompilePageWritesLocked}, over the two domain
 * steps it is handed. Every item is planned first; when nothing is allowed the
 * hook is not read and `apply` is not called, so no replay, no journal and no
 * `opts.writeOne` read happen. Otherwise `opts.beforeApply` is read, called AS A
 * METHOD of `opts` with the allowed items, and `apply` gets the SAME `opts`.
 *
 * @param steps - The planner and executor entry (domain collaborators).
 * @param root - Project root, handed to both steps as data.
 * @param items - The compiled pages to write.
 * @param opts - The caller's options object, forwarded as is.
 * @returns The floor-skipped pages.
 */
export async function applyCompilePageWritesWith(
  steps: CompilePageWriteSteps,
  root: string,
  items: CompilePageWrite[],
  opts: CompilePageWriteOptions = {},
): Promise<{ skipped: SkippedWrite[] }> {
  const { planned, skipped } = await planCompilePageWrites(steps, root, items);
  if (planned.length > 0) {
    if (opts.beforeApply) {
      const blocked = new Set(skipped.map(({ item }) => item));
      await opts.beforeApply(items.filter(item => !blocked.has(item)));
    }
    await steps.apply(root, planned, opts);
  }
  return { skipped };
}
