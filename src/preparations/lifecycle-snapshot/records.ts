/**
 * @file src/preparations/lifecycle-snapshot/records.ts
 * @description Closed receipt grammar, bounded handle-bound reads, current-key
 * authentication, and exact planned/completed pair binding for the lifecycle
 * snapshot. A parsed record is never authority until all checks succeed.
 */

import { createHash } from "node:crypto";
import { canonicalDigest } from "../../profile/templates/signing/canonical.js";
import { isSafeRelativeEvidencePath } from "../../utils/evidence-path.js";
import { isSafeQuarantineComponent } from "../paths.js";
import {
  parseLifecycleReceipt,
  verifyLifecycleReceipt,
  type PruneReceiptV1,
  type QuarantineReceiptV1,
} from "../receipts.js";
import { canonicalTime } from "../run-parse-helpers.js";
import type { PreparationLifecycleNamespaceV1 } from "../lifecycle-fs/types.js";
import {
  LifecycleObservationError,
  readLifecycleLeaf,
} from "../lifecycle-fs/leaf-observation.js";
import type { CapturedLifecycleKey } from "../lifecycle-fs/key-observation.js";
import type { LifecycleScanBounds } from "../lifecycle-fs/bounds.js";

const SHA256_HEX = /^[0-9a-f]{64}$/;
const SHA256_ID = /^sha256:[0-9a-f]{64}$/;
const MAX_TEXT_BYTES = 1024;

/** One closed candidate, with current-epoch authentication kept separate. */
export interface LifecycleReceiptObservation {
  readonly receipt: QuarantineReceiptV1 | PruneReceiptV1;
  readonly bytes: Buffer;
  readonly digest: string;
  readonly authenticated: boolean;
}

/** Typed receipt read refusal used to construct a stable scan problem. */
export class LifecycleReceiptReadError extends Error {
  constructor(
    readonly code: "receipt-bytes-exhausted" | "unit-unavailable",
    message: string,
  ) {
    super(message);
    this.name = "LifecycleReceiptReadError";
  }
}

/** Exact own-key check, including optional fields selected by the writer. */
function exactKeys(record: Record<string, unknown>, required: readonly string[], optional: readonly string[]): boolean {
  const permitted = new Set([...required, ...optional]);
  const keys = Object.keys(record);
  return required.every((key) => keys.includes(key)) &&
    keys.every((key) => permitted.has(key));
}

/** Bounded nonempty text for audit identities and residual descriptions. */
function boundedText(value: unknown): value is string {
  return typeof value === "string" && value !== "" &&
    Buffer.byteLength(value, "utf8") <= MAX_TEXT_BYTES;
}

/** Exact actor shape shared by both receipt families. */
function validActor(value: unknown): boolean {
  if (!plainRecord(value)) return false;
  return exactKeys(value, ["id", "surface"], []) &&
    boundedText(value.id) && boundedText(value.surface);
}

/** Canonical timestamp under the same parser used by preparation runs. */
function validTime(value: unknown): boolean {
  try {
    canonicalTime(value, "lifecycle receipt timestamp");
    return true;
  } catch {
    return false;
  }
}

/** Plain object record, excluding arrays and null. */
function plainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Portable project-private logical path, never absolute or parent-traversing. */
function validLogicalPath(value: unknown): value is string {
  return typeof value === "string" && isSafeRelativeEvidencePath(value);
}

/** One exact planned object common to both receipt families. */
function validObjectBase(value: unknown): value is Record<string, unknown> {
  if (!plainRecord(value)) return false;
  return validLogicalPath(value.logicalPath) &&
    Number.isSafeInteger(value.byteCount) && (value.byteCount as number) >= 0 &&
    (value.digest === null || (typeof value.digest === "string" && SHA256_HEX.test(value.digest)));
}

/** Closed quarantine object grammar including its portable custody name. */
function validQuarantineObject(value: unknown): boolean {
  return validObjectBase(value) &&
    exactKeys(value, ["logicalPath", "objectName", "byteCount", "digest"], []) &&
    isSafeQuarantineComponent(value.objectName);
}

/** Closed prune object grammar. */
function validPruneObject(value: unknown): boolean {
  return validObjectBase(value) &&
    exactKeys(value, ["logicalPath", "byteCount", "digest"], []);
}

/** Require an array whose selected identity fields are unique. */
function validUniqueObjects(
  value: unknown,
  accepts: (entry: unknown) => boolean,
  identity: (entry: Record<string, unknown>) => string,
): boolean {
  if (!Array.isArray(value) || !value.every(accepts)) return false;
  const ids = value.map((entry) => identity(entry as Record<string, unknown>));
  return new Set(ids).size === ids.length;
}

/** Quarantine plans bind unique source identities and unique custody slots. */
function validQuarantineObjects(value: unknown): boolean {
  if (!Array.isArray(value) || !value.every(validQuarantineObject)) return false;
  const logicalPaths = value.map((entry) => (entry as QuarantineObjectShape).logicalPath);
  const objectNames = value.map((entry) => (entry as QuarantineObjectShape).objectName);
  return new Set(logicalPaths).size === logicalPaths.length &&
    new Set(objectNames).size === objectNames.length;
}

/** Narrow closed shape already established by validQuarantineObject. */
interface QuarantineObjectShape {
  logicalPath: string;
  objectName: string;
}

/** Closed retirement-attestation entry grammar. */
function validRetiredUnits(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  const ids = new Set<string>();
  for (const entry of value) {
    if (!plainRecord(entry) || !exactKeys(entry, ["unitId", "receiptDigest"], []) ||
        !isSafeQuarantineComponent(entry.unitId) ||
        typeof entry.receiptDigest !== "string" || !SHA256_HEX.test(entry.receiptDigest) ||
        ids.has(String(entry.unitId))) return false;
    ids.add(String(entry.unitId));
  }
  return true;
}

/** Shared receipt identity fields. */
function validReceiptIdentity(record: Record<string, unknown>): boolean {
  return record.schemaVersion === 1 && isSafeQuarantineComponent(record.unitId);
}

/** Shared receipt integrity fields. */
function validReceiptIntegrity(record: Record<string, unknown>): boolean {
  return typeof record.keyEpochId === "string" &&
    SHA256_ID.test(record.keyEpochId) &&
    typeof record.integrity === "string" &&
    SHA256_HEX.test(record.integrity);
}

/** Shared signed receipt fields that every family must carry exactly. */
function validCommon(record: Record<string, unknown>): boolean {
  const runValid = record.runId === undefined || boundedText(record.runId);
  return validReceiptIdentity(record) &&
    validReceiptIntegrity(record) &&
    validActor(record.actor) &&
    validTime(record.at) &&
    runValid;
}

/** Cross-field scope/reason rule for quarantine receipt authority. */
function validQuarantineScope(record: Record<string, unknown>): boolean {
  if (record.scope !== "per-run" && record.scope !== "project-reset") return false;
  const knownReason = record.reason === "run-integrity-invalid" ||
    record.reason === "missing-key" ||
    record.reason === "unreadable-key-forced";
  if (!knownReason) return false;
  return record.scope === "per-run"
    ? record.reason === "run-integrity-invalid" && boundedText(record.runId)
    : record.reason !== "run-integrity-invalid" && record.runId === undefined;
}

/** Closed arrays carried by a quarantine receipt. */
function validQuarantineCollections(record: Record<string, unknown>): boolean {
  const residualsValid = Array.isArray(record.residualObligations) &&
    record.residualObligations.every(boundedText);
  const retirementValid = record.retiredUnits === undefined ||
    (record.scope === "project-reset" && validRetiredUnits(record.retiredUnits));
  return validQuarantineObjects(record.objects) && residualsValid && retirementValid;
}

/** Closed quarantine/reset receipt grammar and cross-field rules. */
function validQuarantineReceipt(record: Record<string, unknown>): boolean {
  const required = [
    "schemaVersion", "kind", "scope", "reason", "unitId", "keyEpochId",
    "objects", "residualObligations", "actor", "at", "integrity",
  ];
  if (!exactKeys(record, required, ["runId", "retiredUnits"]) || !validCommon(record)) return false;
  if (record.kind !== "quarantine-planned" && record.kind !== "quarantine-completed") return false;
  return validQuarantineScope(record) && validQuarantineCollections(record);
}

/** Closed prune/sweep receipt grammar and cross-field rules. */
function validPruneReceipt(record: Record<string, unknown>): boolean {
  const required = [
    "schemaVersion", "kind", "operation", "unitId", "keyEpochId",
    "objects", "actor", "at", "integrity",
  ];
  if (!exactKeys(record, required, ["runId"]) || !validCommon(record)) return false;
  if (record.kind !== "prune-planned" && record.kind !== "prune-completed") return false;
  if (record.operation !== "prune" && record.operation !== "sweep") return false;
  if (record.operation === "prune"
    ? !boundedText(record.runId)
    : record.runId !== undefined) return false;
  return validUniqueObjects(record.objects, validPruneObject,
    (entry) => String(entry.logicalPath));
}

/** Parse one candidate only when the complete family grammar is closed. */
function parseClosedReceipt(body: Buffer): QuarantineReceiptV1 | PruneReceiptV1 {
  const parsed = parseLifecycleReceipt(body.toString("utf8"));
  const record = parsed as unknown as Record<string, unknown>;
  const valid = String(record.kind).startsWith("quarantine-")
    ? validQuarantineReceipt(record)
    : validPruneReceipt(record);
  if (!valid) throw new Error("lifecycle receipt has an invalid closed shape");
  return parsed;
}

/** Read one exact receipt leaf and authenticate it against the captured key. */
async function observeLifecycleReceipt(
  namespace: PreparationLifecycleNamespaceV1,
  file: string,
  unitRoot: string,
  key: CapturedLifecycleKey,
  bounds: LifecycleScanBounds,
): Promise<LifecycleReceiptObservation | "absent"> {
  let read;
  try {
    read = await readLifecycleLeaf({
      root: namespace.root.realPath,
      file,
      expectedDir: unitRoot,
      maxBytes: bounds.maxReceiptBytes,
    });
  } catch (error) {
    const code = error instanceof LifecycleObservationError
      ? error.code
      : "unit-unavailable";
    throw new LifecycleReceiptReadError(code === "receipt-bytes-exhausted"
      ? code
      : "unit-unavailable", (error as Error).message);
  }
  if (read.status === "absent") return "absent";
  try {
    const receipt = parseClosedReceipt(read.body);
    const authenticated = key.status === "ok" &&
      receipt.keyEpochId === key.keyEpochId &&
      verifyLifecycleReceipt(key.key, receipt);
    return {
      receipt,
      bytes: Buffer.from(read.body),
      digest: createHash("sha256").update(read.body).digest("hex"),
      authenticated,
    };
  } catch (error) {
    throw new LifecycleReceiptReadError(
      "unit-unavailable",
      `lifecycle receipt cannot be trusted: ${(error as Error).message}`,
    );
  }
}

/** Read one receipt and require its expected family kind and containing unit. */
export async function observeBoundLifecycleReceipt(
  namespace: PreparationLifecycleNamespaceV1,
  file: string,
  unitRoot: string,
  unitId: string,
  kind: QuarantineReceiptV1["kind"] | PruneReceiptV1["kind"],
  key: CapturedLifecycleKey,
  bounds: LifecycleScanBounds,
): Promise<LifecycleReceiptObservation | "absent"> {
  const candidate = await observeLifecycleReceipt(
    namespace, file, unitRoot, key, bounds,
  );
  if (candidate === "absent") return candidate;
  if (candidate.receipt.kind !== kind || candidate.receipt.unitId !== unitId) {
    throw new LifecycleReceiptReadError(
      "unit-unavailable",
      "lifecycle receipt does not bind its containing unit and kind",
    );
  }
  return candidate;
}

/** Exact authority content shared by a planned/completed receipt pair. */
function pairDigest(receipt: QuarantineReceiptV1 | PruneReceiptV1): string {
  const { kind: _kind, integrity: _integrity, ...content } = receipt;
  return canonicalDigest({
    domain: "llmwiki.preparation-lifecycle.receipt-pair.v1",
    content,
  });
}

/** True only when two authenticated receipts bind the same operation authority. */
export function lifecycleReceiptPairMatches(
  planned: LifecycleReceiptObservation,
  completed: LifecycleReceiptObservation,
): boolean {
  return planned.authenticated && completed.authenticated &&
    pairDigest(planned.receipt) === pairDigest(completed.receipt);
}
