/**
 * @file src/commands/operation/list.ts
 * @description `llmwiki operation list` — enumerate operation bundles and their
 * runs (including parked/recovery-blocking ones) plus the whole-workspace
 * recovery state. Read-only: it never acquires the lock or mutates a byte, and
 * always exits 0 on a successful inspection (problems are shown, not signalled
 * via the exit code).
 */

import * as output from "../../utils/output.js";
import { resolveOperationRecoveryState } from "../../operation-bundles/lock-gate.js";
import type { OperationRunState } from "../../operation-bundles/run-types.js";
import type { OperationBundleManifest, OperationDigest } from "../../operation-bundles/types.js";
import { loadOperationInventory, readKeyEpoch, readRunForTarget, resolvedFromManifest } from "./resolve.js";
import { emitJson } from "./render.js";

/** CLI options for `operation list`. */
export interface OperationListOptions {
  /** Emit the machine-readable envelope instead of the human table. */
  json?: boolean;
}

/** One enumerated bundle/run row. */
interface OperationRow {
  workspaceId: string;
  bundleId: string;
  runId: string;
  state: OperationRunState | null;
  detail: string | null;
}

/** Build one row by reading the manifest's run leaf under the key epoch. */
async function buildRow(
  root: string,
  manifest: OperationBundleManifest,
  keyEpochId: OperationDigest,
): Promise<OperationRow> {
  const read = await readRunForTarget(root, resolvedFromManifest(manifest), keyEpochId);
  const base = { workspaceId: manifest.workspaceId, bundleId: manifest.bundleId, runId: manifest.runId };
  if (read.status === "ok") return { ...base, state: read.run.state, detail: null };
  if (read.status === "absent") return { ...base, state: null, detail: "run-absent" };
  return { ...base, state: null, detail: read.detail };
}

/** Read every manifest's run row (or an empty list when no key epoch is present). */
async function collectRows(root: string, manifests: readonly OperationBundleManifest[]): Promise<OperationRow[]> {
  const keyEpochId = await readKeyEpoch(root);
  if (keyEpochId === null) return manifests.map((manifest) => ({ workspaceId: manifest.workspaceId, bundleId: manifest.bundleId, runId: manifest.runId, state: null, detail: "integrity-key-unavailable" }));
  return Promise.all(manifests.map((manifest) => buildRow(root, manifest, keyEpochId)));
}

/** Render one bundle/run row. */
function renderRow(row: OperationRow): void {
  const state = row.state ?? `unreadable (${row.detail})`;
  output.status("~", output.info(`${row.bundleId}  run=${row.runId}  ws=${row.workspaceId}  state=${state}`));
}

/** Render the human table: a recovery line, then one line per bundle/run. */
function renderHuman(recoveryState: string, rows: readonly OperationRow[], problems: number): void {
  output.header("llmwiki operation list");
  output.status("i", output.info(`Recovery: ${recoveryState}`));
  if (problems > 0) output.status("!", output.warn(`Inventory problems: ${problems} (run recovery before mutating)`));
  if (rows.length === 0) {
    output.status("✓", output.success("No operation bundles."));
    return;
  }
  rows.forEach(renderRow);
}

/**
 * Enumerate operation bundles and the workspace recovery state.
 *
 * @param root - The project root to inspect.
 * @param options - `--json` toggles the machine-readable envelope.
 * @returns Exit code 0 (a successful inspection always exits 0).
 */
export async function operationListCommand(root: string, options: OperationListOptions = {}): Promise<number> {
  if (options.json) output.setQuiet(true);
  try {
    const inventory = await loadOperationInventory(root);
    const recoveryState = await resolveOperationRecoveryState(root);
    const rows = await collectRows(root, inventory.manifests);
    if (options.json) {
      emitJson({ recoveryState, inventoryProblems: inventory.problems.length, bundles: rows });
    } else {
      renderHuman(recoveryState, rows, inventory.problems.length);
    }
    return 0;
  } finally {
    if (options.json) output.setQuiet(false);
  }
}
