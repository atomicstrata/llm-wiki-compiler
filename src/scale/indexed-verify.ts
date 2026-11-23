/**
 * @file src/scale/indexed-verify.ts
 * @description The `activation-verify` step: the last check of reality before
 * `local-indexed` becomes the active authority. Explicit O(stored data) work,
 * run once per preparation.
 *
 * It reconciles the catalog one final time (absorbing any change made while
 * preparing), then fully verifies every store (`../indexed/verify.ts`): the
 * catalog's rows and counts, the event chain and head anchor, the relation
 * indexes, every workspace catalog's lineage (a missing manifest or an
 * unimported catalog file fails), the vector rows, and each backup's bytes.
 * Any failure parks the step with the first problem, and the project stays
 * on the incumbent files.
 */

import { openCatalog } from "../catalog/meta.js";
import { syncCatalog } from "../catalog/sync.js";
import { verifyIndexedStores } from "../indexed/verify.js";
import { parkOnStoreFault, stepOutcome } from "./step-outcome.js";
import type { StepOutcome } from "./steps.js";

/** Verify everything `local-indexed` will serve from; done only when every store is whole. */
export function activationVerifyStep(root: string): Promise<StepOutcome> {
  return parkOnStoreFault("activation-verify", async () => {
    const catalog = await syncCatalog(root, await openCatalog(root));
    const report = await verifyIndexedStores(root);
    if (!report.ok) {
      const first = report.stores[0]!;
      return stepOutcome("parked", `activation-verify: ${report.storesFailed} of ${report.storesChecked} stores failed; ${first.store}: ${first.problemCount} problem(s): ${first.problems.join("; ")}`);
    }
    const records = report.stores.reduce((sum, store) => sum + store.records, 0);
    return stepOutcome("done", `verified ${report.storesChecked} stores (${records} records in the sampled reports) and ${catalog.reprojected} newly catalogued files; backups unchanged`);
  });
}
