/**
 * @file src/catalog/routes.ts
 * @description The ordinary CLI and SDK paths through the catalog.
 *
 * Every entry first asks whether `local-indexed` is the ACTIVE architecture
 * (`indexed/routing.ts`). If not — no estimate, `local-standard`,
 * `local-large`, or an unfinished preparation — the incumbent body runs
 * exactly as before. If so:
 *
 * - LISTINGS (`listPages`, `listSources`) are bounded keyset pages from the
 *   catalog, with an explicit `catalog` note; a custom profile's entity pages
 *   come from the typed entity catalog once its version 3 capability is
 *   `ready` (otherwise the listing refuses);
 * - INGEST looks the source identity up in the catalog instead of reading
 *   every source (after reconciling the sources directory, under the writer's
 *   lock, when it is stale), then writes the saved file through;
 * - SOURCE DELETION tombstones the deleted row;
 * - compile, `review approve` and `rm` housekeeping RECONCILE the catalog at
 *   their end under their lock: explicit global stat work, beside the global
 *   work those commands already do.
 *
 * Nothing here manufactures labels, receipts or custody; files stay the truth.
 */

import path from "node:path";
import { indexedActive } from "../indexed/routing.js";
import { listPages, type ListPagesOptions, type ListPagesResult } from "../pages/list.js";
import { loadNonDefaultProfile } from "../profile/block.js";
import { ScaleGateError } from "../scale/gate.js";
import { loadSourceSelection } from "../sources/selection.js";
import { deleteSource, listSources } from "../sources/store.js";
import type { ListSourcesOptions, ListSourcesResult } from "../sources/source-record.js";
import { journalHealthWarning } from "../trust/journal-health-warning.js";
import { diskSourceWriterLeaves, saveSourceWith } from "../utils/source-writer.js";
import type { WriteStatus } from "../utils/types.js";
import { captureDirStamps } from "./files.js";
import { catalogMetaOf, openCatalog } from "./meta.js";
import { corrupt } from "../segments/contracts.js";
import type { SegmentStore } from "../segments/store.js";
import type { LoadedProfile } from "../profile/types.js";
import { CatalogTypedError, profileBlockIndexed } from "./entity-reads.js";
import { listPagesIndexed, listSourcesIndexed, lookupSourceIdentity, sourcesFresh, StaleRows, withExtraStaleRows } from "./reads.js";
import { typedCatalogStatus } from "./typed-admission.js";
import { syncCatalog } from "./sync.js";
import { catalogWriteThrough } from "./write-through.js";
import { assertSourceDocumentFits } from "./source-admission.js";

/**
 * The catalog of an ACTIVE indexed project. Its manifest must exist and must
 * have completed its first build: an active project without one, or with a
 * never-finished (building) catalog, fails closed rather than serving it. An
 * interrupted LATER reconciliation (`reconciling`) is served with that state
 * reported on every listing, and `catalog sync` resumes it.
 */
export async function openActiveCatalog(root: string): Promise<SegmentStore> {
  const store = await openCatalog(root);
  if (!store.exists) corrupt("the active local-indexed project has no catalog manifest; restore .llmwiki/indexed/catalog from a backup");
  if (catalogMetaOf(store).phase === "building") corrupt("the active local-indexed project's catalog never finished its first build; restore it from a backup");
  return store;
}

/**
 * The custom profile an indexed listing serves through the typed entity
 * catalog, or undefined for the default profile. An unloadable profile, or a
 * custom profile without the `ready` typed-catalog capability, refuses.
 */
async function servedProfile(root: string): Promise<LoadedProfile | undefined> {
  const profile = await loadNonDefaultProfile(root).catch(() => "unloadable" as const);
  if (profile === undefined) return undefined;
  if (profile === "unloadable") throw new ScaleGateError("scale-profile-ineligible", "the effective profile cannot be loaded");
  const status = await typedCatalogStatus(root);
  if (status === "preparing") throw new CatalogTypedError("catalog_typed_preparing", "the typed entity catalog is still being prepared; run `llmwiki scale prepare`");
  if (status === "absent") throw new ScaleGateError("scale-profile-ineligible", "the scale record does not carry the typed-entity-catalog-1 capability");
  return profile;
}

/** `listPages` on the active authority; a custom profile's entity pages come from the typed entity catalog. */
export async function routedListPages(root: string, options: ListPagesOptions = {}): Promise<ListPagesResult> {
  if (!(await indexedActive(root))) return listPages(root, options);
  const loaded = await servedProfile(root);
  const store = await openActiveCatalog(root);
  let result = await listPagesIndexed(root, store, options);
  if (loaded !== undefined) {
    const notes = { stale: new StaleRows(), budgetExhausted: false };
    const profile = await profileBlockIndexed(root, store, loaded, options, notes);
    result = withExtraStaleRows({ ...result, profile }, notes.stale);
    if (notes.budgetExhausted) result = { ...result, catalog: { ...result.catalog!, scanBudgetExhausted: true } };
  }
  const journal = await journalHealthWarning(root);
  return journal === null ? result : { ...result, warnings: [...(result.warnings ?? []), journal] };
}

/** `listSources` on the active authority. */
export async function routedListSources(root: string, options: ListSourcesOptions = {}): Promise<ListSourcesResult> {
  if (!(await indexedActive(root))) return listSources(root, options);
  return listSourcesIndexed(root, await openActiveCatalog(root), await loadSourceSelection(root), options);
}

/**
 * Save an ingested source on the active authority. The caller holds the gated
 * project lock (an indexed project always carries a scale record, so the
 * registered-project wrapper takes it).
 */
export async function saveSourceRouted(root: string, title: string, document: string, source: string): Promise<{ path: string; writeStatus: WriteStatus }> {
  const leaves = diskSourceWriterLeaves(root);
  if (!(await indexedActive(root))) return saveSourceWith(leaves, title, document, source);
  assertSourceDocumentFits(document);
  let store = await openActiveCatalog(root);
  if (!(await sourcesFresh(root, store))) store = (await syncCatalog(root, store)).store;
  const before = await captureDirStamps(root, store.counters);
  const selection = await loadSourceSelection(root);
  const saved = await saveSourceWith({ ...leaves, lookupIdentity: () => lookupSourceIdentity(root, store, selection, source) }, title, document, source);
  if (saved.writeStatus !== "unchanged") {
    const id = path.relative(await leaves.openSourcesDir(), saved.path).split(path.sep).join("/");
    await catalogWriteThrough(root, [{ kind: "source", id }], before, store.counters);
  }
  return saved;
}

/** Delete one source on the active authority. The caller holds the lock when the project is registered or indexed. */
export async function deleteSourceRouted(root: string, id: string): Promise<boolean> {
  if (!(await indexedActive(root))) return deleteSource(root, id);
  const store = await openActiveCatalog(root);
  const before = await captureDirStamps(root, store.counters);
  const removed = await deleteSource(root, id);
  if (removed) await catalogWriteThrough(root, [{ kind: "source", id }], before, store.counters);
  return removed;
}

/** Reconcile the catalog at the end of a locked global writer (compile, review approve, rm housekeeping). */
export async function reconcileCatalogIfIndexed(root: string): Promise<void> {
  if (!(await indexedActive(root))) return;
  await syncCatalog(root, await openActiveCatalog(root));
}
