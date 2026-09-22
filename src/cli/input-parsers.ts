/**
 * Shared CLI input grammar for product and workflow commands. These parsers
 * preserve existing bounded object and key=value behavior without importing
 * workflow execution or workflow-specific presentation.
 */
import { assertRawInputJsonWithinBounds, assertInputDepthWithinBounds } from "../utils/workflow-input-bounds.js";


/**
 * Parse repeated `--input key=value` pairs into a run-inputs record, splitting on
 * the FIRST `=` so values may themselves contain `=`. A pair with no `=` (or an
 * empty key) is malformed.
 *
 * EXPORTED IN ITS THROWING FORM for the `product` group, which answers a bad
 * flag with a typed refusal envelope rather than by exiting. One grammar, two
 * reporting styles — a second splitter is how `--input` comes to mean one thing
 * on one command group and another thing on the next.
 *
 * @param pairs - Raw `key=value` strings from `--input`.
 * @returns The parsed inputs record.
 * @throws {Error} When any pair lacks a `=` or has an empty key.
 */
export function parseInputPairs(pairs: readonly string[]): Record<string, unknown> {
  const inputs: Record<string, unknown> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new Error(`invalid --input ${JSON.stringify(pair)} (expected key=value)`);
    inputs[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return inputs;
}


/**
 * Parse a `--input-json` string into a plain JSON OBJECT, or `null` when the text
 * is malformed JSON or parses to a non-object (array/scalar/`null`). Pure — the
 * caller decides how to report the `null` — so the branchy parse + shape check
 * lives in one place rather than inflating the exit wrapper.
 *
 * @param json - The raw `--input-json` string.
 * @returns The parsed object, or `null` when not a JSON object.
 */
export function parseJsonObject(json: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const isObject = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  return isObject ? (parsed as Record<string, unknown>) : null;
}


/**
 * Parse `--input-json` into a bounded JSON OBJECT of typed inputs, THROWING on
 * anything else. Rejects oversized text, malformed JSON, an over-deep object,
 * and non-object JSON (an array/scalar/`null`) alike.
 *
 * EXPORTED IN ITS THROWING FORM for the `product` group — see
 * {@link parseInputPairs} for why both flags share one grammar.
 *
 * @param json - The raw `--input-json` string.
 * @returns The parsed inputs record.
 * @throws {Error} When the text is unbounded, malformed, too deep, or not an object.
 */
export function parseInputJsonObject(json: string): Record<string, unknown> {
  // BOUND the raw text BEFORE JSON.parse (memory DoS), then DEPTH-bound the
  // parsed object BEFORE it reaches any stringify/canonicalize (stack overflow).
  assertRawInputJsonWithinBounds(json);
  const parsed = parseJsonObject(json);
  if (parsed === null) throw new Error("--input-json must be a JSON object");
  assertInputDepthWithinBounds(parsed);
  return parsed;
}
