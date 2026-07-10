/**
 * @file src/profile/validate-helpers.ts
 * @description Shared primitives for profile validation, used by BOTH `./validate.ts`
 * and `./validate-workflow-actions.ts`.
 *
 * These two helpers — the fail-closed `assert` and the single gate-grammar parser —
 * are called from both the core profile validators (entities/relations/workflows) and
 * the extracted workflow-action validators. They live here, in a leaf module with no
 * dependency on either validator, so the workflow-action block can be split into its
 * own file without forming an import cycle with `./validate.ts`.
 */

import { ProfileValidationError } from "./errors.js";
import type { LifecycleDef } from "./types.js";

/** Throw a {@link ProfileValidationError} unless `condition` holds. */
export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ProfileValidationError(message);
}

/**
 * The lifecycle's state set: the union of its terminal states and every
 * transition endpoint (both sides). The single primitive both lifecycle
 * FSM validation and relation-requirement validation compute states with, so a
 * state name is judged "declared" against exactly one definition.
 */
export function lifecycleStates(lc: LifecycleDef): Set<string> {
  const states = new Set<string>(lc.terminal);
  for (const [from, tos] of Object.entries(lc.transitions)) {
    states.add(from);
    for (const to of tos) states.add(to);
  }
  return states;
}

/** A recognized gate kind under {@link GATE_PATTERN}. */
export type GateKind = "trust" | "human" | "agent";

/** The shared `<kind>:<slug-safe-id>` gate grammar (stage gates AND action gates). */
const GATE_PATTERN = /^(trust|human|agent):[a-z0-9][a-z0-9-]*$/;

/**
 * Parse a gate string against the shared {@link GATE_PATTERN}, returning its kind
 * (slug-safe id enforced) or `null` when malformed. The ONE primitive both stage
 * and action gate validation call, so their id contract is identical.
 */
export function parseGrammarGate(gate: string): GateKind | null {
  const match = GATE_PATTERN.exec(gate);
  return match ? (match[1] as GateKind) : null;
}
