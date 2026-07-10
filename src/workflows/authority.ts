/**
 * @file src/workflows/authority.ts
 * @description The PURE, I/O-free action authority model.
 *
 * Write authority for a workflow action is the MOST-RESTRICTIVE of three
 * INDEPENDENT inputs over the ordinal capability scale
 * `disabled < read-only < staged-write < trusted-write`:
 *
 *   effectivePermission = min(profileRequested, localGrant, surfaceHardCap[surface])
 *
 *  - **profileRequested** — what the action's `permissions[surface]` asks for. A
 *    REQUEST, never a grant: the profile is untrusted/portable, so it can NEVER
 *    raise authority — only lower it.
 *  - **localGrant** — the receiving project's local `.llmwiki/config.json` knob.
 *    It can only TIGHTEN; a portable profile carries no grant.
 *  - **surfaceHardCap** — the non-negotiable per-surface ceiling. `cli`/`sdk` may
 *    reach `trusted-write`; `viewer`/`mcp` are capped at `staged-write`. MCP can
 *    therefore NEVER trusted-write and NEVER satisfy a human gate, regardless of
 *    what a profile or local config says.
 *
 * These guarantees are STRUCTURAL, mirroring `composeTrustDecision`'s rigor bar:
 * {@link minCapability} is TOTAL (every input set, including the empty one, maps
 * to exactly one capability), MONOTONE (adding an input can only lower the
 * result), ORDER-INDEPENDENT, and DISABLED-DOMINANT (any `disabled` ⇒ disabled).
 * Anything unrecognized fails CLOSED to `disabled`. This file has no I/O and no
 * side effects; it is pure authority arithmetic.
 */

import type { CapabilityClass, ActionSurface } from "../profile/types.js";

/** The capability ordinal, least → most authority. */
export const CAPABILITY_ORDER = [
  "disabled",
  "read-only",
  "staged-write",
  "trusted-write",
] as const satisfies readonly CapabilityClass[];

/**
 * Non-negotiable per-surface authority ceiling. `cli`/`sdk` are trusted local
 * surfaces and may reach `trusted-write`; `viewer`/`mcp` are remote/untrusted and
 * are hard-capped at `staged-write`, so MCP can never trusted-write. Frozen so the
 * ceiling cannot be mutated at runtime.
 */
export const SURFACE_HARD_CAP: Readonly<Record<ActionSurface, CapabilityClass>> = Object.freeze({
  cli: "trusted-write",
  sdk: "trusted-write",
  mcp: "staged-write",
  viewer: "staged-write",
});

/** Ordinal rank of a capability, or -1 for anything not on the scale (fail closed). */
function rankOf(cap: CapabilityClass): number {
  return (CAPABILITY_ORDER as readonly string[]).indexOf(cap);
}

/**
 * The MOST-RESTRICTIVE (lowest-ordinal) of the given capabilities. Any `disabled`
 * — or any value NOT on the {@link CAPABILITY_ORDER} scale — yields `disabled`
 * (fail closed). An EMPTY arg list yields `disabled` (fail closed). Total,
 * monotone, order-independent, and disabled-dominant.
 *
 * @param caps - The capabilities to reduce.
 * @returns The lowest-authority capability, or `disabled` when empty/unknown.
 */
export function minCapability(...caps: CapabilityClass[]): CapabilityClass {
  let lowest: CapabilityClass = caps.length === 0 ? "disabled" : caps[0];
  for (const cap of caps) {
    const rank = rankOf(cap);
    if (rank < 0) return "disabled"; // unknown capability → fail closed
    if (rank < rankOf(lowest)) lowest = cap;
  }
  return lowest;
}

/**
 * Compose the effective write permission for an action invocation:
 * `min(profileRequested, localGrant, surfaceHardCap[surface])`. The result is
 * always ≤ each input, so a profile can never raise authority, a local grant can
 * only tighten, and the surface cap is never exceeded.
 *
 * @param profileRequested - The action's requested capability for the surface.
 * @param localGrant - The local project's grant for the surface.
 * @param surface - The surface the action is invoked through.
 * @returns The effective (most-restrictive) capability.
 */
export function effectivePermission(
  profileRequested: CapabilityClass,
  localGrant: CapabilityClass,
  surface: ActionSurface,
): CapabilityClass {
  return minCapability(profileRequested, localGrant, SURFACE_HARD_CAP[surface]);
}

/**
 * Whether an action may satisfy a HUMAN gate. A human gate is the highest-trust
 * action, so satisfying it is PERMISSION-DOMINATED: the COMPOSED effective
 * permission must be `trusted-write`. Lower authority (`disabled`/`read-only`/
 * `staged-write`) can NEVER satisfy it, regardless of the flags. On top of that
 * a human gate can be satisfied ONLY on a surface whose HARD CAP is
 * `trusted-write` — i.e. `cli`/`sdk`, never `mcp` OR `viewer`. The profile must
 * REQUEST the gate, AND the local config must ENABLE it. Defaults to `false` — a
 * gate is satisfiable only when positively earned on every count.
 *
 * This predicate is SELF-DEFENDING: it gates on `SURFACE_HARD_CAP[surface]`
 * DIRECTLY rather than trusting the composed `effectivePermission` argument, so an
 * INCONSISTENT `trusted-write` passed for `viewer` (hard-capped at `staged-write`)
 * or `mcp` still returns `false`.
 *
 * @param effectivePermission - The COMPOSED effective capability for the invocation.
 * @param surface - The surface attempting to satisfy the gate.
 * @param profileRequestsGate - Whether the action's profile requests this gate.
 * @param localEnablesGate - Whether the local config enables this gate.
 * @returns `true` only when trusted-write AND a trusted-write-capped surface (cli/sdk) AND requested AND locally enabled.
 */
export function canSatisfyHumanGate(
  effectivePermission: CapabilityClass,
  surface: ActionSurface,
  profileRequestsGate: boolean,
  localEnablesGate: boolean,
): boolean {
  return effectivePermission === "trusted-write"
    && SURFACE_HARD_CAP[surface] === "trusted-write"
    && profileRequestsGate
    && localEnablesGate;
}
