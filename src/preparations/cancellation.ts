/**
 * @file src/preparations/cancellation.ts
 * @description The advisory `.cancel` file for a preparation run (design section
 * 23.1) — the sole lock-free write in the preparation runtime and never
 * authoritative. It is confined, create-only, no-follow, regular-file-only, and
 * bounded (<=1 KiB), carrying a schema version, the exact run id, a bounded
 * requester reference, a timestamp, and a random nonce. It is INTENT, not signed
 * state: a forged, oversize, or symlinked file is `unavailable` (never trusted),
 * and the run id inside must equal the path-derived run id so a request can never
 * name a different run. It cannot mark work cancelled, create a grant, execute a
 * follow-up effect, or alter evidence. Only a lock-holding orchestrator validates
 * current state, appends the durable `cancel-requested` transition, and removes
 * this file after settlement.
 *
 * THERE IS NO TEMPORAL BOUND. The `at` field is recorded and shape-checked but
 * never compared against a clock, and nothing expires a request: an advisory
 * lives until a settlement consumes it. That is deliberate rather than missing —
 * an operator cancel that went unhonored because the process died is exactly the
 * intent recovery must still see, and an expiry would silently discard it. What
 * bounds the request instead is that it is create-only, confined, bound to its
 * own run id by path, and removed the moment its intent is durably captured.
 */

import { TextDecoder } from "node:util";
import { canonicalBytes } from "../profile/templates/signing/canonical.js";
import { parseBoundedUniqueJson } from "../profile/templates/signing/json.js";
import { readAdvisoryRecord, removeAdvisoryBestEffort, writeAdvisoryCreateOnly } from "../utils/advisory-file.js";
import { isWellFormedUnicode } from "../utils/well-formed-unicode.js";
import { assertPreparationRunId, type PreparationRunId } from "./ids.js";
import { preparationPaths } from "./paths.js";

const MAX_CANCEL_BYTES = 1024;
const MAX_REQUESTER_BYTES = 128;
const NONCE_PATTERN = /^[0-9a-f]{32}$/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

/** The closed advisory cancellation record for one preparation run. */
export interface PreparationCancelRequestV1 {
  readonly schemaVersion: 1;
  readonly runId: PreparationRunId;
  readonly requester: string;
  readonly at: string;
  readonly nonce: string;
}

/** Absent, a validated present request, or an unreadable/forged/oversize file. */
export type PreparationCancelRead =
  | { status: "absent" }
  | { status: "present"; request: PreparationCancelRequestV1 }
  | { status: "unavailable"; detail: string };

/** Inputs for one lock-free preparation cancellation request. */
export interface PreparationCancelInput {
  workspaceId: string;
  runId: PreparationRunId;
  requester: string;
  at: string;
  nonce: string;
}

/**
 * Whether a requester label is admissible as this record's bounded text.
 *
 * EXPORTED so the service checking a label before it writes and the writer
 * enforcing it share ONE predicate. The service must answer "is this label
 * admissible" as a typed refusal rather than by catching a throw, and a second
 * copy of the rule there would be a check that can disagree with its executor —
 * the recurring class in this program. Nothing here is authority: the label is
 * a bounded operator reference, never a grant.
 */
export function isAdmissibleCancelRequester(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
    && Buffer.byteLength(value, "utf8") <= MAX_REQUESTER_BYTES
    && isWellFormedUnicode(value) && !CONTROL_CHARACTER.test(value);
}

/**
 * Require an admissible requester label, THROUGH the exported predicate.
 *
 * It routes through {@link isAdmissibleCancelRequester} rather than restating
 * the rule: a second inline copy would be exactly the check-and-executor drift
 * the export exists to prevent. The byte bound is no longer a parameter because
 * both call sites are the requester and a parameterized bound is a way for one
 * of them to be given a different one.
 */
function boundedText(value: unknown): string {
  if (!isAdmissibleCancelRequester(value)) throw new Error("cancel text field is invalid");
  return value;
}

/** Require a strict ISO-8601 timestamp that round-trips exactly. */
function timestamp(value: unknown): string {
  if (typeof value !== "string" || new Date(value).toISOString() !== value) throw new Error("cancel timestamp is invalid");
  return value;
}

/** Require a 128-bit lowercase-hex nonce. */
function nonce(value: unknown): string {
  if (typeof value !== "string" || !NONCE_PATTERN.test(value)) throw new Error("cancel nonce is invalid");
  return value;
}

/** Build the exact closed advisory record, rejecting an over-long requester label. */
function buildCancelRequest(runId: PreparationRunId, requester: string, at: string, requestNonce: string): PreparationCancelRequestV1 {
  return {
    schemaVersion: 1, runId: assertPreparationRunId(runId),
    requester: boundedText(requester), at: timestamp(at), nonce: nonce(requestNonce),
  };
}

/** Parse one present advisory file and bind its run id to the path-derived id. */
function parseCancelRequest(bytes: Buffer, runId: PreparationRunId): PreparationCancelRequestV1 {
  const item = parseBoundedUniqueJson(UTF8_DECODER.decode(bytes), MAX_CANCEL_BYTES);
  if (item === null || typeof item !== "object" || Array.isArray(item)) throw new Error("cancel request is not an object");
  const record = item as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 5 || !["schemaVersion", "runId", "requester", "at", "nonce"].every((key) => keys.includes(key))) throw new Error("cancel request shape is invalid");
  if (record.schemaVersion !== 1) throw new Error("cancel schemaVersion is unsupported");
  const request = buildCancelRequest(assertPreparationRunId(record.runId), boundedText(record.requester), timestamp(record.at), nonce(record.nonce));
  if (request.runId !== runId) throw new Error("cancel request names a different run");
  if (!canonicalBytes(request).equals(bytes)) throw new Error("cancel request is not canonical");
  return request;
}

/**
 * Write the advisory cancellation request without the project lock. Create-only:
 * an existing request is left untouched. This never authorizes state — a lock
 * holder must observe it and append the signed cancellation transition.
 */
export async function writePreparationCancelLockFree(root: string, input: PreparationCancelInput): Promise<"created" | "exists"> {
  const file = preparationPaths(root, input.workspaceId).cancelFile(input.runId);
  const bytes = canonicalBytes(buildCancelRequest(input.runId, input.requester, input.at, input.nonce));
  if (bytes.byteLength > MAX_CANCEL_BYTES) throw new Error("cancel request exceeds its 1 KiB cap");
  return writeAdvisoryCreateOnly(root, file, bytes);
}

/** Read and validate the advisory request; a symlinked/oversize/forged file is unavailable. */
export async function readPreparationCancel(root: string, workspaceId: string, runId: PreparationRunId): Promise<PreparationCancelRead> {
  const paths = preparationPaths(root, workspaceId);
  return readAdvisoryRecord(root, paths.cancelFile(runId), paths.runsRoot, MAX_CANCEL_BYTES,
    (bytes) => parseCancelRequest(bytes, runId));
}

/**
 * Report whether a valid cancellation is requested for one run. A forged or
 * unreadable advisory file returns false: it can at worst request the normal safe
 * path and never forces a false cancellation. This is a lock-free poll the
 * executor calls between provider/broker safe boundaries.
 *
 * "Valid" is structural, not temporal — an old request is as valid as a new one
 * (see the file header). A request stays live until a settlement consumes it.
 */
export async function preparationCancellationRequested(root: string, workspaceId: string, runId: PreparationRunId): Promise<boolean> {
  const read = await readPreparationCancel(root, workspaceId, runId);
  return read.status === "present";
}

/**
 * Remove the advisory after settlement, best-effort. The caller holds the project
 * lock. Removes any removable shape planted at the lock-free `.cancel` path — a
 * regular file, a symlink, or a directory. The remover dispatches on the observed
 * shape and routes the ordinary regular-file case through the root-confined,
 * parent-verified, fsynced primitive; only a NON-EMPTY planted directory still
 * takes a tree walk, so a planted shape can never raise out of the settlement path. An
 * un-removable residual is swallowed: advisory removal is non-authoritative.
 */
export async function removePreparationCancelLocked(root: string, workspaceId: string, runId: PreparationRunId): Promise<void> {
  const paths = preparationPaths(root, workspaceId);
  await removeAdvisoryBestEffort(root, paths.cancelFile(runId), paths.runsRoot);
}
