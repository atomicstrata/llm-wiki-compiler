/**
 * @file src/catalog/facade.ts
 * @description The catalog's own operations behind the CLI `catalog` group
 * and the SDK `wiki.catalog` facade: an explicit full verification of every
 * indexed store, and a bounded status (manifest counts and
 * one stat per catalogued directory) and an explicit, locked reconciliation.
 *
 * Both answer only on a project whose ACTIVE architecture is
 * `local-indexed`. Elsewhere status says the catalog is not active and
 * reconciliation refuses with `catalog_not_active`: there is no catalog to
 * reconcile, and nothing is created.
 */

import { indexedActive } from "../indexed/routing.js";
import { withRegisteredProjectLock } from "../operation-bundles/registered-project-lock.js";
import type { CatalogCounts } from "./contracts.js";
import { openActiveCatalog } from "./routes.js";
import { catalogCountsIndexed, type CatalogListingNote } from "./reads.js";
import { syncCatalog } from "./sync.js";
import { verifyIndexedStores, type IndexedVerificationV1 } from "../indexed/verify.js";

/** What `catalog status` reports. */
export interface CatalogStatusV1 {
  readonly active: boolean;
  readonly counts?: CatalogCounts;
  readonly catalog?: CatalogListingNote;
}

/** What one explicit reconciliation did. */
export interface CatalogSyncReportV1 {
  readonly reprojected: number;
  readonly removed: number;
  readonly uncatalogued: number;
}

/**
 * The catalog is not the active authority of this project. `code`
 * (`catalog_not_active`) is the stable programmatic contract: the CLI maps it
 * to its refusal envelope and exit code, and SDK callers can branch on it.
 */
export class CatalogNotActiveError extends Error {
  readonly code = "catalog_not_active";
  constructor() {
    super("catalog_not_active: this project's active architecture is not local-indexed; nothing to reconcile");
    this.name = "CatalogNotActiveError";
  }
}

/** Bounded catalog status of the project at `root`. Read-only. */
export async function catalogStatus(root: string): Promise<CatalogStatusV1> {
  if (!(await indexedActive(root))) return { active: false };
  const { counts, catalog } = await catalogCountsIndexed(root, await openActiveCatalog(root));
  return { active: true, counts, catalog };
}

/**
 * Fully verify every indexed store of `root` (catalog, histories, workspace
 * catalogs, vectors, backup bytes): explicit, read-only O(stored data) work.
 * Health is for this response only; nothing is written.
 */
export async function catalogVerify(root: string): Promise<IndexedVerificationV1> {
  if (!(await indexedActive(root))) throw new CatalogNotActiveError();
  return verifyIndexedStores(root);
}

/** Reconcile the catalog of `root` with its files under the gated project lock: explicit O(files) work. */
export async function catalogSync(root: string): Promise<CatalogSyncReportV1> {
  if (!(await indexedActive(root))) throw new CatalogNotActiveError();
  return withRegisteredProjectLock(root, async () => {
    const result = await syncCatalog(root, await openActiveCatalog(root));
    return { reprojected: result.reprojected, removed: result.removed, uncatalogued: result.uncatalogued };
  });
}
