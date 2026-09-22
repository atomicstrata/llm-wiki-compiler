/**
 * @file src/operation-bundles/problems.ts
 * @description Stable operation problem codes plus the typed input error used
 * before operation-store paths are constructed. Problems carry bounded,
 * project-relative metadata; identity errors never need filesystem context.
 */

/** Closed host-owned identity kinds used in fixed refusal messages. */
export type OperationIdentityKind =
  | "bundle-id"
  | "run-id"
  | "mutation-id"
  | "catalog-record-id"
  | "mutation-index"
  | "workspace-id"
  | "recipe-id"
  | "sha256-digest";

/** Fixed display labels; rejected caller values never enter this mapping. */
const OPERATION_IDENTITY_LABELS: Readonly<Record<OperationIdentityKind, string>> = {
  "bundle-id": "bundle id",
  "run-id": "run id",
  "mutation-id": "mutation id",
  "catalog-record-id": "catalog record id",
  "mutation-index": "mutation index",
  "workspace-id": "workspace id",
  "recipe-id": "recipe id",
  "sha256-digest": "SHA-256 digest",
};

/** Codes shared by future CLI, SDK, and MCP operation surfaces. */
export const OPERATION_PROBLEM_CODES = Object.freeze([
  "review-item-not-found",
  "review-store-unavailable",
  "review-item-invalid",
  "review-id-ambiguous",
  "review-list-incomplete",
  "review-digest-mismatch",
  "approval-grant-missing",
  "approval-invalidated",
  "bundle-capacity-exceeded",
  "bundle-precondition-conflict",
  "bundle-preconditions-stale",
  "bundle-recovery-required",
  "bundle-orphaned",
  "bundle-recovery-blocking",
  "run-record-headroom-exhausted",
  "run-integrity-invalid",
  "integrity-key-missing",
  "integrity-key-unreadable",
  "quarantine-pending",
  "quarantine-retained",
  "residual-state-abandoned",
  "concurrent-change",
] as const);

export type OperationProblemCode = (typeof OPERATION_PROBLEM_CODES)[number];

/** Bounded structured problem returned across operation review surfaces. */
export interface OperationProblem {
  code: OperationProblemCode;
  message: string;
  path?: string;
  metadata?: Readonly<Record<string, string | number | boolean>>;
}

/** A caller-supplied operation identity cannot safely name an owned leaf. */
export class OperationIdentityError extends Error {
  constructor(kind: OperationIdentityKind) {
    super(`unsafe operation ${OPERATION_IDENTITY_LABELS[kind] ?? "identity"}`);
    this.name = "OperationIdentityError";
  }
}

/** Type-check and prefilter a bounded identity before any scanning primitive. */
export function boundedOperationIdentity(
  value: unknown,
  kind: OperationIdentityKind,
  maxCodeUnits: number,
): string {
  if (typeof value !== "string" || value.length > maxCodeUnits) {
    throw new OperationIdentityError(kind);
  }
  return value;
}

/** Type-check and prefilter one exact-shape identity before regex or prefix work. */
export function exactOperationIdentity(
  value: unknown,
  kind: OperationIdentityKind,
  exactCodeUnits: number,
): string {
  const bounded = boundedOperationIdentity(value, kind, exactCodeUnits);
  if (bounded.length !== exactCodeUnits) throw new OperationIdentityError(kind);
  return bounded;
}
