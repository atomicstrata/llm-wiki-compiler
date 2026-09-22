/**
 * @file src/products/binding/problems.ts
 * @description Typed problems for the active product binding, mirroring
 * {@link ../problems}. `ProductBindingError` is a fail-closed structural refusal
 * of a binding document or of an activation precondition. The two runtime-mode
 * refusals — {@link ProductAuthorityConflictError} and
 * {@link ActiveProductUnavailableError} — are the load-time translations of the
 * design section 8.2 modes: a project holding BOTH an active-product binding and a
 * legacy `profile.json` fails closed with a conflict (neither silently wins), and
 * a present-but-unhealthy binding is unavailable and NEVER falls back to legacy.
 * A rejected caller value never enters a display message.
 */

import { ProductBoundsError, ProductIdentityError } from "../problems.js";

/**
 * A binding document, its component digests, or an activation precondition failed
 * closed structural validation. Distinct from {@link ../problems.ProductPackageError}
 * so a caller can tell a binding refusal from a package refusal.
 */
export class ProductBindingError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProductBindingError";
  }
}

/**
 * A structural refusal raised while ACTIVATING a product (design section 8.3):
 * an unsupported pack schema, an unrecognized required contract pin, an
 * unloadable knowledge profile, or an invalid composition. Missing operational
 * readiness is NOT this class — it is non-blocking setup work.
 */
export class ProductActivationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProductActivationError";
  }
}

/**
 * Both an active-product binding and a legacy `profile.json` are present (design
 * section 8.2). Neither silently wins; an explicit migration must resolve the
 * conflict before the effective profile can load.
 */
export class ProductAuthorityConflictError extends Error {
  constructor() {
    super("product-authority-conflict: active-product.json and profile.json are both present");
    this.name = "ProductAuthorityConflictError";
  }
}

/**
 * A present active-product binding is malformed, unsafe, missing, revoked, or
 * digest-mismatched (design section 8.2). Loading fails closed here and NEVER
 * falls back to legacy mode; the `detail` names the fail-closed reason without
 * echoing a rejected caller value.
 */
export class ActiveProductUnavailableError extends Error {
  constructor(public readonly detail: string) {
    super(`active product binding is unavailable: ${detail}`);
    this.name = "ActiveProductUnavailableError";
  }
}

/**
 * The typed problems that binding parsing may raise, in ONE place. A parser that
 * retypes a rejection from a shared value reader keeps these classes untouched and
 * wraps every other throw as a {@link ProductBindingError}. The reused product
 * identity and bounds classes pass through so a bad digest or id stays typed.
 */
const BINDING_VALIDATION_PROBLEMS = [
  ProductBindingError, ProductIdentityError, ProductBoundsError,
] as const;

/** Retype an untyped rejection from a shared value reader as a binding problem. */
export function asBindingProblem<T>(load: () => T): T {
  try {
    return load();
  } catch (error) {
    if (BINDING_VALIDATION_PROBLEMS.some((problem) => error instanceof problem)) throw error;
    throw new ProductBindingError(
      error instanceof Error ? error.message : "active product binding is invalid", { cause: error });
  }
}
