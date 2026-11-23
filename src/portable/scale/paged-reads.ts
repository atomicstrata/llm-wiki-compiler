/**
 * @file src/portable/scale/paged-reads.ts
 * @description The paged reads of slice S1: one listing page, one opened page,
 * and one bounded keyword search, with authorization in a fixed order.
 *
 * THE ORDER, for every method here:
 *
 * 1. COARSE CHECK. Tenant, project and verb are decided from current host
 *    state before any catalog, index or cursor is touched. A caller who fails
 *    it gets the generic `permission_denied` with the constant notice: the
 *    same answer whether the role was never held or was removed a moment ago.
 *    This precedes the cursor, so a lost grant is never reported as
 *    `stale_cursor`.
 * 2. PARTITIONS BY CLEARANCE. Only label sets the caller is cleared for NOW,
 *    taken from the ledger's own partition list, are named to the catalog or
 *    the index. For search the index additionally opens a partition only at
 *    the ledger's current label epoch, before it reads a single posting.
 * 3. RANK INSIDE WHAT IS CLEARED. The scan budget, `truncated` and every score
 *    see cleared, current partitions only.
 * 4. REAUTHORIZE EACH ITEM AT SERVE, against the ledger's label binding for
 *    the exact digest, under current host state.
 * 5. DROP STALE ENTRIES SILENTLY. An index entry whose digest is no longer the
 *    ledger's is not served and not back-filled, and no field says so.
 * 6. DECIDE AGAIN BEFORE ANYTHING LEAVES. Serving takes time. The coarse check
 *    is repeated after the last item was gathered and after a body was read,
 *    so a grant lost meanwhile yields `permission_denied` and none of the
 *    buffered items, cursor, budget or availability.
 *
 * These are new methods with their own closed outcome union. Version 1's
 * reads, its export and its `policy_changed` stop reason are untouched.
 */

import { ACCESS_NOTICE, type LabelSet, type Permission } from "../contracts.js";
import { bytesDigest } from "../digest.js";
import { PortableRefusal } from "../errors.js";
import type { ProjectControlRecord } from "../host/control.js";
import { entitlementOf, isCleared, type Entitlement } from "../host/policy.js";
import { assertLogicalPath, CONCEPTS_PREFIX, conceptPagePath } from "../logical-paths.js";
import { observeVisible, withProjectRead } from "../project/reads.js";
import type { ProjectRuntime } from "../project/runtime.js";
import {
  SCALE_PROTOCOL_V2, type ListPageRequestV2, type PagedListOutcomeV2, type PagedNotVisibleV2,
  type PagedOpenOutcomeV2, type PagedPageEntryV2, type PagedProjectV2, type PagedRefusedV2,
  type PagedRefusalCodeV2, type PagedSearchHitV2, type PagedSearchOutcomeV2, type PagedSearchResultsV2,
  type ScaleCapabilityName,
  type ScaleNegotiationOutcomeV2, type SearchPageRequestV2,
} from "./contracts.js";
import { decodeCursor, encodeCursor, type CursorBinding } from "./cursor.js";
import { queryTerms } from "./keyword-index.js";
import { isPagedStore, type CatalogPage, type ObjectStat, type PagedStore } from "./paged-store.js";
import { pagedViewOf, scaleCapabilitiesOf } from "./v1-adapter.js";

/** The canonical predicate of the one paged listing S1 has: published pages. */
const PAGES_PREDICATE = `pages:${CONCEPTS_PREFIX}`;
/** Longest search text accepted. */
const MAX_QUERY_LENGTH = 200;

/** The verbs a listing needs, at admission and again before it returns. */
const LIST_VERBS: readonly Permission[] = ["page.list"];
/** The verbs a search needs: running a query AND reading pages. Both, both times. */
const SEARCH_VERBS: readonly Permission[] = ["query.run", "page.read"];
/** The verb opening one page needs. */
const OPEN_VERBS: readonly Permission[] = ["page.read"];

const UTF8 = new TextDecoder("utf-8");
const NOT_VISIBLE: PagedNotVisibleV2 = { kind: "not_visible", notice: ACCESS_NOTICE };

/** A refusal from the paged methods' own union. */
function refused(code: PagedRefusalCodeV2, capability?: ScaleCapabilityName): PagedRefusedV2 {
  return capability === undefined
    ? { kind: "refused", code, notice: ACCESS_NOTICE }
    : { kind: "refused", code, capability, notice: ACCESS_NOTICE };
}

/**
 * What a buffered answer was built under: the caller's effective authority
 * (verbs AND clearances) and the ledger's label epoch and catalog root.
 * `clearances` are the ones of the SAME record the admission was decided on.
 */
interface ServeFence { authority: string; ledger: string; clearances: LabelSet; permissions: ReadonlySet<Permission> }

/** The ledger state a store's bindings are in right now. Read synchronously, so it cannot be stale. */
function ledgerToken(runtime: ProjectRuntime): string {
  const { store } = runtime;
  return isPagedStore(store) ? `${store.labelEpoch()}|${store.catalogRoot()}` : "";
}

/**
 * What the acting identity holds in ONE control record, or `null` when that
 * record does not bind this session: the session, the record and the store
 * must name the same tenant and project. Every paged decision, at admission
 * and at each serve check, reads identity, verbs and clearances from the SAME
 * record through here, so none is decided on one load and served on another.
 */
export function boundEntitlement(runtime: ProjectRuntime, record: ProjectControlRecord | null): Entitlement | null {
  const { principal, store } = runtime;
  const isBound = record !== null && record.tenant === principal.tenant
    && record.projectId === principal.project && store.projectId === principal.project;
  return isBound ? entitlementOf(record, principal.actor) : null;
}

/**
 * Step 1: the coarse check, and the fence an answer is built under. ONE load
 * of the current control record decides everything: the session, that record
 * and the store must name the same tenant and project, and the acting
 * identity must hold every verb in THAT record. The entitlement captured is
 * the one of the record that was validated, never of a later or earlier load.
 * Nothing else has been touched when this returns.
 *
 * @returns `null` when the caller is not admitted now.
 */
async function captureFence(runtime: ProjectRuntime, verbs: readonly Permission[]): Promise<ServeFence | null> {
  const { control, principal } = runtime;
  const held = boundEntitlement(runtime, await control.loadProject(principal.project));
  const isAdmitted = held !== null && verbs.every((verb) => held.permissions.has(verb));
  // The true reason goes to the audit sink and nowhere else.
  control.audit({ kind: "decision", project: principal.project, subject: principal.actor, permissions: verbs, allowed: isAdmitted });
  if (held === null || !isAdmitted) return null;
  return {
    authority: JSON.stringify([[...held.permissions].sort(), held.clearances]), ledger: ledgerToken(runtime),
    clearances: held.clearances, permissions: held.permissions,
  };
}

/**
 * Step 6, for everything already buffered. Per-item checks happened at
 * different moments, so an early item can outlive a clearance lost, or a label
 * widened, while a later one was being confirmed. Nothing buffered leaves
 * unless the caller's authority AND the ledger are exactly what the answer was
 * built under.
 *
 * @returns "denied" when the authority changed, "moved" when the ledger did, "holds" otherwise. The
 *   ledger is compared synchronously after this function's last await. A caller resumes from its own
 *   await of this result a moment later, so it compares the ledger once more before anything leaves.
 */
async function fenceState(
  runtime: ProjectRuntime, verbs: readonly Permission[], built: ServeFence,
): Promise<"holds" | "denied" | "moved"> {
  const now = await captureFence(runtime, verbs);
  if (now === null || now.authority !== built.authority) return "denied";
  return ledgerToken(runtime) === built.ledger ? "holds" : "moved";
}

/** Step 2: the ledger's label sets the admitted record's clearances cover. No further load, no await. */
function clearedLabelSets(store: PagedStore, built: ServeFence): LabelSet[] {
  return store.partitionLabelSets().filter((labels) => isCleared(built.clearances, labels));
}

/**
 * Step 4: may exactly these bytes still be served to this principal for
 * `verb`? Decided on one current control record: a record that no longer binds
 * this session's tenant and project serves nothing, whatever it grants.
 */
async function isServable(runtime: ProjectRuntime, verb: Permission, item: { path: string; digest: ObjectStat["digest"] }): Promise<boolean> {
  const labels = await runtime.store.labelsFor(item.path, item.digest);
  if (labels === null) return false;
  const held = boundEntitlement(runtime, await runtime.control.loadProject(runtime.principal.project));
  return held !== null && held.permissions.has(verb) && isCleared(held.clearances, labels);
}

/** The listing entry of one catalog record. */
function entryOf(stat: Pick<ObjectStat, "path" | "title" | "digest" | "byteCount">): PagedPageEntryV2 {
  const id = stat.path.slice(CONCEPTS_PREFIX.length).replace(/\.md$/u, "");
  return { id, path: stat.path, title: stat.title, digest: stat.digest, byteCount: stat.byteCount };
}

/** True when `limit` is a whole number the store's declared limits allow. */
function isWithin(limit: number, max: number): boolean {
  return Number.isInteger(limit) && limit >= 1 && limit <= max;
}

/** What a cursor for this session's page listing must be bound to at `fence`. */
function listingBinding(runtime: ProjectRuntime, fence: string): CursorBinding {
  return { tenant: runtime.principal.tenant, project: runtime.principal.project, predicate: PAGES_PREDICATE, fence };
}

/** Steps 4 and 5 for a listing page, and the cursor for the next one. */
async function serveListing(
  runtime: ProjectRuntime, store: PagedStore, page: CatalogPage, built: ServeFence,
): Promise<PagedListOutcomeV2> {
  const items: PagedPageEntryV2[] = [];
  for (const entry of page.entries) {
    if (entry.path.endsWith(".md") && await isServable(runtime, "page.list", entry)) items.push(entryOf(entry));
  }
  // Step 6: a grant or clearance lost while items were confirmed serves none of them and no cursor.
  const state = await fenceState(runtime, LIST_VERBS, built);
  if (state === "denied") return refused("permission_denied");
  // The ledger moved under the page: an already-confirmed item may no longer be what it was. Start again.
  // Compared once more here, with no await after it: a bind can land between the fence deciding and this line.
  if (state === "moved" || ledgerToken(runtime) !== built.ledger) return refused("stale_cursor");
  const last = page.entries.at(-1);
  const cursor = page.more && last !== undefined
    ? encodeCursor(runtime.control.secret, listingBinding(runtime, page.fence), last.path)
    : null;
  return { kind: "page", items, cursor, fence: page.fence, custody: store.scaleCapabilities.custody, notice: ACCESS_NOTICE };
}

/**
 * Ask a version 1 store's adapter for a listing page. It has array listing
 * only, so it refuses; the refusal is passed on from the paged union with the
 * capability it named. Nothing is collected and nothing is sliced.
 */
async function adapterListing(runtime: ProjectRuntime): Promise<PagedListOutcomeV2> {
  try {
    await pagedViewOf(runtime.store).listPage({ prefix: CONCEPTS_PREFIX, labelSets: [], after: null, limit: 1 });
  } catch (error) {
    if (error instanceof PortableRefusal && error.code === "capability_unsupported") {
      return refused("capability_unsupported", "listing:cursor");
    }
    throw error;
  }
  throw new Error("a store without a catalog answered a paged listing");
}

/** One page of published pages: a catalog seek plus the page, with no body read. */
async function listPagesPaged(runtime: ProjectRuntime, request: ListPageRequestV2 = {}): Promise<PagedListOutcomeV2> {
  const built = await captureFence(runtime, LIST_VERBS);
  if (built === null) return refused("permission_denied");
  const { store } = runtime;
  // A version 1 store is reached through its bounded adapter, which refuses a paged listing by name.
  if (!isPagedStore(store)) return adapterListing(runtime);
  const limits = store.scaleCapabilities.limits;
  const limit = request.limit ?? limits.defaultPageSize;
  if (!isWithin(limit, limits.maxPageSize)) return refused("limit_exceeded");
  let after: string | null = null;
  if (request.cursor !== undefined) {
    // Looked at only now: authority was decided above, so a lost grant never reads as a stale cursor.
    after = decodeCursor(runtime.control.secret, listingBinding(runtime, store.catalogRoot()), request.cursor);
    if (after === null) return refused("stale_cursor");
  }
  const labelSets = clearedLabelSets(store, built);
  const page = await store.pagedView().listPage({ prefix: CONCEPTS_PREFIX, labelSets, after, limit });
  return serveListing(runtime, store, page, built);
}

/** The logical path of a page id, or `null` when the id cannot name one. */
function pagePathOf(id: string): string | null {
  const path = conceptPagePath(id);
  try {
    assertLogicalPath(path);
    return path;
  } catch (error) {
    if (error instanceof PortableRefusal) return null;
    throw error;
  }
}

/**
 * Open one page: metadata first, the visibility decision from that metadata,
 * and only then the body. The bytes served are re-hashed against the digest
 * that was authorized.
 */
async function openPagePaged(runtime: ProjectRuntime, id: string): Promise<PagedOpenOutcomeV2> {
  const built = await captureFence(runtime, OPEN_VERBS);
  if (built === null) return refused("permission_denied");
  if (!isPagedStore(runtime.store)) return openV1Page(runtime, pagePathOf(id), built);
  const read = await readVisibleBody(runtime, pagePathOf(id));
  if (read === null) return NOT_VISIBLE;
  // Step 6: the body read took time. The authority and ledger, then the exact bytes' binding, are decided again.
  const state = await fenceState(runtime, OPEN_VERBS, built);
  if (state === "denied") return refused("permission_denied");
  // Last of all, the exact bytes against current labels and grant, then the ledger once more with no await after it.
  if (state === "moved" || !(await isServable(runtime, "page.read", read.stat))) return NOT_VISIBLE;
  if (ledgerToken(runtime) !== built.ledger) return NOT_VISIBLE;
  const page = { ...entryOf(read.stat), revision: read.stat.revision, body: UTF8.decode(read.bytes) };
  return { kind: "opened", page, custody: scaleCapabilitiesOf(runtime.store).custody, notice: ACCESS_NOTICE };
}

/**
 * Reuse v1's curated label reconciliation while holding the store's read gate.
 * The final fence admits the exact observed binding before decoding its bytes.
 */
async function openV1Page(runtime: ProjectRuntime, path: string | null, built: ServeFence): Promise<PagedOpenOutcomeV2> {
  if (path === null) return NOT_VISIBLE;
  return withProjectRead(runtime, async (view) => {
    if (await fenceState(runtime, OPEN_VERBS, built) === "denied") return refused("permission_denied");
    const seen = await observeVisible(runtime, view, path, "page.read");
    if (await fenceState(runtime, OPEN_VERBS, built) === "denied") return refused("permission_denied");
    // The gate keeps the observed digest and labels together. The unchanged grant must clear that exact binding.
    if (seen === null || !isCleared(built.clearances, seen.labels)) return NOT_VISIBLE;
    const entry = entryOf({ path, digest: seen.digest, byteCount: seen.bytes.byteLength, title: path });
    const page = { ...entry, revision: seen.revision, body: UTF8.decode(seen.bytes) };
    return { kind: "opened", page, custody: "v1-compatibility", notice: ACCESS_NOTICE };
  });
}

/**
 * Metadata, the visibility decision from that metadata, and only then the
 * body, re-hashed against the digest that was authorized.
 *
 * @returns `null` when the path is absent, unlabelled, uncleared or no longer those bytes.
 */
async function readVisibleBody(runtime: ProjectRuntime, path: string | null): Promise<{ stat: ObjectStat; bytes: Uint8Array } | null> {
  if (path === null) return null;
  const view = pagedViewOf(runtime.store);
  const stat = await view.stat(path);
  if (stat === null || !(await isServable(runtime, "page.read", stat))) return null;
  const bytes = await view.open(path);
  return bytes !== null && bytesDigest(bytes) === stat.digest ? { stat, bytes } : null;
}

/** Steps 4 and 5 for search hits: confirm each against the ledger; drop the rest without a signal. */
async function serveHits(
  runtime: ProjectRuntime, store: PagedStore, hits: readonly { path: string; digest: ObjectStat["digest"]; score: number }[],
): Promise<PagedSearchHitV2[]> {
  const view = store.pagedView();
  const items: PagedSearchHitV2[] = [];
  for (const hit of hits) {
    const stat = await view.stat(hit.path);
    // The index entry is a claim. Only the ledger's current digest is served, and a changed entry is not back-filled.
    if (stat === null || stat.digest !== hit.digest) continue;
    if (!(await isServable(runtime, "page.read", stat))) continue;
    const { id, path, title, digest } = entryOf(stat);
    items.push({ id, path, title, digest, score: hit.score });
  }
  return items;
}

/**
 * The result limit of a search request, or `null` when the request is over an
 * admitted limit. A query that is too long or names too many terms is refused
 * whole; no term is silently dropped.
 */
function admittedSearchLimit(request: SearchPageRequestV2, limits: PagedStore["scaleCapabilities"]["limits"]): number | null {
  const limit = request.limit ?? limits.defaultSearchLimit;
  const isOversized = request.text.length > MAX_QUERY_LENGTH || queryTerms(request.text).length > limits.maxQueryTerms;
  return isWithin(limit, limits.maxSearchLimit) && !isOversized ? limit : null;
}

/** The answer of a search none of whose partitions could be opened: no hit, no scan, and the index behind. */
function fencedResults(scanBudget: number, custody: PagedSearchResultsV2["custody"]): PagedSearchResultsV2 {
  return {
    kind: "results", items: [], truncated: false, scan: { budget: scanBudget, postingsRead: 0 },
    availability: "index_behind", custody, notice: ACCESS_NOTICE,
  };
}

/**
 * Bounded keyword search over published pages. Its cost is a seek per term
 * plus a scan under the declared budget; it is never independent of project
 * size, and it says `truncated` when the budget ended the scan.
 */
async function searchPaged(runtime: ProjectRuntime, request: SearchPageRequestV2): Promise<PagedSearchOutcomeV2> {
  const built = await captureFence(runtime, SEARCH_VERBS);
  if (built === null) return refused("permission_denied");
  const { store } = runtime;
  if (!isPagedStore(store)) return refused("capability_unsupported", "keywordIndex");
  const limits = store.scaleCapabilities.limits;
  const limit = admittedSearchLimit(request, limits);
  if (limit === null) return refused("limit_exceeded");
  const labelSets = clearedLabelSets(store, built);
  // Clearance and the label epoch are fixed BEFORE the index reads, counts, budgets or ranks anything.
  const answer = store.index().query({
    labelSets, labelEpoch: store.labelEpoch(), text: request.text, limit, scanBudget: limits.scanBudget,
  });
  const items = await serveHits(runtime, store, answer.hits);
  // Step 6: both verbs and the clearances again, so a loss during serving returns no item, budget or availability.
  const state = await fenceState(runtime, SEARCH_VERBS, built);
  if (state === "denied") return refused("permission_denied");
  const custody = store.scaleCapabilities.custody;
  // The ledger moved under the answer. Nothing buffered is returned: the caller gets what a fenced index gives.
  // Compared once more here, with no await after it: a bind can land between the fence deciding and this line.
  if (state === "moved" || ledgerToken(runtime) !== built.ledger) return fencedResults(limits.scanBudget, custody);
  return {
    kind: "results", items, truncated: answer.truncated,
    scan: { budget: limits.scanBudget, postingsRead: answer.postingsRead },
    // Computed from the caller's cleared partitions only; never from a partition it cannot open.
    availability: answer.fenced > 0 ? "index_behind" : "current", custody, notice: ACCESS_NOTICE,
  };
}

/** Say which protocol was agreed and what this project's store declares. */
async function negotiateScale(runtime: ProjectRuntime): Promise<ScaleNegotiationOutcomeV2> {
  if ((await captureFence(runtime, ["project.open"])) === null) return refused("permission_denied");
  return { kind: "negotiated", protocol: SCALE_PROTOCOL_V2, capabilities: scaleCapabilitiesOf(runtime.store) };
}

/** Bind the paged reads to one session's runtime. */
export function createPagedProject(runtime: ProjectRuntime): PagedProjectV2 {
  return {
    protocol: SCALE_PROTOCOL_V2,
    negotiate: () => negotiateScale(runtime),
    pages: { listPage: (request) => listPagesPaged(runtime, request), open: (id) => openPagePaged(runtime, id) },
    search: (request) => searchPaged(runtime, request),
  };
}
