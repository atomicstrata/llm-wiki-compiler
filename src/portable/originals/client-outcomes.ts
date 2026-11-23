/**
 * @file src/portable/originals/client-outcomes.ts
 * @description What the `portable-originals/2` client accepts as a host's
 * answer to a control call, a stage step or a staged add.
 *
 * A body that parsed is not yet an answer. A control or stage answer must be
 * the method's own kind, with the fields the caller can check against what it
 * sent — the negotiated protocol, the held handle, the declared size, the
 * stated name — or a refusal from this protocol's CLOSED set. Anything else is
 * thrown as unestablished, so it never reaches a caller as a result.
 *
 * A staged add is a write, so it never throws: its answer must be one of the
 * shared publication arms for the HELD operation id (the same predicate an
 * `apply` answer meets) or this protocol's refusal, and a `committed` arm must
 * have published the source at `sourcePath(name)`. The published source is the
 * bounded DERIVATIVE of the original, so its digest may differ from the staged
 * original's digest, and nothing here compares the two: the client cannot
 * prove that association, and the trusted host's operation result is the only
 * statement of it. A malformed, misbound, unreadable or failed answer is
 * `unknown` under the held id, after exactly one attempt.
 *
 * This checks shape and caller-held identity only; it is not a wire-schema
 * framework and cannot prove what the host did.
 */

import type { Unknown } from "../contracts.js";
import { sourcePath } from "../logical-paths.js";
import { isEstablishedOutcome } from "../remote/outcome-validation.js";
import {
  ORIGINALS_CAPABILITY, ORIGINALS_PROTOCOL_V2, ORIGINALS_REFUSAL_CODES_V2, type AddStagedOutcomeV2, type AddStagedRequestV2, type OriginalsRefusedV2,
} from "./contracts.js";

/** A loosely typed record read off the wire. */
type Wire = Record<string, unknown>;

/** A check of a method's own answer, besides this protocol's refusal. */
export type AnswerCheck = (answer: Wire) => boolean;

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const isRecord = (value: unknown): value is Wire => value !== null && typeof value === "object" && !Array.isArray(value);
const isDigest = (value: unknown): boolean => typeof value === "string" && DIGEST.test(value);
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const isName = (value: unknown): boolean => typeof value === "string" && value.length > 0;

/**
 * True for this protocol's refusal: a code from the closed set, the capability
 * only on `capability_unsupported`, and no operation id — it is given before
 * any operation began.
 */
function isOriginalsRefusal(answer: unknown): answer is OriginalsRefusedV2 {
  if (!isRecord(answer) || answer.kind !== "refused" || "operationId" in answer || typeof answer.notice !== "string") return false;
  const isCode = ORIGINALS_REFUSAL_CODES_V2.some((code) => code === answer.code);
  const isCapabilityOk = answer.capability === undefined || (answer.code === "capability_unsupported" && answer.capability === ORIGINALS_CAPABILITY);
  return isCode && isCapabilityOk;
}

/**
 * A control or stage answer, established: this protocol's refusal, or the
 * method's own answer as `isExpected` judges it.
 *
 * @throws Error when the host did not establish an answer of `method`.
 */
export function establishedAnswer<T>(method: string, answer: unknown, isExpected: AnswerCheck): T | OriginalsRefusedV2 {
  if (isOriginalsRefusal(answer)) return answer;
  if (isRecord(answer) && isExpected(answer)) return answer as T;
  throw new Error(`the host did not establish a ${method} outcome`);
}

/** A negotiation of exactly this protocol, with its declared capabilities. */
export const isNegotiation: AnswerCheck = (answer) =>
  answer.kind === "negotiated" && answer.protocol === ORIGINALS_PROTOCOL_V2 && isRecord(answer.capabilities);

/** The metadata of the original the caller named. */
export function isOriginalStatOf(name: string): AnswerCheck {
  return (answer) => answer.kind === "original" && answer.name === name && isDigest(answer.digest) && isCount(answer.byteCount)
    && Array.isArray(answer.labels) && answer.labels.every((label) => typeof label === "string")
    && isRecord(answer.derivative) && isDigest(answer.derivative.digest);
}

/** What the caller holds when it checks one stage step: the step, its declared size and, after opening, the handle. */
export interface StageExpectation { step: "opened" | "appended" | "sealed"; declaredBytes: number; handle?: string }

/** True when a staged view is in the state its step leaves it: open and empty, open, or sealed whole with a digest. */
function isStepState(step: StageExpectation["step"], answer: Wire): boolean {
  if (step === "opened") return answer.state === "open" && answer.receivedBytes === 0;
  if (step === "appended") return answer.state === "open";
  return answer.state === "sealed" && answer.receivedBytes === answer.declaredBytes && isDigest(answer.digest);
}

/** A staged view of the held handle, at the declared size, in the state `expected.step` leaves it. */
export function isStageStep(expected: StageExpectation): AnswerCheck {
  return (answer) => {
    if (answer.kind !== "staged" || !isName(answer.handle) || typeof answer.expiresAt !== "string") return false;
    if (expected.handle !== undefined && answer.handle !== expected.handle) return false;
    const isWithinDeclared = isCount(answer.receivedBytes) && answer.receivedBytes <= expected.declaredBytes;
    return answer.declaredBytes === expected.declaredBytes && isWithinDeclared && isStepState(expected.step, answer);
  };
}

/** True when a staged add's answer is established for `request`: this protocol's refusal or a bound publication arm. */
function isStagedAddOutcome(answer: unknown, request: AddStagedRequestV2): boolean {
  if (isOriginalsRefusal(answer)) return true;
  if (!isEstablishedOutcome("apply", answer, request)) return false;
  const outcome = answer as Wire;
  if (outcome.kind !== "committed") return true;
  const target = sourcePath(request.name);
  return (outcome.published as { path: string }[]).some((object) => object.path === target);
}

/**
 * Send one staged add exactly once and settle its answer. A send that throws —
 * a transport or parse failure — and any answer that is not established for
 * the held id are `unknown` under that id: never retried, never re-identified.
 *
 * @param request - What the caller sends; its operation id is the held id.
 * @param send - The one network attempt, resolving to the parsed body.
 */
export async function settleStagedAdd(request: AddStagedRequestV2, send: () => Promise<unknown>): Promise<AddStagedOutcomeV2> {
  const unknown: Unknown = { kind: "unknown", operationId: request.operationId };
  let answer: unknown;
  try {
    answer = await send();
  } catch {
    return unknown;
  }
  return isStagedAddOutcome(answer, request) ? (answer as AddStagedOutcomeV2) : unknown;
}
