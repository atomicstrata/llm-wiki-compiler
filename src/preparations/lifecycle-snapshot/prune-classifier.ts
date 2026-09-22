/**
 * @file src/preparations/lifecycle-snapshot/prune-classifier.ts
 * @description Prune/sweep classification from authenticated receipt content
 * and current source/staging postconditions. Filename prefixes are only an
 * additional consistency check and never select authority semantics.
 */

import path from "node:path";
import type { PruneReceiptV1 } from "../receipts.js";
import type { PreparationLifecycleNamespaceV1 } from "../lifecycle-fs/types.js";
import type { LifecycleUnitObservation } from "../lifecycle-fs/observe.js";
import { lifecycleStagedDeleteName } from "../paths.js";
import { lifecycleRelativePath } from "../lifecycle-fs/observe.js";
import { lifecyclePruneUnitPaths } from "../lifecycle-fs/paths.js";
import type { CapturedLifecycleKey } from "../lifecycle-fs/key-observation.js";
import type { LifecycleScanBounds } from "../lifecycle-fs/bounds.js";
import {
  LifecycleReceiptReadError,
  lifecycleReceiptPairMatches,
  observeBoundLifecycleReceipt,
} from "./records.js";
import {
  LifecyclePostconditionError,
  prunePostcondition,
} from "./postconditions.js";
import {
  lifecycleObservationDisposition,
  type LifecyclePassOneUnit,
} from "./classifier-types.js";
import type {
  PreparationLifecycleProblemV1,
  PreparationLifecycleUnitV1,
} from "./types.js";

/** Fixed receipt names derived from the path schema. */
function pruneNames(
  namespace: PreparationLifecycleNamespaceV1,
  unitId: string,
) {
  const paths = lifecyclePruneUnitPaths(namespace, unitId);
  return {
    paths,
    planned: path.basename(paths.plannedReceiptFile),
    completed: path.basename(paths.completedReceiptFile),
  };
}

/** One stable prune/sweep refusal. */
function unavailable(
  namespace: PreparationLifecycleNamespaceV1,
  observation: LifecycleUnitObservation,
  detail: string,
  code: PreparationLifecycleProblemV1["code"] = "unit-unavailable",
  operation: PreparationLifecycleUnitV1["operation"] = null,
): LifecyclePassOneUnit {
  return {
    unit: {
      registry: "prune",
      unitId: observation.unitId,
      operation,
      state: "unavailable",
    },
    problem: {
      code,
      registry: "prune",
      unitId: observation.unitId,
      path: lifecycleRelativePath(namespace.root.realPath, observation.unitRoot),
      detail,
    },
    retirementEvidence: [],
  };
}

/** Public operation projected only after receipt authentication. */
function pruneOperation(receipt: PruneReceiptV1) {
  return receipt.operation === "prune"
    ? "run-prune" as const
    : "orphan-sweep" as const;
}

/** Prefix is an extra consistency guard after authenticated content chooses. */
function prefixMatches(unitId: string, receipt: PruneReceiptV1): boolean {
  return receipt.operation === "prune"
    ? unitId.startsWith("prn-")
    : unitId.startsWith("swp-");
}

/** Unit-root contents authorized by the signed plan and its object count. */
function inventoryClosed(
  observation: LifecycleUnitObservation,
  planned: PruneReceiptV1,
  completedName: string,
  plannedName: string,
): boolean {
  const allowed = new Set([plannedName, completedName]);
  planned.objects.forEach((_object, index) => {
    allowed.add(lifecycleStagedDeleteName(index));
  });
  return (observation.directory?.names ?? []).every((name) => allowed.has(name));
}

/** One inert or active result without problems. */
function result(
  observation: LifecycleUnitObservation,
  operation: PreparationLifecycleUnitV1["operation"],
  state: PreparationLifecycleUnitV1["state"],
): LifecyclePassOneUnit {
  return {
    unit: { registry: "prune", unitId: observation.unitId, operation, state },
    retirementEvidence: [],
  };
}

/** Classify one prune/sweep unit from the captured current key and inventory. */
export async function classifyPrunePassOne(
  namespace: PreparationLifecycleNamespaceV1,
  observation: LifecycleUnitObservation,
  key: CapturedLifecycleKey,
  bounds: LifecycleScanBounds,
): Promise<LifecyclePassOneUnit> {
  const disposition = lifecycleObservationDisposition(observation);
  if (disposition.status === "unavailable") {
    return unavailable(namespace, observation, disposition.detail, disposition.code);
  }
  if (disposition.status === "inert") return result(observation, null, "inert");
  const names = pruneNames(namespace, observation.unitId);
  try {
    const planned = await observeBoundLifecycleReceipt(
      namespace, names.paths.plannedReceiptFile, observation.unitRoot,
      observation.unitId, "prune-planned", key, bounds,
    );
    if (planned === "absent") {
      return unavailable(
        namespace,
        observation,
        `prune unit ${observation.unitId} holds durable contents with no authenticated plan; ` +
        `inspect and remove ${observation.unitRoot} before sweeping`,
      );
    }
    if (!planned.authenticated) {
      return unavailable(namespace, observation, "prune receipt failed verification");
    }
    const plan = planned.receipt as PruneReceiptV1;
    const operation = pruneOperation(plan);
    if (!prefixMatches(observation.unitId, plan)) {
      return unavailable(namespace, observation, "prune unit prefix contradicts authenticated operation", "unit-unavailable", operation);
    }
    if (!inventoryClosed(observation, plan, names.completed, names.planned)) {
      return unavailable(namespace, observation, "prune unit contains unknown durable content", "unit-unavailable", operation);
    }
    const completed = await observeBoundLifecycleReceipt(
      namespace, names.paths.completedReceiptFile, observation.unitRoot,
      observation.unitId, "prune-completed", key, bounds,
    );
    if (completed !== "absent" && !lifecycleReceiptPairMatches(planned, completed)) {
      return unavailable(namespace, observation, "prune receipt pair does not bind exactly", "unit-unavailable", operation);
    }
    const state = await prunePostcondition(
      namespace,
      observation.unitRoot,
      plan,
      completed !== "absent",
      bounds,
    );
    return result(observation, operation, state);
  } catch (error) {
    const code = error instanceof LifecycleReceiptReadError ||
      error instanceof LifecyclePostconditionError ? error.code : "unit-unavailable";
    return unavailable(namespace, observation, (error as Error).message, code);
  }
}
