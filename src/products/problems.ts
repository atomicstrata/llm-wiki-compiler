/**
 * @file src/products/problems.ts
 * @description Typed identity, parse, and bounds errors raised while loading a
 * product package before any durable store path is trusted. Errors carry a
 * bounded, project-relative label; a rejected caller value never enters a
 * display message. Every rejection leaves this loader as one of these classes so
 * an install caller can distinguish a refusal from a host fault.
 */

/** Closed identity kinds used in fixed refusal messages. */
export type ProductIdentityKind =
  | "product-id"
  | "member-id"
  | "surface-id"
  | "host-id"
  | "locale-id"
  | "version"
  | "coordinate"
  | "reason-code"
  | "digest"
  | "media-type"
  | "package-directory";

/** Fixed display labels; rejected caller values never enter this mapping. */
const PRODUCT_IDENTITY_LABELS: Readonly<Record<ProductIdentityKind, string>> = {
  "product-id": "product id",
  "member-id": "package member id",
  "surface-id": "experience surface id",
  "host-id": "agent host id",
  "locale-id": "locale tag",
  version: "version",
  coordinate: "provider coordinate",
  "reason-code": "reason code",
  digest: "content digest",
  "media-type": "member media type",
  "package-directory": "package directory name",
};

/** A caller-supplied identity cannot safely name a product-package object. */
export class ProductIdentityError extends Error {
  constructor(public readonly kind: ProductIdentityKind) {
    super(`unsafe product ${PRODUCT_IDENTITY_LABELS[kind] ?? "identity"}`);
    this.name = "ProductIdentityError";
  }
}

/** A product manifest, member, or digest failed closed structural validation. */
export class ProductPackageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProductPackageError";
  }
}

/** A worst-case envelope exceeds one named product-package launch ceiling. */
export class ProductBoundsError extends Error {
  constructor(public readonly dimension: string) {
    super(`product package exceeds the ${dimension} ceiling`);
    this.name = "ProductBoundsError";
  }
}

/**
 * The typed problems raised by product-package validation, in ONE place. A
 * loader that retypes a rejection from a shared value reader keeps these classes
 * untouched and wraps every other throw as a {@link ProductPackageError}.
 */
const PRODUCT_VALIDATION_PROBLEMS = [
  ProductPackageError, ProductIdentityError, ProductBoundsError,
] as const;

/** Retype an untyped rejection from a shared value reader as a product problem. */
export function asProductProblem<T>(load: () => T): T {
  try {
    return load();
  } catch (error) {
    if (PRODUCT_VALIDATION_PROBLEMS.some((problem) => error instanceof problem)) throw error;
    throw new ProductPackageError(
      error instanceof Error ? error.message : "product package is invalid", { cause: error });
  }
}
