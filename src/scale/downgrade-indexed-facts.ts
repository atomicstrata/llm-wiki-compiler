/**
 * @file src/scale/downgrade-indexed-facts.ts
 * @description The read-only facts an indexed scale-down binds about the
 * `.llmwiki/indexed` stores and their maintenance state, read from manifest
 * leaves alone (no segment, no snapshot, no reader lease):
 *
 * - every store with the SHA-256 of its exact manifest bytes;
 * - the workspaces holding a segmented operation catalog (from each
 *   catalog manifest's own `workspaceId`, which must be a string that hashes
 *   to the store's name, exactly as the indexed store verification requires;
 *   any other identity is a blocker naming the store, never an omission);
 * - every batch run store with its phase (an active one is a blocker), and
 *   the compile state's last published run;
 * - the pins (labels and the digest that binds every pinned copy);
 * - unfinished maintenance: a restore marker, a run retirement's quarantine
 *   or a live retirement barrier (blockers: settle them first).
 * Anything unexpected or unreadable here is a blocker, never skipped.
 */

import { lstat } from "node:fs/promises";
import path from "node:path";
import { isRunStoreName, RUN_STORE_PREFIX } from "../compiler/batch/contracts.js";
import { unleasedRunMeta } from "../compiler/batch/run-store.js";
import { CSTATE_STORE } from "../cstate/contracts.js";
import { OPERATION_CATALOG_STORE_PREFIX, operationCatalogStore } from "../history/operation-catalog.js";
import { listStores } from "../indexed/gc-inventory.js";
import { readPins } from "../indexed/pins.js";
import { RETIRING_DIR } from "../indexed/run-retire-quarantine.js";
import { sha256Hex } from "../segments/format.js";
import { readManifestLeaf } from "../segments/io.js";
import { parseManifest } from "../segments/manifest.js";
import { retireFenceState } from "../segments/retire-barrier.js";
import type { DowngradeBlockerV1, DowngradeRunV1 } from "./downgrade-contracts.js";

/** The restore marker's leaf (`../segments/restore-marker.ts` names the same path). */
const RESTORE_MARKER = ".llmwiki/indexed-restore.json";

/** What a scale-down binds about the indexed stores. */
export interface IndexedFactsV1 {
  readonly stores: ReadonlyArray<{ readonly name: string; readonly manifestSha256: string }>;
  readonly workspaces: readonly string[];
  readonly runs: readonly DowngradeRunV1[];
  readonly lastRun: string | null;
  readonly pins: { readonly labels: readonly string[]; readonly digest: string };
  readonly blockers: readonly DowngradeBlockerV1[];
}

/** Whether anything is at `relPath` (anything but a clean absence counts). */
async function present(root: string, relPath: string): Promise<boolean> {
  return lstat(path.join(root, relPath)).then(() => true, (error: NodeJS.ErrnoException) => error.code !== "ENOENT");
}

/** Blockers for unfinished maintenance that a scale-down must not run beside. */
async function maintenanceBlockers(root: string): Promise<DowngradeBlockerV1[]> {
  const blockers: DowngradeBlockerV1[] = [];
  if (await present(root, RESTORE_MARKER)) blockers.push({ code: "restore_in_progress", detail: `${RESTORE_MARKER} exists; finish the indexed-authority restore first` });
  if (await present(root, RETIRING_DIR)) blockers.push({ code: "retirement_unfinished", detail: `${RETIRING_DIR} exists; finish the run retirement first (\`llmwiki catalog runs\`)` });
  if ((await retireFenceState(root)).kind === "blocking") blockers.push({ code: "retirement_unfinished", detail: "a run retirement or scale-down barrier is held by a process that may be running" });
  return blockers;
}

/** The manifest digest and parsed meta of `store`, or a blocker message. */
async function manifestOf(root: string, store: string): Promise<{ sha: string; meta: Record<string, unknown> } | string> {
  try {
    const read = await readManifestLeaf(root, store);
    if (read.kind === "absent") return `store ${store} has no manifest`;
    return { sha: sha256Hex(read.bytes), meta: parseManifest(read.bytes, store).meta as Record<string, unknown> };
  } catch (error) {
    return `store ${store}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** The run of one run store, an active one also as a blocker. */
async function runOf(root: string, store: string, blockers: DowngradeBlockerV1[]): Promise<DowngradeRunV1 | null> {
  const runId = store.slice(RUN_STORE_PREFIX.length);
  try {
    const { phase } = await unleasedRunMeta(root, runId);
    if (phase !== "done" && phase !== "superseded") blockers.push({ code: "batch_run_active", detail: `batch compile run ${runId} is ${phase}; finish or restart it first` });
    return { runId, status: phase };
  } catch (error) {
    blockers.push({ code: "indexed_inventory_invalid", detail: `run store ${store} cannot be read: ${error instanceof Error ? error.message : String(error)}` });
    return null;
  }
}

/** The workspace a catalog store's manifest meta names, when it is a string that hashes to the store's own `name`; else null. */
function catalogWorkspace(name: string, meta: Record<string, unknown>): string | null {
  const workspaceId = meta.workspaceId;
  return typeof workspaceId === "string" && operationCatalogStore(workspaceId) === name ? workspaceId : null;
}

/** Fold one store's manifest into the facts being built. */
async function foldStore(root: string, name: string, facts: { stores: IndexedFactsV1["stores"][number][]; workspaces: string[]; runs: DowngradeRunV1[]; blockers: DowngradeBlockerV1[]; lastRun: string | null }): Promise<void> {
  const manifest = await manifestOf(root, name);
  if (typeof manifest === "string") { facts.blockers.push({ code: "indexed_inventory_invalid", detail: manifest }); return; }
  facts.stores.push({ name, manifestSha256: manifest.sha });
  if (name.startsWith(OPERATION_CATALOG_STORE_PREFIX)) {
    const workspaceId = catalogWorkspace(name, manifest.meta);
    if (workspaceId === null) facts.blockers.push({ code: "indexed_inventory_invalid", detail: `store ${name}: its manifest names no valid workspace` });
    else facts.workspaces.push(workspaceId);
  }
  if (name === CSTATE_STORE && typeof manifest.meta.lastRun === "string") facts.lastRun = manifest.meta.lastRun;
  if (isRunStoreName(name)) {
    const run = await runOf(root, name, facts.blockers);
    if (run !== null) facts.runs.push(run);
  }
}

/** The indexed facts of the project at `root`. */
export async function indexedFacts(root: string): Promise<IndexedFactsV1> {
  const listed = await listStores(root);
  const facts = { stores: [] as IndexedFactsV1["stores"][number][], workspaces: [] as string[], runs: [] as DowngradeRunV1[], blockers: [...await maintenanceBlockers(root)], lastRun: null as string | null };
  for (const detail of listed.blockers) facts.blockers.push({ code: "indexed_inventory_invalid", detail });
  for (const name of listed.stores) await foldStore(root, name, facts);
  const pins = await readPins(root, new Set(listed.stores));
  for (const detail of pins.blockers) facts.blockers.push({ code: "indexed_inventory_invalid", detail });
  return { ...facts, workspaces: facts.workspaces.sort(), pins: { labels: pins.labels, digest: pins.digest } };
}
