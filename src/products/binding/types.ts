/**
 * @file src/products/binding/types.ts
 * @description Closed, data-only value objects for the WOP V3 active product
 * binding (design section 8.1). The binding is ONE atomic authority pointer: it
 * names the exact installed package and repeats every runtime component digest
 * for fail-closed diagnostics, and it carries NO grants, credentials, mutable
 * settings, migration approval, provider cache paths, or display-derived
 * identifiers. Every digest reuses the repository's branded {@link Sha256Digest}
 * so a mistyped hash cannot flow past the parser. The principal reference records
 * WHO activated the binding for audit, never an authority to act.
 */

import type { OperationPrincipalSurface } from "../../operation-bundles/principal.js";
import type { Sha256Digest } from "../ids.js";

export type { Sha256Digest } from "../ids.js";

/** Only version-one active product bindings are written or read. */
export const ACTIVE_PRODUCT_BINDING_SCHEMA_VERSION = 1 as const;

/** Maximum UTF-8 bytes accepted when reading one active-product binding leaf. */
export const MAX_ACTIVE_PRODUCT_BINDING_BYTES = 64 * 1024;

/**
 * A minimal, transport-independent record of the principal that activated a
 * binding (design section 8.1). It is AUDIT identity only — an id and the surface
 * it acted through — and deliberately carries no grants or credentials, so a
 * binding can never smuggle authority to act. The surface literal set mirrors the
 * operation principal contract's {@link OperationPrincipalSurface}.
 */
export interface PrincipalRefV1 {
  id: string;
  surface: OperationPrincipalSurface;
}

/**
 * The immutable version-one active product binding (design section 8.1). Its
 * component digests are repeated for fail-closed diagnostics and MUST match the
 * product manifest exactly:
 *   - `packageDigest`, `runtimeAuthorityDigest` equal the manifest's own fields;
 *   - `productManifestDigest` is `canonicalDigest` of the whole canonical manifest;
 *   - `knowledgeProfileDigest`, `operationsPackDigest`, `compositionLockDigest`,
 *     and `parityLedgerDigest` equal the corresponding member reference digests.
 * `parityCertificateDigest` is OPTIONAL detached evidence: it is never part of
 * `runtimeAuthorityDigest`, cannot authorize an action, and certificate bundle
 * resolution is deferred to a later slice.
 */
export interface ActiveProductBindingV1 {
  schemaVersion: typeof ACTIVE_PRODUCT_BINDING_SCHEMA_VERSION;
  productId: string;
  productVersion: string;
  packageDigest: Sha256Digest;
  runtimeAuthorityDigest: Sha256Digest;
  productManifestDigest: Sha256Digest;
  knowledgeProfileDigest: Sha256Digest;
  operationsPackDigest: Sha256Digest;
  compositionLockDigest: Sha256Digest;
  /** Optional process descriptor digest repeated from runtime authority. */
  processDefinitionDigest?: Sha256Digest;
  parityLedgerDigest: Sha256Digest;
  parityCertificateDigest?: Sha256Digest;
  activatedAt: string;
  activatedBy: PrincipalRefV1;
}
