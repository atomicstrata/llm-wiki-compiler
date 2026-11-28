/**
 * @file src/scale/steps-indexed.ts
 * @description The preparation steps of a `local-indexed` transition. Each
 * runs against reality every time (a resumed transition re-verifies rather
 * than trusting a checkpoint), each is idempotent, and each writes only under
 * `.llmwiki/indexed/`. Until activation every reader and writer keeps using
 * the incumbent files, so a partly built indexed store is invisible.
 *
 * - `catalog-build` reconciles the catalog with the files (batched durable
 *   checkpoints; a rerun skips files already catalogued by stamp).
 * - `history-import` copies each incumbent single-file history (events,
 *   relations, workspace operation catalogs) into its segmented store
 *   (`../history/history-import.ts`); any refusal parks the step.
 * - `vector-shards` imports the incumbent embedding store into float32
 *   pieces (`../vectors/import.ts`).
 * - `activation-verify` reconciles the catalog once more and fully verifies
 *   every store against itself and its backup (`./indexed-verify.ts`).
 */

import { openCatalog } from "../catalog/meta.js";
import { importCompileState } from "../cstate/import.js";
import { syncCatalog } from "../catalog/sync.js";
import { importHistories } from "../history/history-import.js";
import { importVectors } from "../vectors/import.js";
import type { CapabilityNameV3 } from "./contracts-v2.js";
import { activationVerifyStep } from "./indexed-verify.js";
import { parkOnStoreFault, stepOutcome } from "./step-outcome.js";
import type { StepOutcome } from "./steps.js";

/** The indexed steps, each a fresh check of reality. */
export interface IndexedPreparation {
  catalogBuild(): Promise<StepOutcome>;
  historyImport(): Promise<StepOutcome>;
  vectorShards(): Promise<StepOutcome>;
  activationVerify(): Promise<StepOutcome>;
  /** The preparation of one capability on an already active indexed project (verification runs after every one). */
  capability(name: CapabilityNameV3): Promise<StepOutcome>;
}

/** The preparation of capability `name` on the active indexed project at `root`. */
function capabilityStep(root: string, name: CapabilityNameV3): Promise<StepOutcome> {
  if (name === "typed-entity-catalog-1") return buildCatalogStep(root);
  return importCompileStateStep(root);
}

/** Import `state.json` of `root` into the segmented compile state; any refusal parks. */
function importCompileStateStep(root: string): Promise<StepOutcome> {
  return parkOnStoreFault("compile-state-import", async () => {
    try {
      const report = await importCompileState(root);
      return stepOutcome("done", `compile state ${report.imported ? "imported" : "already imported"}: ${report.sources} sources, ${report.owners} owner rows, ${report.frozen} frozen slugs`);
    } catch (error) {
      return stepOutcome("parked", `compile-state-import: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

/** Build or resume the catalog of `root`. */
function buildCatalogStep(root: string): Promise<StepOutcome> {
  return parkOnStoreFault("catalog-build", async () => {
    const result = await syncCatalog(root, await openCatalog(root));
    return stepOutcome("done", `catalog reconciled: ${result.reprojected} files projected, ${result.removed} removed, ${result.uncatalogued} uncatalogued (links or over-long names)`);
  });
}

/** Import every incumbent history of `root` into its segmented store. */
function importHistoryStep(root: string): Promise<StepOutcome> {
  return parkOnStoreFault("history-import", async () => {
    try {
      return stepOutcome("done", await importHistories(root));
    } catch (error) {
      return stepOutcome("parked", `history-import: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

/** Import the incumbent embedding store of `root` into float32 pieces. */
function importVectorsStep(root: string): Promise<StepOutcome> {
  return parkOnStoreFault("vector-shards", async () => {
    try {
      return stepOutcome("done", await importVectors(root));
    } catch (error) {
      return stepOutcome("parked", `vector-shards: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

/** LOCAL DISK. The indexed steps of the project at `root`. */
export function diskIndexedPreparation(root: string): IndexedPreparation {
  return {
    catalogBuild: () => buildCatalogStep(root),
    historyImport: () => importHistoryStep(root),
    vectorShards: () => importVectorsStep(root),
    activationVerify: () => activationVerifyStep(root),
    capability: (name) => capabilityStep(root, name),
  };
}
