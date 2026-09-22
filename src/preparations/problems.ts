/**
 * @file src/preparations/problems.ts
 * @description Typed identity and plan-validation errors raised before any
 * durable preparation path exists. Errors carry bounded, project-relative
 * context; a rejected caller value never enters a display label. The stable
 * service-level problem-code taxonomy (design section 29) is owned by the
 * uniform surface layer that returns those codes, not by this loader.
 */

/** Closed host-owned identity kinds used in fixed refusal messages. */
export type PreparationIdentityKind =
  | "preparation-id"
  | "preparation-run-id"
  | "phase-instance-id"
  | "attempt-id"
  | "broker-request-id"
  | "gate-proof-id"
  | "handoff-id"
  | "attempt-index"
  | "request-index"
  | "decision-index"
  | "expansion-identity"
  | "safe-component";

/** Fixed display labels; rejected caller values never enter this mapping. */
const PREPARATION_IDENTITY_LABELS: Readonly<Record<PreparationIdentityKind, string>> = {
  "preparation-id": "preparation id",
  "preparation-run-id": "preparation run id",
  "phase-instance-id": "phase instance id",
  "attempt-id": "attempt id",
  "broker-request-id": "broker request id",
  "gate-proof-id": "gate proof id",
  "handoff-id": "handoff id",
  "attempt-index": "attempt index",
  "request-index": "request index",
  "decision-index": "decision index",
  "expansion-identity": "expansion identity",
  "safe-component": "safe component",
};

/** A caller-supplied identity cannot safely name an owned preparation object. */
export class PreparationIdentityError extends Error {
  constructor(public readonly kind: PreparationIdentityKind) {
    super(`unsafe preparation ${PREPARATION_IDENTITY_LABELS[kind] ?? "identity"}`);
    this.name = "PreparationIdentityError";
  }
}

/**
 * A normalized plan or manifest failed closed grammar, graph, or digest
 * validation.
 *
 * `options` carries the standard `cause` so a loader that retypes a rejection
 * raised by a shared value reader can keep the original throw — the retype
 * changes what a caller is told, and losing the stack would change what a
 * maintainer can see.
 */
export class PreparationPlanError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PreparationPlanError";
  }
}

/** A worst-case envelope exceeds one named launch or handoff ceiling. */
export class PreparationBoundsError extends Error {
  constructor(public readonly dimension: string) {
    super(`preparation plan exceeds the ${dimension} ceiling`);
    this.name = "PreparationBoundsError";
  }
}

/**
 * The typed problems raised by plan and manifest validation, in ONE place.
 *
 * Both readers of this list — the manifest loader's retype passthrough and the
 * stage service's refusal allowlist — used to restate it. Two hand-written
 * copies of the same enumeration is exactly the shape that lets a guard and its
 * executor disagree: a class added to one and not the other is retyped by the
 * loader and then rethrown as a fault by the service, or vice versa. The
 * service's list is this one plus the classes only it can see.
 */
export const PREPARATION_VALIDATION_PROBLEMS = [
  PreparationPlanError, PreparationIdentityError, PreparationBoundsError,
] as const;

/** Type-check and prefilter a bounded identity before any scanning primitive. */
function boundedPreparationIdentity(
  value: unknown,
  kind: PreparationIdentityKind,
  maxCodeUnits: number,
): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxCodeUnits) {
    throw new PreparationIdentityError(kind);
  }
  return value;
}

/** Type-check and prefilter one exact-length identity before regex or prefix work. */
export function exactPreparationIdentity(
  value: unknown,
  kind: PreparationIdentityKind,
  exactCodeUnits: number,
): string {
  const bounded = boundedPreparationIdentity(value, kind, exactCodeUnits);
  if (bounded.length !== exactCodeUnits) throw new PreparationIdentityError(kind);
  return bounded;
}
