/**
 * @file src/portable/remote/outcome-validation.ts
 * @description What a remote client accepts as the ANSWER to one of its writes.
 *
 * A response that parsed is not yet an answer. Before a client reports an
 * outcome to its caller, the response must be:
 *
 *  - an arm THIS method can return: each write has exactly one success arm
 *    (`sources.add` and `apply` commit, `propose` proposes, `approve`
 *    approves), plus the shared non-commit arms;
 *  - about THIS operation: it names the id the caller already holds, and where
 *    the caller holds more — the bytes it uploaded, the digests it reviewed —
 *    the success arm must agree with those too;
 *  - complete: a success arm carries the payload that makes it a success, and
 *    a refusal or rejection carries a code or reason from the closed sets.
 *
 * Anything else establishes nothing, and the client reports `unknown` under
 * the held id.
 *
 * WHAT THIS IS NOT. It checks shape and caller-held identity. It cannot prove
 * the host really committed: in the prototype's trust model the host is the
 * authority and is trusted. It is a bounded predicate, not a wire-schema
 * framework.
 */

import { RECOVERY_DETAILS, REFUSAL_CODES, REJECTION_REASONS, type RefusalCode } from "../contracts.js";
import type { ApproveRequest, AddSourceRequest } from "../project/api.js";
import { sourcePath } from "../logical-paths.js";

/** The four id-bearing writes a remote client sends. */
export type WriteMethod = "sources.add" | "propose" | "candidates.approve" | "apply";

/** The one success arm each write may return. */
const SUCCESS_ARM: Readonly<Record<WriteMethod, "committed" | "proposed" | "approved">> = {
  "sources.add": "committed", apply: "committed", propose: "proposed", "candidates.approve": "approved",
};

/** A loosely typed record read off the wire. */
type Wire = Record<string, unknown>;

const DIGEST = /^sha256:[0-9a-f]{64}$/u;

const isRecord = (value: unknown): value is Wire => value !== null && typeof value === "object" && !Array.isArray(value);
const isDigest = (value: unknown): value is string => typeof value === "string" && DIGEST.test(value);
const isStringArray = (value: unknown): boolean => Array.isArray(value) && value.every((entry) => typeof entry === "string");
const isOneOf = (set: readonly string[], value: unknown): boolean => typeof value === "string" && set.includes(value);

/** One published object: a path, the digest of its bytes and its labels. */
function isPublishedObject(value: unknown): value is { path: string; digest: string } {
  return isRecord(value) && typeof value.path === "string" && isDigest(value.digest) && isStringArray(value.labels);
}

/** A project revision as an adapter reports it: none, or a finite non-negative integer. */
function isHead(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isInteger(value) && value >= 0);
}

/** A complete `committed` arm for the held id. */
function isCommitted(outcome: Wire, operationId: string): boolean {
  const published = outcome.published;
  return outcome.operationId === operationId && isHead(outcome.head) && Array.isArray(outcome.skipped)
    && Array.isArray(published) && published.length > 0 && published.every(isPublishedObject);
}

/** A `committed` source add must have published the caller's own bytes under the caller's own name. */
function committedTheUpload(outcome: Wire, request: AddSourceRequest): boolean {
  const published = outcome.published as { path: string; digest: string }[];
  return published.some((object) => object.path === sourcePath(request.name) && object.digest === request.upload.byteDigest);
}

/** A complete `proposed` arm whose receipt names the held id. */
function isProposed(outcome: Wire, operationId: string): boolean {
  const receipt = outcome.receipt;
  if (!isRecord(receipt) || receipt.operationId !== operationId) return false;
  const digests = [receipt.intentDigest, receipt.candidateSetDigest, receipt.planDigest, receipt.applyDependenciesDigest];
  return digests.every(isDigest) && Array.isArray(receipt.candidates) && Array.isArray(receipt.skipped);
}

/** A complete `approved` arm for the held id that approves exactly what the caller asked to approve. */
function isApproved(outcome: Wire, request: ApproveRequest): boolean {
  const approval = outcome.approval;
  if (outcome.operationId !== request.operationId || !isRecord(approval)) return false;
  return typeof approval.approvalId === "string" && approval.operationId === request.operationId
    && approval.proposalOperationId === request.proposalOperationId
    && approval.candidateSetDigest === request.candidateSetDigest
    && approval.planDigest === request.planDigest
    && approval.applyDependenciesDigest === request.applyDependenciesDigest;
}

/** The method's success arm, complete and consistent with what the caller sent. */
function isSuccess(method: WriteMethod, outcome: Wire, request: { operationId: string }): boolean {
  if (method === "propose") return isProposed(outcome, request.operationId);
  if (method === "candidates.approve") return isApproved(outcome, request as ApproveRequest);
  if (!isCommitted(outcome, request.operationId)) return false;
  return method === "apply" || committedTheUpload(outcome, request as AddSourceRequest);
}

/** A well-formed refusal of the held operation, with a code and detail from the closed sets. */
function isRefused(outcome: Wire, operationId: string): boolean {
  const detailOk = outcome.detail === undefined || isOneOf(RECOVERY_DETAILS, outcome.detail);
  return outcome.operationId === operationId && isOneOf(REFUSAL_CODES, outcome.code) && detailOk;
}

/** One of the shared arms that is not a success: about the held operation, or a rejection of the submission. */
function isNonCommit(outcome: Wire, operationId: string): boolean {
  switch (outcome.kind) {
    case "rejected": return isOneOf(REJECTION_REASONS, outcome.reason);
    case "refused": return isRefused(outcome, operationId);
    case "in_progress":
    case "unknown": return outcome.operationId === operationId;
    case "abandoned":
      return outcome.operationId === operationId && isRecord(outcome.resolution)
        && outcome.resolution.operationId === operationId;
    default: return false;
  }
}

/** What a response envelope establishes. `unestablished` is everything that is not one of the closed forms. */
export type Envelope =
  | { kind: "result"; result: unknown }
  | { kind: "refused"; code: RefusalCode }
  | { kind: "denied" }
  | { kind: "unestablished" };

/**
 * Read a parsed response body as one of the closed envelope forms:
 * `{ok: true, result}`, `{ok: false, error: "refused", code}` with a code from
 * the closed set, or `{ok: false, error: "not_found"}` — the only denial form.
 * `ok` must be exactly `true` or `false`. A truthy `ok`, an unknown error or a
 * refusal code outside the set is NOT an established refusal or denial.
 */
export function readEnvelope(body: unknown): Envelope {
  if (!isRecord(body)) return { kind: "unestablished" };
  if (body.ok === true) return "result" in body ? { kind: "result", result: body.result } : { kind: "unestablished" };
  if (body.ok !== false) return { kind: "unestablished" };
  if (body.error === "not_found") return { kind: "denied" };
  if (body.error === "refused" && isOneOf(REFUSAL_CODES, body.code)) {
    return { kind: "refused", code: body.code as RefusalCode };
  }
  return { kind: "unestablished" };
}

/**
 * True when `answer` is an established outcome of the write the caller sent:
 * the method's own success arm with its payload, or a recognized non-commit
 * arm. A caller treats anything else as `unknown`.
 *
 * @param method - The write that was sent.
 * @param answer - The parsed response.
 * @param request - What the caller sent; its id and inputs are what an answer must agree with.
 */
export function isEstablishedOutcome(method: WriteMethod, answer: unknown, request: { operationId: string }): boolean {
  if (!isRecord(answer)) return false;
  if (answer.kind === SUCCESS_ARM[method]) return isSuccess(method, answer, request);
  return isNonCommit(answer, request.operationId);
}
