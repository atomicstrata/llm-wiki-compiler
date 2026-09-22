/**
 * @file src/preparations/service-request-capture.ts
 * @description One home for the OUTER request read every service operation
 * performs before it does anything else.
 *
 * WHAT THIS CLOSES. Each operation captured its request in the synchronous
 * prologue — the D-10-9 timing discipline, applied uniformly and correctly — and
 * every one of those captures read its fields with a plain `[[Get]]`. So an own
 * accessor on the caller's request object EXECUTED, at the outermost read, on
 * all six. Measured rather than argued: `stage` created a run, `fail` drove one
 * terminal and `cancel` wrote a cancellation record, all from getter-supplied
 * input, and none of the six refused on accessor grounds.
 *
 * THE SHAPE OF THE MISS IS THE LESSON. An earlier round hardened WHICH
 * properties are read (own, never inherited) and never asked WHEN; a later one
 * asked WHEN and never asked HOW. A boundary read has independent questions and
 * answering one does not touch the others — the hardened inner capture in
 * `service-handoff.ts` was handed its value by exactly the kind of read it
 * exists to refuse.
 */

import { tryCaptureOwnDataRecord } from "../utils/runtime-capture.js";

/**
 * The one wording for a request this service will not read.
 *
 * Shared so six operations cannot drift into six descriptions of one condition.
 */
export const REQUEST_CAPTURE_REFUSAL =
  "the request must be a plain object whose fields are data, not accessors";

/**
 * Capture one operation request by own DATA descriptors, or refuse it.
 *
 * The returned record is frozen, null-prototyped and holds only values no
 * accessor produced, so every later field read is a plain data read and reading
 * a field twice cannot yield two answers.
 *
 * THE CAST ASSERTS NOTHING NEW. It re-states the type the operation's own
 * parameter already declared; it does not validate, and a JavaScript embedder
 * can still supply a wrongly-typed field exactly as it could before. What
 * changes is only that the values are the caller's own data rather than
 * whatever an accessor chose to return on the read that reached them.
 *
 * WHY REFUSING A NON-PLAIN PROTOTYPE IS SAFE HERE, and it is a LAYERING fact
 * rather than a survey of today's callers: the outer request is always a fresh
 * object literal that a surface constructs — the SDK facade builds one per
 * method, each CLI command builds its own — because request DTOs carry no
 * caller-supplied identity to preserve. An embedder's own objects are the
 * NESTED ones (`obligations`, `documents`), and those reach the per-operation
 * captures, not this one. So no embedder object shape can be refused by this
 * read, whatever the callers happen to look like later.
 *
 * @param request - The caller-supplied request object, untrusted.
 * @returns The captured request, or `null` when it cannot be safely read.
 */
export function capturedRequest<T>(request: unknown): T | null {
  return tryCaptureOwnDataRecord(request) as T | null;
}
