/**
 * @file src/profile/lifecycle.ts
 * @description The single, PURE per-page lifecycle-TRANSITION validator — the
 * RUNTIME counterpart to the load-time {@link validateLifecycle} in `validate.ts`.
 *
 * Where `validateLifecycle` proves a {@link LifecycleDef} is itself well-formed
 * when a profile loads, this module enforces that a CONCRETE page write obeys
 * that FSM: a page's lifecycle-field value must be a declared state, a change of
 * that value from its previous on-disk value must follow a legal out-edge, and
 * any evidence a target state requires must be present in the frontmatter.
 *
 * Given a page's `prev` state (the value on disk, or `undefined` when the page is
 * being created), its parsed `frontmatter`, and the resolved {@link LifecycleDef},
 * {@link validateLifecycleTransition} returns a list of PATH-FREE problem
 * messages. It is pure (no I/O), never throws, and carries no path/entity-type
 * context — callers attach that when they wrap each message into their own
 * error/problem shape (mirroring `field-contract.ts`).
 */

import type { LifecycleDef } from "./types.js";

/**
 * Thrown by the typed WRITE gates (staging / promotion) when a candidate body's
 * lifecycle-field value performs an illegal transition, names an undeclared
 * state, or omits required transition evidence. Fails CLOSED so a lifecycle-
 * violating typed page is never staged or promoted (on the READ surfaces the
 * same violations are non-fatal lint findings, not throws). Carries the
 * structured list of PATH-FREE problem messages so callers can surface exactly
 * what failed.
 */
export class LifecycleTransitionError extends Error {
  /** The PATH-FREE lifecycle problem messages that caused the refusal. */
  readonly problems: string[];

  constructor(entityType: string, slug: string, problems: string[]) {
    super(
      `typed page ${entityType}/${slug} violates the profile lifecycle: ` +
        `${problems.join(" ")}`,
    );
    this.name = "LifecycleTransitionError";
    this.problems = problems;
  }
}

/**
 * Derive the declared state set for a lifecycle: the UNION of `initial`, every
 * `terminal` state, and every transition key and endpoint. This is the SAME
 * derivation `validateLifecycle` uses at load time, so the runtime state set a
 * page is checked against can never disagree with the validated definition.
 * Exported so the lint surface checks against the IDENTICAL state set (DRY).
 */
export function lifecycleStateSet(lifecycle: LifecycleDef): Set<string> {
  const states = new Set<string>([lifecycle.initial, ...lifecycle.terminal]);
  for (const [from, tos] of Object.entries(lifecycle.transitions)) {
    states.add(from);
    for (const to of tos) states.add(to);
  }
  return states;
}

/**
 * Append the state-validity problem for `next` when it is present but not a
 * string, or is a string outside the declared state set. An absent `next`
 * (undefined) is a no-op — the lifecycle field is OPTIONAL on a page and is only
 * validated when present. Returns true when `next` is a usable declared state
 * (so the caller may proceed to transition/evidence checks).
 */
function checkStateDeclared(
  next: unknown,
  states: Set<string>,
  out: string[],
): next is string {
  if (next === undefined) return false;
  if (typeof next !== "string" || !states.has(next)) {
    out.push(`lifecycle state ${JSON.stringify(next)} is not a declared state`);
    return false;
  }
  return true;
}

/**
 * Append the transition-edge problem when `prev` is defined and `next` differs
 * from it but is NOT a legal out-edge in `transitions[prev]`. A terminal `prev`
 * has no out-edges, so any change away from it is illegal. A create (`prev`
 * undefined) is not a transition and is exempt — its floor is state-validity +
 * evidence, checked separately.
 */
function checkTransitionEdge(
  lifecycle: LifecycleDef,
  prev: string | undefined,
  next: string,
  out: string[],
): void {
  if (prev === undefined || prev === next) return;
  const legal = lifecycle.transitions[prev] ?? [];
  if (!legal.includes(next)) {
    out.push(`illegal lifecycle transition ${JSON.stringify(prev)} → ${JSON.stringify(next)}`);
  }
}

/**
 * Append one problem per required evidence field that `transitionRequirements`
 * lists for the target state `next` but the frontmatter does not supply
 * (non-empty). Applies on BOTH a create-into-`next` and a transition-to-`next`,
 * so a state that requires evidence can never be entered without it.
 */
function checkRequiredEvidence(
  lifecycle: LifecycleDef,
  next: string,
  frontmatter: Record<string, unknown>,
  out: string[],
): void {
  for (const field of lifecycle.transitionRequirements?.[next] ?? []) {
    if (!isEvidencePresent(frontmatter[field])) {
      out.push(`lifecycle transition to ${JSON.stringify(next)} requires evidence field ${JSON.stringify(field)}`);
    }
  }
}

/** True when an evidence value is present and non-empty (not "", not []). */
function isEvidencePresent(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * Validate a page's lifecycle-field transition against its entity type's
 * declared {@link LifecycleDef}, returning a list of PATH-FREE problem messages
 * (empty when the write obeys the FSM). The runtime counterpart to load-time
 * {@link validateLifecycle}.
 *
 * The `next` state is read from `frontmatter[lifecycle.field]`. When absent the
 * write is exempt (the lifecycle field is optional). When present it must be a
 * declared state; a change from a defined `prev` must follow a legal out-edge (a
 * create is not a transition); and any evidence the target state requires must be
 * present. Pure and total — no I/O, never throws, carries no path/entity-type
 * context.
 *
 * @param lifecycle - The resolved lifecycle definition to validate against.
 * @param prev - The page's previous on-disk lifecycle-field value, or `undefined`
 *   when the page is being created.
 * @param next - The candidate lifecycle-field value (read from `frontmatter`).
 * @param frontmatter - The page's parsed frontmatter (the evidence source).
 * @returns Zero or more PATH-FREE lifecycle problem messages.
 */
export function validateLifecycleTransition(
  lifecycle: LifecycleDef,
  prev: string | undefined,
  next: unknown,
  frontmatter: Record<string, unknown>,
): string[] {
  const problems: string[] = [];
  const states = lifecycleStateSet(lifecycle);
  if (!checkStateDeclared(next, states, problems)) return problems;
  checkTransitionEdge(lifecycle, prev, next, problems);
  checkRequiredEvidence(lifecycle, next, frontmatter, problems);
  return problems;
}
