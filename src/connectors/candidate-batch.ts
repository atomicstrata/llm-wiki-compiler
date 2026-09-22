/**
 * @file src/connectors/candidate-batch.ts
 * @description Closed runtime capture for connector candidate identities and
 * public results. Every effect receives a dense frozen snapshot read through
 * own data descriptors, never through caller iterators or collection methods.
 */

import { assertCandidateId } from "../compiler/candidate-paths.js";
import type { CandidateCustodyPolicy } from "../compiler/candidate-custody-limits.js";
import {
  captureDenseArray,
  captureOwnDataRecord,
  RuntimeCaptureError,
} from "../utils/runtime-capture.js";
import { isWellFormedUnicode } from "../utils/well-formed-unicode.js";

/** Maximum exact candidate identities carried by one connector batch. */
export const MAX_CONNECTOR_CANDIDATE_BATCH = 200;

/** Existing local runs have no new selected-batch cap; direct ports stay bounded. */
export function connectorCandidateBatchLimit(policy: CandidateCustodyPolicy): number {
  return policy === "public" ? Number.MAX_SAFE_INTEGER : MAX_CONNECTOR_CANDIDATE_BATCH;
}

/** Maximum code units and UTF-8 bytes in one public connector reason. */
const MAX_CONNECTOR_RESULT_REASON_BYTES = 512;

/** Fixed normal-run result used when bounded selection reaches entry 201. */
const CONNECTOR_CANDIDATE_BATCH_UNAVAILABLE =
  "connector candidate batch exceeds 200 entries";

/** Typed, nonreflecting refusal for a direct over-limit adapter call. */
export class ConnectorCandidateBatchOverflowError extends Error {
  constructor() {
    super(CONNECTOR_CANDIDATE_BATCH_UNAVAILABLE);
    this.name = "ConnectorCandidateBatchOverflowError";
  }
}

/** Typed, nonreflecting refusal for malformed candidate result identities. */
class ConnectorCandidateBoundaryError extends Error {
  constructor() {
    super("connector candidate identity boundary is invalid");
    this.name = "ConnectorCandidateBoundaryError";
  }
}

/** A closed immutable result snapshot safe for SDK and terminal effects. */
export type ConnectorResultSnapshot =
  | Readonly<{ kind: "staged"; candidateIds: readonly string[] }>
  | Readonly<{ kind: "noop"; candidateIds: readonly string[] }>
  | Readonly<{ kind: "superseded"; archivedIds: readonly string[]; candidateIds: readonly string[] }>
  | Readonly<{ kind: "recovery-required"; candidateIds: readonly string[] }>
  | Readonly<{ kind: "refused"; reason: string }>
  | Readonly<{ kind: "unavailable"; reason: string }>;

/** Reject entry 201 without truncating or reflecting the supplied list. */
export function assertConnectorCandidateBatchCount(values: readonly unknown[]): void {
  if (values.length > MAX_CONNECTOR_CANDIDATE_BATCH) {
    throw new ConnectorCandidateBatchOverflowError();
  }
}

/** Capture and validate one exact candidate identity. */
function captureCandidateId(value: unknown): string {
  if (typeof value !== "string") throw new ConnectorCandidateBoundaryError();
  try {
    assertCandidateId(value);
    return value;
  } catch {
    throw new ConnectorCandidateBoundaryError();
  }
}

/** Capture one exact nonempty bounded reason before it reaches SDK or CLI output. */
export function captureConnectorReason(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 ||
      value.length > MAX_CONNECTOR_RESULT_REASON_BYTES) {
    throw new ConnectorCandidateBoundaryError();
  }
  if (!isWellFormedUnicode(value) ||
      Buffer.byteLength(value, "utf8") > MAX_CONNECTOR_RESULT_REASON_BYTES) {
    throw new ConnectorCandidateBoundaryError();
  }
  return value;
}

/** Capture one bounded dense exact candidate-ID list. */
export function captureConnectorCandidateIds(
  value: unknown, policy: CandidateCustodyPolicy = "bounded",
): readonly string[] {
  try {
    return captureDenseArray(
      value,
      connectorCandidateBatchLimit(policy),
      captureCandidateId,
      () => new ConnectorCandidateBatchOverflowError(),
    );
  } catch (error) {
    if (error instanceof ConnectorCandidateBatchOverflowError ||
      error instanceof ConnectorCandidateBoundaryError) throw error;
    if (error instanceof RuntimeCaptureError) throw new ConnectorCandidateBoundaryError();
    throw error;
  }
}

/** Require one exact set of fields after the record has been captured once. */
function assertExactKeys(
  record: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): void {
  const keys = Object.keys(record);
  const allowed = new Set(expected);
  if (keys.length !== expected.length || keys.some((key) => !allowed.has(key))) {
    throw new ConnectorCandidateBoundaryError();
  }
}

/** Capture a success result with one candidate list. */
function captureSimpleResult(
  record: Readonly<Record<string, unknown>>,
  kind: "staged" | "noop" | "recovery-required",
  policy: CandidateCustodyPolicy,
): ConnectorResultSnapshot {
  assertExactKeys(record, ["kind", "candidateIds"]);
  return Object.freeze({ kind, candidateIds: captureConnectorCandidateIds(record.candidateIds, policy) });
}

/** Capture any public connector result into a closed immutable DTO. */
export function captureConnectorResult(
  value: unknown, policy: CandidateCustodyPolicy = "bounded",
): ConnectorResultSnapshot {
  let record: Readonly<Record<string, unknown>>;
  try {
    record = captureOwnDataRecord(value);
  } catch {
    throw new ConnectorCandidateBoundaryError();
  }
  const kind = record.kind;
  if (kind === "staged" || kind === "noop" || kind === "recovery-required") {
    return captureSimpleResult(record, kind, policy);
  }
  if (kind === "superseded") {
    assertExactKeys(record, ["kind", "archivedIds", "candidateIds"]);
    return Object.freeze({
      kind,
      archivedIds: captureConnectorCandidateIds(record.archivedIds, policy),
      candidateIds: captureConnectorCandidateIds(record.candidateIds, policy),
    });
  }
  if (kind === "refused" || kind === "unavailable") {
    assertExactKeys(record, ["kind", "reason"]);
    return Object.freeze({ kind, reason: captureConnectorReason(record.reason) });
  }
  throw new ConnectorCandidateBoundaryError();
}
