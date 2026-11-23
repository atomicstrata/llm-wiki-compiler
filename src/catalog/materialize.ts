/**
 * @file src/catalog/materialize.ts
 * @description WHOLE-LIST compatibility materializers over the catalog, for
 * surfaces whose protocol returns one complete array (the MCP resource lists).
 *
 * These are NOT bounded operations: they stream every matching catalog row
 * (O(rows) work and output) and are declared as such. Only page NAMES are
 * served this way (no per-file reads); the MCP source summaries keep the
 * incumbent full-frontmatter read of every source, a declared global
 * compatibility read, with the catalog's freshness note beside it. Bounded
 * callers use the keyset reads in `./reads.ts` instead.
 *
 * {@link routedPageFileNames} and {@link indexedCatalogNote} are the routed
 * forms the MCP resources reach through the `compiler-cli` contract (so the
 * standard composition never imports core storage directly).
 */

import { indexedActive } from "../indexed/routing.js";
import { listPageFileNames } from "../pages/file-names.js";
import type { SegmentStore } from "../segments/store.js";
import type { CONCEPTS_DIR, QUERIES_DIR } from "../utils/constants.js";
import { PAGE_DIRECTORIES } from "./contracts.js";
import { catalogFreshness, type CatalogListingNote } from "./reads.js";
import { openActiveCatalog } from "./routes.js";

/** Every catalogued page file name (`<slug>.md`) of one directory (given by its project-relative path), in key order. O(rows). */
async function catalogPageFileNames(store: SegmentStore, relDir: string): Promise<string[]> {
  const dir = PAGE_DIRECTORIES.find(([, path]) => path === relDir)?.[0];
  if (dir === undefined) return [];
  const prefix = `p:${dir}/`;
  const names: string[] = [];
  for await (const row of store.scan({ prefix })) names.push(`${row.k.slice(prefix.length)}.md`);
  store.counters.rowsReturned += names.length;
  return names;
}

/** A page directory's file names: the catalog's on a `local-indexed` project, else the incumbent directory listing (same contract). */
export async function routedPageFileNames(root: string, relDir: typeof CONCEPTS_DIR | typeof QUERIES_DIR): Promise<string[]> {
  return (await indexedActive(root)) ? catalogPageFileNames(await openActiveCatalog(root), relDir) : listPageFileNames(root, relDir);
}

/** The catalog's freshness note on a `local-indexed` project, else `null`. Bounded (directory stamps). */
export async function indexedCatalogNote(root: string): Promise<CatalogListingNote | null> {
  return (await indexedActive(root)) ? catalogFreshness(root, await openActiveCatalog(root)) : null;
}
