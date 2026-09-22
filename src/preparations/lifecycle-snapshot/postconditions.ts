/**
 * @file src/preparations/lifecycle-snapshot/postconditions.ts
 * @description Bounded current-state verification for quarantine custody and
 * prune/sweep deletion postconditions. Every present object is streamed through
 * the repository's handle-bound planned-byte verifier.
 */

import path from "node:path";
import { lifecycleStagedDeleteName } from "../paths.js";
import type {
  PruneReceiptV1,
  QuarantineObjectV1,
  QuarantineReceiptV1,
} from "../receipts.js";
import type { PreparationLifecycleNamespaceV1 } from "../lifecycle-fs/types.js";
import type { LifecycleScanBounds } from "../lifecycle-fs/bounds.js";
import {
  LifecycleObservationError,
  observeLifecyclePlannedLeaf,
  type LifecyclePlannedLeafState,
} from "../lifecycle-fs/leaf-observation.js";
import type { CompletedCustodyStateV1 } from "./types.js";

/** Typed postcondition refusal with a stable scan problem category. */
export class LifecyclePostconditionError extends Error {
  constructor(
    readonly code:
      | "object-bytes-exhausted"
      | "postcondition-bytes-exhausted"
      | "unit-unavailable",
    message: string,
  ) {
    super(message);
    this.name = "LifecyclePostconditionError";
  }
}

type ObjectState = LifecyclePlannedLeafState;

/** Observe one absent or exact planned object without following a leaf symlink. */
async function observeObject(input: {
  namespace: PreparationLifecycleNamespaceV1;
  file: string;
  expectedDir: string;
  object: { logicalPath: string; byteCount: number; digest: string | null };
  label: string;
  bounds: LifecycleScanBounds;
}): Promise<ObjectState> {
  try {
    return await observeLifecyclePlannedLeaf({
      root: input.namespace.root.realPath,
      file: input.file,
      expectedDir: input.expectedDir,
      object: input.object,
      label: input.label,
      bounds: input.bounds,
    });
  } catch (error) {
    if (error instanceof LifecyclePostconditionError) throw error;
    const observedCode = error instanceof LifecycleObservationError
      ? error.code
      : "unit-unavailable";
    const code = observedCode === "receipt-bytes-exhausted"
      ? "unit-unavailable"
      : observedCode;
    throw new LifecyclePostconditionError(
      code,
      (error as Error).message,
    );
  }
}

/** Observe one quarantine object's source and custody destination. */
async function quarantineEnds(
  namespace: PreparationLifecycleNamespaceV1,
  bytesRoot: string,
  object: QuarantineObjectV1,
  bounds: LifecycleScanBounds,
): Promise<{ source: ObjectState; destination: ObjectState }> {
  const source = path.join(namespace.root.realPath, ".llmwiki", object.logicalPath);
  const destination = path.join(bytesRoot, object.objectName);
  return {
    source: await observeObject({
      namespace,
      file: source,
      expectedDir: path.dirname(source),
      object,
      label: "quarantine source",
      bounds,
    }),
    destination: await observeObject({
      namespace,
      file: destination,
      expectedDir: bytesRoot,
      object,
      label: "quarantine destination",
      bounds,
    }),
  };
}

/** Current retention of a receipt whose writer already committed completion. */
export async function quarantineCompletedCustody(
  namespace: PreparationLifecycleNamespaceV1,
  bytesRoot: string,
  receipt: QuarantineReceiptV1,
  bounds: LifecycleScanBounds,
): Promise<CompletedCustodyStateV1> {
  const states: ObjectState[] = [];
  for (const object of receipt.objects) {
    const destination = path.join(bytesRoot, object.objectName);
    states.push(await observeObject({
      namespace,
      file: destination,
      expectedDir: bytesRoot,
      object,
      label: "completed quarantine destination",
      bounds,
    }));
  }
  if (states.every((state) => state.status === "present")) return "verified-retained";
  if (states.every((state) => state.status === "absent")) return "absent-unproven";
  throw new LifecyclePostconditionError(
    "unit-unavailable",
    "completed quarantine custody is only partially retained",
  );
}

/** Whether an authenticated incomplete quarantine plan is untouched or applying. */
export async function quarantineProgress(
  namespace: PreparationLifecycleNamespaceV1,
  bytesRoot: string,
  receipt: QuarantineReceiptV1,
  bounds: LifecycleScanBounds,
): Promise<"planned" | "applying"> {
  let changed = false;
  for (const object of receipt.objects) {
    const ends = await quarantineEnds(namespace, bytesRoot, object, bounds);
    if (ends.source.status === "present" && ends.destination.status === "absent") continue;
    if (ends.source.status === "absent" && ends.destination.status === "present") {
      changed = true;
      continue;
    }
    if (ends.source.status === "present" && ends.destination.status === "present" &&
        ends.source.dev === ends.destination.dev && ends.source.ino === ends.destination.ino) {
      changed = true;
      continue;
    }
    throw new LifecyclePostconditionError(
      "unit-unavailable",
      "quarantine object is not at one valid protocol position",
    );
  }
  return changed ? "applying" : "planned";
}


/** Observe one prune object's source and durable staging slot. */
async function pruneEnds(
  namespace: PreparationLifecycleNamespaceV1,
  unitRoot: string,
  object: PruneReceiptV1["objects"][number],
  index: number,
  bounds: LifecycleScanBounds,
): Promise<{ source: ObjectState; staged: ObjectState }> {
  const source = path.join(namespace.root.realPath, ".llmwiki", object.logicalPath);
  const staged = path.join(unitRoot, lifecycleStagedDeleteName(index));
  return {
    source: await observeObject({
      namespace,
      file: source,
      expectedDir: path.dirname(source),
      object,
      label: "prune source",
      bounds,
    }),
    staged: await observeObject({
      namespace,
      file: staged,
      expectedDir: unitRoot,
      object,
      label: "prune staged object",
      bounds,
    }),
  };
}

/** Verify terminal absence, or classify a valid incomplete delete protocol. */
export async function prunePostcondition(
  namespace: PreparationLifecycleNamespaceV1,
  unitRoot: string,
  receipt: PruneReceiptV1,
  completed: boolean,
  bounds: LifecycleScanBounds,
): Promise<"planned" | "applying" | "completed"> {
  let changed = false;
  for (const [index, object] of receipt.objects.entries()) {
    const ends = await pruneEnds(namespace, unitRoot, object, index, bounds);
    changed = classifyPruneEnds(ends, completed) || changed;
  }
  return completed ? "completed" : changed ? "applying" : "planned";
}

/** Validate one planned object's source/staging position. */
function classifyPruneEnds(
  ends: { source: ObjectState; staged: ObjectState },
  completed: boolean,
): boolean {
  if (completed) {
    if (bothAbsent(ends)) return false;
    throw new LifecyclePostconditionError(
      "unit-unavailable",
      "completed prune object is still present",
    );
  }
  if (ends.source.status === "present" && ends.staged.status === "absent") return false;
  if (ends.source.status === "absent") return true;
  if (samePresentObject(ends)) return true;
  throw new LifecyclePostconditionError(
    "unit-unavailable",
    "prune object is not at one valid protocol position",
  );
}

/** Whether both delete-protocol names are provably absent. */
function bothAbsent(ends: { source: ObjectState; staged: ObjectState }): boolean {
  return ends.source.status === "absent" && ends.staged.status === "absent";
}

/** Whether both names are hard links to the same verified object. */
function samePresentObject(
  ends: { source: ObjectState; staged: ObjectState },
): boolean {
  return ends.source.status === "present" &&
    ends.staged.status === "present" &&
    ends.source.dev === ends.staged.dev &&
    ends.source.ino === ends.staged.ino;
}
