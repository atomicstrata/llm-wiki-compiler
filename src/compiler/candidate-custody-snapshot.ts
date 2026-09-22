/**
 * @file src/compiler/candidate-custody-snapshot.ts
 * @description Closed deep snapshots for candidate custody identities,
 * receipts, receipt batches, and move requests. Direct adapter callers cannot
 * alter recovery authority after a boundary accepts it.
 */

import { assertCandidateId } from "./candidate-paths.js";
import { candidateByteLimit, type CandidateCustodyPolicy } from "./candidate-custody-limits.js";
import {
  captureDenseArray,
  captureExactRecord,
  RuntimeCaptureError,
} from "../utils/runtime-capture.js";
import type {
  CandidateCustodyMoveDirection,
  CandidateCustodyMoveRequest,
  CandidateCustodyReceipt,
  CandidateFileIdentity,
} from "./candidate-custody.js";

/** Typed refusal for a malformed or mutable candidate-custody boundary. */
export class CandidateCustodyBoundaryError extends Error {
  constructor() {
    super("candidate custody boundary is invalid");
    this.name = "CandidateCustodyBoundaryError";
  }
}

/** Run one capture and translate all structural faults to the public type. */
function atBoundary<T>(capture: () => T): T {
  try {
    return capture();
  } catch (error) {
    if (error instanceof CandidateCustodyBoundaryError) throw error;
    if (error instanceof RuntimeCaptureError) throw new CandidateCustodyBoundaryError();
    throw new CandidateCustodyBoundaryError();
  }
}

/** Capture one non-negative filesystem identity component. */
function identityNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new CandidateCustodyBoundaryError();
  }
  return value;
}

/** Capture one exact deeply frozen filesystem identity. */
function captureCandidateFileIdentity(value: unknown): CandidateFileIdentity {
  return atBoundary(() => {
    const record = captureExactRecord(value, ["dev", "ino"]);
    return Object.freeze({
      dev: identityNumber(record.dev),
      ino: identityNumber(record.ino),
    });
  });
}

/** Capture one exact deeply frozen custody receipt. */
export function captureCandidateCustodyReceipt(
  value: unknown, policy: CandidateCustodyPolicy = "bounded",
): CandidateCustodyReceipt {
  return atBoundary(() => {
    const record = captureExactRecord(value, [
      "fileId", "byteCount", "sha256", "fileIdentity", "storeIdentity",
    ]);
    if (typeof record.fileId !== "string") throw new CandidateCustodyBoundaryError();
    assertCandidateId(record.fileId);
    if (typeof record.byteCount !== "number" || !Number.isSafeInteger(record.byteCount) ||
      record.byteCount < 0 || record.byteCount > candidateByteLimit(policy)) {
      throw new CandidateCustodyBoundaryError();
    }
    if (typeof record.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.sha256)) {
      throw new CandidateCustodyBoundaryError();
    }
    return Object.freeze({
      fileId: record.fileId,
      byteCount: record.byteCount,
      sha256: record.sha256,
      fileIdentity: captureCandidateFileIdentity(record.fileIdentity),
      storeIdentity: captureCandidateFileIdentity(record.storeIdentity),
    });
  });
}

/** Capture a dense frozen receipt list before any batch effect. */
export function captureCandidateCustodyReceipts(
  value: unknown,
  maximum = 200,
  overflowError: () => Error = () => new CandidateCustodyBoundaryError(),
  policy: CandidateCustodyPolicy = "bounded",
): readonly CandidateCustodyReceipt[] {
  let overflow: Error | undefined;
  try {
    return captureDenseArray(
      value,
      maximum,
      (item) => captureCandidateCustodyReceipt(item, policy),
      () => {
        overflow = overflowError();
        return overflow;
      },
    );
  } catch (error) {
    if (error === overflow) throw error;
    if (error instanceof CandidateCustodyBoundaryError) throw error;
    throw new CandidateCustodyBoundaryError();
  }
}

/** Capture one exact direction token. */
function captureDirection(value: unknown): CandidateCustodyMoveDirection {
  if (value !== "archive" && value !== "restore") throw new CandidateCustodyBoundaryError();
  return value;
}

/** Capture one exact deeply frozen candidate move request. */
export function captureCandidateCustodyMoveRequest(
  value: unknown, policy: CandidateCustodyPolicy = "bounded",
): CandidateCustodyMoveRequest {
  return atBoundary(() => {
    const record = captureExactRecord(value, ["root", "fileId", "direction", "receipt"]);
    if (typeof record.root !== "string" || typeof record.fileId !== "string") {
      throw new CandidateCustodyBoundaryError();
    }
    assertCandidateId(record.fileId);
    const receipt = captureCandidateCustodyReceipt(record.receipt, policy);
    if (receipt.fileId !== record.fileId) throw new CandidateCustodyBoundaryError();
    return Object.freeze({
      root: record.root,
      fileId: record.fileId,
      direction: captureDirection(record.direction),
      receipt,
    });
  });
}
