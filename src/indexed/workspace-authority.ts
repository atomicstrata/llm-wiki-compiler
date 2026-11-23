/**
 * @file src/indexed/workspace-authority.ts
 * @description Which workspaces of a project hold operation-catalog AUTHORITY
 * that a set of captured stores does not represent: an indexed operation
 * catalog store, or an incumbent workspace catalog file (the same inventory
 * full verification uses), found WITHOUT opening any store. Shared by backup
 * capture (refuse to write an index for an incomplete copy) and restore
 * preflight (refuse to restore over authority the backup lacks). Empty
 * workspace directories hold no authority and pass.
 */

import { backupAbsent } from "../history/contracts.js";
import { legacyCatalogPath, operationCatalogStore } from "../history/operation-catalog.js";
import { newCounters } from "../segments/counters.js";
import { listConfinedDirBounded } from "../utils/confined-dir.js";

/** Most workspace directories the preflight inventory lists. */
const MAX_WORKSPACES = 10_000;

/**
 * Workspaces of the target that hold operation-catalog AUTHORITY the backup
 * does not: an indexed store or an incumbent catalog file (the same inventory
 * full verification uses), found WITHOUT opening any store. Empty workspace
 * directories are harmless and pass.
 */
export async function unbackedWorkspaceAuthority(root: string, stores: readonly string[], backedUp: readonly string[]): Promise<string[]> {
  const listing = await listConfinedDirBounded(root, ".llmwiki/workspaces", MAX_WORKSPACES);
  if (listing.kind === "absent") return [];
  if (listing.kind !== "ok") return ["the target's workspaces directory cannot be listed in full"];
  const problems: string[] = [];
  for (const entry of listing.entries) {
    if (entry.kind !== "directory" || entry.name.startsWith(".") || backedUp.includes(entry.name)) continue;
    const holds = stores.includes(operationCatalogStore(entry.name)) || !(await backupAbsent(root, legacyCatalogPath(root, entry.name), newCounters()));
    if (holds) problems.push(`target workspace ${entry.name} holds operation-catalog authority the backup does not`);
  }
  return problems;
}
