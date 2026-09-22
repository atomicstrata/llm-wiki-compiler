/**
 * @file src/preparations/principals.ts
 * @description Transport-independent preparation principal and grant authority
 * (design section 17.2). Transport is not principal: a local CLI invocation IS
 * the local project operator (shell plus lock access, human or agent-driven) and
 * therefore holds the closed local-operator preparation grant set by transport;
 * an SDK or MCP caller holds ONLY the grants explicitly minted for it, and a
 * missing grant fails closed. No pack, provider, installation, alias, prompt, or
 * agent descriptor can create or widen a grant, and `operation-bundle.approve`
 * (Milestone A's separate local apply authority) is never implied by any
 * preparation grant. Every principal that crosses this boundary is captured
 * fail-closed: proxies, accessors, non-plain prototypes, unknown surfaces, and
 * unknown grants are rejected before any authority decision is made, so a forged
 * `surface: "cli"` record cannot borrow local-operator authority it was not given
 * by the actual transport.
 */

import { captureDenseArray, captureOwnDataRecord } from "../utils/runtime-capture.js";
import type { PreparationPrincipalV1 } from "./run-types.js";

/** Every transport surface recognized by the preparation principal contract. */
export const PREPARATION_SURFACES = Object.freeze(["cli", "sdk", "mcp"] as const);

export type PreparationSurface = (typeof PREPARATION_SURFACES)[number];

/** The closed minimum grant vocabulary (design section 17.2). */
export const PREPARATION_GRANTS = Object.freeze([
  "preparation.run",
  "preparation.gate.decide",
  "preparation.effect.approve",
  "preparation.cancel",
  "preparation.recovery",
  "preparation.abandon",
  "preparation.quarantine",
  "operation-bundle.approve",
] as const);

export type PreparationGrant = (typeof PREPARATION_GRANTS)[number];

/**
 * The preparation grants a local project operator holds purely by CLI transport.
 * `operation-bundle.approve` is deliberately excluded: it is Milestone A's local
 * apply authority and is never implied by preparation authority, even for CLI.
 */
const LOCAL_OPERATOR_GRANTS = Object.freeze([
  "preparation.run",
  "preparation.gate.decide",
  "preparation.effect.approve",
  "preparation.cancel",
  "preparation.recovery",
  "preparation.abandon",
  "preparation.quarantine",
] as const);

/** The maximum number of explicit grants one principal record may carry. */
const MAX_PRINCIPAL_GRANTS = PREPARATION_GRANTS.length;

/** The inclusive byte bound on a principal identity string. */
const MAX_PRINCIPAL_ID_BYTES = 256;

/** The closed grammar of a bounded, control-free principal identity. */
const PRINCIPAL_ID_PATTERN = /^[\x21-\x7e][\x20-\x7e]{0,254}$/;

/** Closed reason a principal record or a grant check failed closed. */
export type PrincipalAuthorityCode = "invalid-principal" | "missing-grant";

/** Typed refusal raised for every principal or grant authority failure. */
export class PrincipalAuthorityError extends Error {
  readonly code: PrincipalAuthorityCode;
  constructor(code: PrincipalAuthorityCode) {
    super(`preparation principal authority: ${code}`);
    this.name = "PrincipalAuthorityError";
    this.code = code;
  }
}

/** Explicit authority resolved by the host transport for a preparation action. */
export interface PreparationPrincipal {
  readonly id: string;
  readonly surface: PreparationSurface;
  readonly grants: readonly PreparationGrant[];
}

/** Require a bounded, non-empty, control-free identity string. */
function principalId(value: unknown): string {
  if (typeof value !== "string"
    || Buffer.byteLength(value, "utf8") > MAX_PRINCIPAL_ID_BYTES
    || !PRINCIPAL_ID_PATTERN.test(value)) {
    throw new PrincipalAuthorityError("invalid-principal");
  }
  return value;
}

/** Require a surface drawn from the closed transport set. */
function principalSurface(value: unknown): PreparationSurface {
  if (!PREPARATION_SURFACES.includes(value as PreparationSurface)) {
    throw new PrincipalAuthorityError("invalid-principal");
  }
  return value as PreparationSurface;
}

/** Require a single grant token drawn from the closed grant vocabulary. */
function principalGrant(value: unknown): PreparationGrant {
  if (!PREPARATION_GRANTS.includes(value as PreparationGrant)) {
    throw new PrincipalAuthorityError("invalid-principal");
  }
  return value as PreparationGrant;
}

/**
 * Capture one untrusted principal record into a frozen, data-only value. The
 * record's own data descriptors are read without invoking any getter or proxy
 * trap; the surface and every grant are checked against their closed allowlists;
 * and duplicate grants collapse so a repeated token cannot inflate a count.
 */
export function capturePreparationPrincipal(value: unknown): PreparationPrincipal {
  let captured: Readonly<Record<string, unknown>>;
  try {
    captured = captureOwnDataRecord(value);
  } catch {
    throw new PrincipalAuthorityError("invalid-principal");
  }
  const keys = Object.keys(captured);
  if (keys.length !== 3 || !keys.every((key) => key === "id" || key === "surface" || key === "grants")) {
    throw new PrincipalAuthorityError("invalid-principal");
  }
  const grants = captureDenseArray(
    captured.grants, MAX_PRINCIPAL_GRANTS, (item) => principalGrant(item),
    () => new PrincipalAuthorityError("invalid-principal"),
  );
  return Object.freeze({
    id: principalId(captured.id),
    surface: principalSurface(captured.surface),
    grants: Object.freeze([...new Set(grants)]),
  });
}

/**
 * The complete set of grants a principal effectively holds. A CLI principal
 * unions the local-operator grant set with any explicit grants; an SDK or MCP
 * principal holds exactly its explicit grants. `operation-bundle.approve` is
 * never added by transport and only appears when it was explicitly granted.
 */
export function effectivePreparationGrants(
  principal: PreparationPrincipal,
): ReadonlySet<PreparationGrant> {
  const captured = capturePreparationPrincipal(principal);
  const effective = new Set<PreparationGrant>(captured.grants);
  if (captured.surface === "cli") {
    for (const grant of LOCAL_OPERATOR_GRANTS) effective.add(grant);
  }
  return effective;
}

/** True when the captured principal effectively holds the exact grant. */
export function principalHasGrant(
  principal: PreparationPrincipal, grant: PreparationGrant,
): boolean {
  return effectivePreparationGrants(principal).has(grant);
}

/** Fail closed unless the principal effectively holds the exact grant. */
export function requirePreparationGrant(
  principal: PreparationPrincipal, grant: PreparationGrant,
): void {
  if (!principalHasGrant(principal, grant)) throw new PrincipalAuthorityError("missing-grant");
}

/** Project one captured principal onto the id+surface actor a transition records. */
export function preparationRunActor(principal: PreparationPrincipal): PreparationPrincipalV1 {
  const captured = capturePreparationPrincipal(principal);
  return { id: captured.id, surface: captured.surface };
}
