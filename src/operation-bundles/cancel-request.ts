/**
 * @file src/operation-bundles/cancel-request.ts
 * @description The `.cancel` advisory file — the sole lock-free write in the
 * operation runtime and never authoritative. It is a bounded (<=1 KiB), create-
 * only, confined record carrying a schema version, the exact run id, a bounded
 * requester label, and a timestamp. A forged, invalid, oversize, or symlinked
 * file is `unavailable` (never trusted): the run id inside must match the
 * path-derived run id, so a request can never name a different run. Only the lock
 * holder appends the signed cancellation transition and removes this file after
 * settlement; this module never changes authority.
 *
 * DELIVER-ONCE SEMANTICS (operator contract): a cancellation is delivered when the
 * executor observes this advisory between mutations and parks the run at
 * recovery-required; the lock holder then removes the advisory. It is therefore an
 * intent to STOP, not a durable veto — a single forward resume of the parked run
 * (which the operator explicitly initiates) COMPLETES the operation, because the
 * removed advisory is no longer read. An operator who wants the effects undone must
 * compensate the parked run rather than resume it; a resume does not re-honor a
 * consumed cancel.
 */

import { TextDecoder } from "node:util";
import { canonicalBytes } from "../profile/templates/signing/canonical.js";
import { parseBoundedUniqueJson } from "../profile/templates/signing/json.js";
import { readAdvisoryRecord, removeAdvisoryBestEffort, writeAdvisoryCreateOnly } from "../utils/advisory-file.js";
import { assertOperationRunId, type OperationRunId } from "./ids.js";
import { count, exact, record, textValue, timestamp } from "./manifest-values.js";
import { operationPaths } from "./paths.js";

const MAX_CANCEL_BYTES = 1024;
const MAX_REQUESTER_BYTES = 128;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

/** The closed advisory cancellation record. */
export interface OperationCancelRequest {
  schemaVersion: 1;
  runId: OperationRunId;
  requester: string;
  at: string;
}

/** Absent, a validated present request, or an unreadable/forged/oversize file. */
export type CancelRequestRead =
  | { status: "absent" }
  | { status: "present"; request: OperationCancelRequest }
  | { status: "unavailable"; detail: string };

/** Inputs for one lock-free cancellation request. */
export interface CancelRequestInput {
  workspaceId: string;
  runId: OperationRunId;
  requester: string;
  at: string;
}

/** Build the exact closed advisory record, rejecting an over-long requester label. */
function buildCancelRequest(runId: OperationRunId, requester: string, at: string): OperationCancelRequest {
  return {
    schemaVersion: 1, runId: assertOperationRunId(runId),
    requester: textValue(requester, "cancel requester", MAX_REQUESTER_BYTES), at: timestamp(at),
  };
}

/** Parse a present advisory file and bind its run id to the path-derived id. */
function parseCancelRequest(bytes: Buffer, runId: OperationRunId): OperationCancelRequest {
  const item = record(parseBoundedUniqueJson(UTF8_DECODER.decode(bytes), MAX_CANCEL_BYTES), "cancel request");
  exact(item, ["schemaVersion", "runId", "requester", "at"]);
  if (count(item.schemaVersion, "cancel schemaVersion") !== 1) throw new Error("cancel schemaVersion is unsupported");
  const request = buildCancelRequest(assertOperationRunId(item.runId), textValue(item.requester, "cancel requester", MAX_REQUESTER_BYTES), timestamp(item.at));
  if (request.runId !== runId) throw new Error("cancel request names a different run");
  if (!canonicalBytes(request).equals(bytes)) throw new Error("cancel request is not canonical");
  return request;
}

/**
 * Write the advisory cancellation request without the project lock. Create-only:
 * an existing request is left untouched. This never authorizes state; a lock
 * holder must observe it and append the signed cancellation transition.
 */
export async function writeCancelRequestLockFree(root: string, input: CancelRequestInput): Promise<"created" | "exists"> {
  const file = operationPaths(root, input.workspaceId).cancelFile(input.runId);
  const bytes = canonicalBytes(buildCancelRequest(input.runId, input.requester, input.at));
  if (bytes.byteLength > MAX_CANCEL_BYTES) throw new Error("cancel request exceeds its 1 KiB cap");
  return writeAdvisoryCreateOnly(root, file, bytes);
}

/** Read and validate the advisory request; a symlinked/oversize/forged file is unavailable. */
export async function readCancelRequest(root: string, workspaceId: string, runId: OperationRunId): Promise<CancelRequestRead> {
  const paths = operationPaths(root, workspaceId);
  return readAdvisoryRecord(root, paths.cancelFile(runId), paths.runsRoot, MAX_CANCEL_BYTES,
    (bytes) => parseCancelRequest(bytes, runId));
}

/**
 * Remove the advisory after settlement, best-effort. The caller holds the project
 * lock. Removes any REMOVABLE shape planted at the lock-free, out-of-band `.cancel`
 * path — a regular file, a symlink, or a DIRECTORY — so a planted directory can
 * never raise EISDIR (a plain `force` remove suppresses only ENOENT) out of the
 * enclosing approve/poll paths. The remover dispatches on the observed shape and
 * routes the ordinary regular-file case through the root-confined, parent-verified,
 * fsynced primitive; only a NON-EMPTY planted directory still takes a tree walk.
 * An un-removable residual (e.g. a mode-0000 directory raising EACCES) is swallowed
 * best-effort and LEFT in place: advisory removal is non-authoritative cleanup and
 * must never escape as a raw throw and bypass the enclosing transient-refusal
 * (pre-apply) or recovery park (mid-apply). A left-behind residual is no worse than
 * baseline — any unrecognized junk in the runs tree already blocks the fail-closed
 * inventory scan until an operator clears it.
 */
export async function removeCancelRequestLocked(root: string, workspaceId: string, runId: OperationRunId): Promise<void> {
  const paths = operationPaths(root, workspaceId);
  await removeAdvisoryBestEffort(root, paths.cancelFile(runId), paths.runsRoot);
}
