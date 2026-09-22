/**
 * @file src/operations-packs/problems.ts
 * @description Typed identity, parse, and composition errors raised while loading
 * and composing an operations pack, mirroring {@link ../products/problems}. A
 * rejected caller value never enters a display message: identity errors carry a
 * closed kind, structural errors a fixed reason. Every rejection leaves this
 * subsystem as one of these classes so a caller distinguishes a fail-closed
 * refusal from a host fault, and {@link asPackProblem} retypes any untyped throw
 * from a shared value reader without swallowing an already-typed refusal.
 */

/** Closed identity kinds used in fixed refusal messages. */
export type PackIdentityKind =
  | "pack-id"
  | "action-id"
  | "recipe-id"
  | "alias-id"
  | "token"
  | "role-id"
  | "ref-id"
  | "slug"
  | "page-field-name"
  | "message-key"
  | "version"
  | "digest";

/** Fixed display labels; rejected caller values never enter this mapping. */
const PACK_IDENTITY_LABELS: Readonly<Record<PackIdentityKind, string>> = {
  "pack-id": "pack id",
  "action-id": "action id",
  "recipe-id": "recipe id",
  "alias-id": "alias id",
  "page-field-name": "page field name",
  token: "alias token",
  "role-id": "provider role id",
  "ref-id": "reference id",
  slug: "identifier",
  "message-key": "message key",
  version: "version",
  digest: "content digest",
};

/** A caller-supplied identity cannot safely name an operations-pack object. */
export class PackIdentityError extends Error {
  constructor(public readonly kind: PackIdentityKind) {
    super(`unsafe operations-pack ${PACK_IDENTITY_LABELS[kind] ?? "identity"}`);
    this.name = "PackIdentityError";
  }
}

/** An operations pack failed closed structural validation or cross-reference. */
export class PackParseError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PackParseError";
  }
}

/**
 * A feature this slice deliberately does not implement was declared. The pack is
 * refused rather than under-parsed: the field is known, so the refusal is
 * distinct from an unknown-field rejection and names the deferred authority.
 */
export class PackDeferredError extends Error {
  constructor(public readonly feature: string) {
    super(`operations-pack feature deferred: ${feature}`);
    this.name = "PackDeferredError";
  }
}

/**
 * A durable run cannot support the ONE Milestone A obligation its compiled
 * action promised: the terminal phase published no evidence, the evidence is not
 * the intent family's own result shape, it declares no drafts at all, or a draft
 * names a mutation kind no complete create mutation can be authored from without
 * inventing a post-apply field. Raised rather than emitting an obligation the run
 * did not earn; the runner projects it as a typed `refused`.
 */
export class PackMaterializationError extends Error {
  constructor(message: string) {
    super(`pack materialization: ${message}`);
    this.name = "PackMaterializationError";
  }
}

/** A supplied composition lock disagrees with the independently recomputed graph. */
export class CompositionLockError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CompositionLockError";
  }
}

/**
 * The typed problems raised by operations-pack validation, in ONE place. A parser
 * that retypes a rejection from a shared value reader keeps these classes
 * untouched and wraps every other throw as a {@link PackParseError}.
 */
const PACK_VALIDATION_PROBLEMS = [
  PackParseError, PackIdentityError, PackDeferredError, CompositionLockError,
] as const;

/** Retype an untyped rejection from a shared value reader as a pack problem. */
export function asPackProblem<T>(load: () => T): T {
  try {
    return load();
  } catch (error) {
    if (PACK_VALIDATION_PROBLEMS.some((problem) => error instanceof problem)) throw error;
    throw new PackParseError(
      error instanceof Error ? error.message : "operations pack is invalid", { cause: error });
  }
}
