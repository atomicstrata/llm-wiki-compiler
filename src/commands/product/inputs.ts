/**
 * @file src/commands/product/inputs.ts
 * @description The `--input` / `--input-json` grammar for `product preview` and
 * `product invoke`, and the one place a shell string becomes a pack action
 * input value.
 *
 * TWO FLAGS, BECAUSE ONE CANNOT BE UNAMBIGUOUS. A repeated `--input key=value`
 * carries only strings, and a pack action field is one of thirteen declared
 * kinds — so a CLI that guessed types would have to read `--input count=42` as
 * the number 42, and an action whose `count` field is declared `string` could
 * then never be given the value "42" from a shell. The repo already answered
 * this for `workflow action run`: string pairs for the common case, and a typed
 * `--input-json` object for everything else, with the JSON winning on a key
 * collision. Both parsers are that command group's, imported rather than
 * rewritten, so the grammar cannot come to mean two things.
 *
 * A BAD FLAG IS A TYPED REFUSAL HERE, not an exit. The workflow group prints and
 * exits on a malformed pair; this group answers in the closed refusal vocabulary
 * its siblings use, so a `--json` consumer gets a parseable envelope on the one
 * path an operator most often hits. That is why the THROWING parsers are
 * imported rather than the `OrExit` wrappers around them.
 *
 * NO VALIDATION AGAINST THE ACTION HAPPENS HERE, deliberately. Whether a field
 * is declared, overridable, within its bounds, or of the right kind is the
 * compiler's single validator (`compiler-input.ts`), which a caller value and a
 * pack's own default both pass. What this file establishes is only that the
 * value is a bounded scalar or list of scalars — the shape the pack action input
 * type admits at all — so a nested object refuses with a sentence about the flag
 * rather than reaching the compiler as an unsound cast.
 */

import { parseInputJsonObject, parseInputPairs } from "../../cli/input-parsers.js";
import type {
  PackActionInputScalarV2, PackActionInputValueV2,
} from "../../operations-packs/types.js";
import type { ProductRefusalV1 } from "./render.js";

/** The workspace a product run is recorded under when the operator names none. */
export const DEFAULT_PRODUCT_WORKSPACE = "default";

/** The flags both action verbs accept. */
export interface ProductActionOptions {
  /** Repeated `key=value` pairs. Every value is a STRING. */
  input?: string[];
  /** A JSON object of typed values, winning over `--input` on a key collision. */
  inputJson?: string;
  /** The workspace the run is recorded under (default `default`). */
  workspace?: string;
  /** Emit the machine-readable envelope instead of the human lines. */
  json?: boolean;
}

/** The action input set, or the refusal that stopped it being built. */
export type CollectedInputV1 =
  | { readonly status: "collected"; readonly input: Readonly<Record<string, PackActionInputValueV2>> }
  | ProductRefusalV1;

/** True for the three scalar kinds a pack action input value is built from. */
function isInputScalar(value: unknown): value is PackActionInputScalarV2 {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

/** One merged value as a pack action input value, or `null` when it is not one. */
function asInputValue(value: unknown): PackActionInputValueV2 | null {
  if (isInputScalar(value)) return value;
  if (Array.isArray(value) && value.every(isInputScalar)) {
    return value as readonly PackActionInputScalarV2[];
  }
  return null;
}

/** The raw merged flags, or the refusal naming the flag that was malformed. */
type MergedInputV1 =
  | { readonly status: "merged"; readonly raw: Record<string, unknown> }
  | ProductRefusalV1;

/** One parser's throw as the closed refusal arm, carrying its own sentence. */
function parseRefusal(error: unknown): ProductRefusalV1 {
  return { status: "refused", reason: error instanceof Error ? error.message : String(error) };
}

/** The typed half of the grammar; an absent `--input-json` contributes nothing. */
function typedInput(inputJson: string | undefined): Record<string, unknown> {
  return inputJson === undefined ? {} : parseInputJsonObject(inputJson);
}

/**
 * Merge the string pairs with the typed object, the JSON winning on collision.
 *
 * Both parsers THROW on a malformed flag; the throw is turned into the closed
 * refusal arm here so a `--json` consumer gets a parseable envelope rather than
 * a bare exit.
 */
function mergeRawInput(options: ProductActionOptions): MergedInputV1 {
  try {
    const raw = { ...parseInputPairs(options.input ?? []), ...typedInput(options.inputJson) };
    return { status: "merged", raw };
  } catch (error) {
    return parseRefusal(error);
  }
}

/** Admit every merged value that is a pack action input value, or refuse by name. */
function admitInputValues(raw: Record<string, unknown>): CollectedInputV1 {
  const input: Record<string, PackActionInputValueV2> = {};
  for (const [fieldId, value] of Object.entries(raw)) {
    const admitted = asInputValue(value);
    if (admitted === null) {
      return {
        status: "refused",
        reason: `input ${fieldId} must be a string, number, boolean, or an array of those`,
      };
    }
    input[fieldId] = admitted;
  }
  return { status: "collected", input };
}

/**
 * Collect one invocation's action input from the operator's flags.
 *
 * @param options - The parsed `--input` / `--input-json` flags.
 * @returns The input set, or the typed refusal naming which flag was wrong.
 */
export function collectActionInput(options: ProductActionOptions): CollectedInputV1 {
  const merged = mergeRawInput(options);
  return merged.status === "refused" ? merged : admitInputValues(merged.raw);
}
