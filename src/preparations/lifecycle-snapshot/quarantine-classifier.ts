/**
 * @file src/preparations/lifecycle-snapshot/quarantine-classifier.ts
 * @description Pass-one quarantine/reset classification from one closed unit
 * observation. Only current-key-authenticated records can settle active work;
 * old receipts remain candidates for pass-two retirement reconciliation.
 */

import path from "node:path";
import {
  decodePreparationKey,
} from "../key-epoch.js";
import { preparationKeyEpochId } from "../run-integrity.js";
import {
  parsePendingResetKey,
  parseResetIntent,
  type QuarantineReceiptV1,
} from "../receipts.js";
import type { PreparationLifecycleNamespaceV1 } from "../lifecycle-fs/types.js";
import {
  type LifecycleUnitObservation,
} from "../lifecycle-fs/observe.js";
import {
  lifecycleRegularLeaf,
  readLifecycleLeaf,
} from "../lifecycle-fs/leaf-observation.js";
import {
  lifecycleQuarantineUnitPaths,
} from "../lifecycle-fs/paths.js";
import type { CapturedLifecycleKey } from "../lifecycle-fs/key-observation.js";
import type { LifecycleScanBounds } from "../lifecycle-fs/bounds.js";
import {
  LifecycleReceiptReadError,
  lifecycleReceiptPairMatches,
  observeBoundLifecycleReceipt,
  type LifecycleReceiptObservation,
} from "./records.js";
import {
  LifecyclePostconditionError,
  quarantineCompletedCustody,
  quarantineProgress,
} from "./postconditions.js";
import {
  lifecycleObservationDisposition,
  type LifecyclePassOneUnit,
} from "./classifier-types.js";
import type {
  PreparationLifecycleProblemV1,
  PreparationLifecycleUnitV1,
} from "./types.js";
import { lifecycleRelativePath } from "../lifecycle-fs/observe.js";

/** Fixed unit-root filenames selected by the path schema. */
function quarantineNames(
  namespace: PreparationLifecycleNamespaceV1,
  unitId: string,
) {
  const paths = lifecycleQuarantineUnitPaths(namespace, unitId);
  return {
    paths,
    planned: path.basename(paths.plannedReceiptFile),
    completed: path.basename(paths.completedReceiptFile),
    intent: path.basename(paths.resetIntentFile),
    pendingKey: path.basename(paths.pendingResetKeyFile),
    bytes: path.basename(paths.bytesRoot),
  };
}

/** One stable unit-level refusal. */
function unavailable(
  namespace: PreparationLifecycleNamespaceV1,
  observation: LifecycleUnitObservation,
  detail: string,
  code: PreparationLifecycleProblemV1["code"] = "unit-unavailable",
  operation: PreparationLifecycleUnitV1["operation"] = null,
  historicalCandidateDigest?: string,
): LifecyclePassOneUnit {
  return {
    unit: {
      registry: "quarantine",
      unitId: observation.unitId,
      operation,
      state: "unavailable",
    },
    problem: {
      code,
      registry: "quarantine",
      unitId: observation.unitId,
      path: lifecycleRelativePath(namespace.root.realPath, observation.unitRoot),
      detail,
    },
    retirementEvidence: [],
    ...(historicalCandidateDigest === undefined ? {} : { historicalCandidateDigest }),
    ...(historicalCandidateDigest === undefined || operation === null
      ? {}
      : { historicalCandidateOperation: operation }),
  };
}

/** Verify the closed unsigned pre-plan reset grammar. */
async function prePlanReset(
  namespace: PreparationLifecycleNamespaceV1,
  observation: LifecycleUnitObservation,
  bounds: LifecycleScanBounds,
): Promise<boolean> {
  const { paths, intent, pendingKey, bytes } = quarantineNames(
    namespace, observation.unitId,
  );
  const rootNames = observation.directory?.names ?? [];
  if (!rootNames.includes(intent) ||
      rootNames.some((name) => ![intent, pendingKey, bytes].includes(name))) return false;
  const read = await readLifecycleLeaf({
    root: namespace.root.realPath,
    file: paths.resetIntentFile,
    expectedDir: observation.unitRoot,
    maxBytes: bounds.maxReceiptBytes,
  });
  if (read.status !== "ok") return false;
  const parsed = parseResetIntent(read.body.toString("utf8"));
  if (parsed.unitId !== observation.unitId) return false;
  if (!(await validPendingKey(namespace, observation, bounds))) return false;
  return validPrePlanBytes(namespace, observation, parsed.reason);
}

/** Validate optional pending reset key syntax without authorizing it. */
async function validPendingKey(
  namespace: PreparationLifecycleNamespaceV1,
  observation: LifecycleUnitObservation,
  bounds: LifecycleScanBounds,
): Promise<boolean> {
  const names = quarantineNames(namespace, observation.unitId);
  if (!observation.directory?.names.includes(names.pendingKey)) return true;
  const read = await readLifecycleLeaf({
    root: namespace.root.realPath,
    file: names.paths.pendingResetKeyFile,
    expectedDir: observation.unitRoot,
    maxBytes: bounds.maxReceiptBytes,
  });
  if (read.status !== "ok") return false;
  const pending = parsePendingResetKey(read.body.toString("utf8"));
  return pendingResetKeyShapeValid(pending, observation.unitId);
}

/** Closed syntax and self-binding for an unauthenticated pending reset key. */
function pendingResetKeyShapeValid(
  pending: ReturnType<typeof parsePendingResetKey>,
  unitId: string,
): boolean {
  const keys = Object.keys(pending).sort();
  const expected = [
    "integrity", "key", "keyEpochId", "kind", "schemaVersion", "unitId",
  ].sort();
  const decoded = decodePreparationKey(pending.key);
  const exactKeys = keys.length === expected.length &&
    keys.every((key, index) => key === expected[index]) &&
    pending.unitId === unitId;
  const canonicalKey = decoded !== null &&
    pending.keyEpochId === preparationKeyEpochId(decoded);
  return exactKeys && canonicalKey && /^[0-9a-f]{64}$/u.test(pending.integrity);
}

/** Accept empty bytes scaffolding and only the forced flow's old-key leaf. */
async function validPrePlanBytes(
  namespace: PreparationLifecycleNamespaceV1,
  observation: LifecycleUnitObservation,
  reason: "missing-key" | "unreadable-key-forced",
): Promise<boolean> {
  if (observation.bytes === undefined || "status" in observation.bytes) return true;
  if (observation.bytes.names.length === 0) return true;
  if (reason !== "unreadable-key-forced" ||
      observation.bytes.names.length !== 1 ||
      observation.bytes.names[0] !== "old-key") return false;
  return lifecycleRegularLeaf(
    namespace.root.realPath,
    path.join(observation.bytes.path, "old-key"),
    observation.bytes.path,
  );
}

/** Operation projected from authenticated quarantine receipt content. */
function quarantineOperation(receipt: QuarantineReceiptV1) {
  return receipt.scope === "project-reset"
    ? "project-key-reset" as const
    : "per-run-quarantine" as const;
}

/** Whether unit-root and bytes entries are exactly those authorized by the plan. */
function planInventoryClosed(
  namespace: PreparationLifecycleNamespaceV1,
  observation: LifecycleUnitObservation,
  receipt: QuarantineReceiptV1,
): boolean {
  const names = quarantineNames(namespace, observation.unitId);
  const allowedRoot = new Set([names.planned, names.completed, names.bytes]);
  if (receipt.scope === "project-reset") {
    allowedRoot.add(names.intent);
    allowedRoot.add(names.pendingKey);
  }
  if ((observation.directory?.names ?? []).some((entry) => !allowedRoot.has(entry))) return false;
  if (observation.bytes === undefined || "status" in observation.bytes) return true;
  const allowedBytes = new Set(receipt.objects.map((object) => object.objectName));
  if (receipt.scope === "project-reset") allowedBytes.add("old-key");
  return observation.bytes.names.every((entry) => allowedBytes.has(entry));
}

/** Classify an authenticated planned quarantine/reset unit. */
async function classifyAuthenticatedPlan(input: {
  namespace: PreparationLifecycleNamespaceV1;
  observation: LifecycleUnitObservation;
  planned: LifecycleReceiptObservation;
  completed: LifecycleReceiptObservation | "absent";
  bounds: LifecycleScanBounds;
}): Promise<LifecyclePassOneUnit> {
  const plan = input.planned.receipt as QuarantineReceiptV1;
  const operation = quarantineOperation(plan);
  if (!planInventoryClosed(input.namespace, input.observation, plan)) {
    return unavailable(input.namespace, input.observation, "quarantine unit contains unknown durable content", "unit-unavailable", operation);
  }
  const bytesRoot = lifecycleQuarantineUnitPaths(
    input.namespace, input.observation.unitId,
  ).bytesRoot;
  if (input.completed === "absent") {
    const state = await quarantineProgress(
      input.namespace, bytesRoot, plan, input.bounds,
    );
    return activeResult(input.observation, operation, state);
  }
  if (!lifecycleReceiptPairMatches(input.planned, input.completed)) {
    return unavailable(input.namespace, input.observation, "quarantine receipt pair does not bind exactly", "unit-unavailable", operation);
  }
  const completion = input.completed.receipt as QuarantineReceiptV1;
  const custody = await quarantineCompletedCustody(
    input.namespace, bytesRoot, completion, input.bounds,
  );
  return {
    unit: {
      registry: "quarantine",
      unitId: input.observation.unitId,
      operation,
      state: "completed",
      custody,
    },
    retirementEvidence: operation === "project-key-reset"
      ? [...(completion.retiredUnits ?? [])]
      : [],
  };
}

/** One active nonterminal result with no problems or retirement evidence. */
function activeResult(
  observation: LifecycleUnitObservation,
  operation: PreparationLifecycleUnitV1["operation"],
  state: PreparationLifecycleUnitV1["state"],
): LifecyclePassOneUnit {
  return {
    unit: { registry: "quarantine", unitId: observation.unitId, operation, state },
    retirementEvidence: [],
  };
}

/** Classify one quarantine unit in pass one. */
async function classifyQuarantineRecords(
  namespace: PreparationLifecycleNamespaceV1,
  observation: LifecycleUnitObservation,
  key: CapturedLifecycleKey,
  bounds: LifecycleScanBounds,
): Promise<LifecyclePassOneUnit> {
  const names = quarantineNames(namespace, observation.unitId);
  const planned = await observeBoundLifecycleReceipt(
    namespace, names.paths.plannedReceiptFile, observation.unitRoot,
    observation.unitId, "quarantine-planned", key, bounds,
  );
  if (planned === "absent") {
    if (await prePlanReset(namespace, observation, bounds)) {
      return activeResult(observation, "project-key-reset", "awaiting-continuation");
    }
    return unavailable(namespace, observation, "nonempty quarantine unit has no authenticated plan");
  }
  const completed = await observeBoundLifecycleReceipt(
    namespace, names.paths.completedReceiptFile, observation.unitRoot,
    observation.unitId, "quarantine-completed", key, bounds,
  );
  if (!planned.authenticated) {
    const digest = completed === "absent" ? undefined : completed.digest;
    const operation = completed === "absent"
      ? null
      : quarantineOperation(completed.receipt as QuarantineReceiptV1);
    return unavailable(
      namespace, observation, "quarantine plan is not authenticated by the active key",
      "unit-unavailable", operation, digest,
    );
  }
  return classifyAuthenticatedPlan({
    namespace, observation, planned, completed, bounds,
  });
}

/** Closed input to the quarantine pass-one classifier. */
interface QuarantineClassifierInput {
  namespace: PreparationLifecycleNamespaceV1;
  observation: LifecycleUnitObservation;
  key: CapturedLifecycleKey;
  bounds: LifecycleScanBounds;
}

/** Classify one quarantine unit in pass one. */
export async function classifyQuarantinePassOne(
  input: QuarantineClassifierInput,
): Promise<LifecyclePassOneUnit> {
  const { namespace, observation, key, bounds } = input;
  const disposition = lifecycleObservationDisposition(observation);
  if (disposition.status === "unavailable") {
    return unavailable(namespace, observation, disposition.detail, disposition.code);
  }
  if (disposition.status === "inert") return activeResult(observation, null, "inert");
  try {
    return await classifyQuarantineRecords(namespace, observation, key, bounds);
  } catch (error) {
    const code = error instanceof LifecycleReceiptReadError ||
      error instanceof LifecyclePostconditionError ? error.code : "unit-unavailable";
    return unavailable(namespace, observation, (error as Error).message, code);
  }
}
