/**
 * @file src/products/binding/parse.ts
 * @description Bounded, duplicate-key-free structural loader for the immutable
 * version-one active product binding (design section 8.1), mirroring
 * {@link ../packages/protocol} conventions. It rebuilds an allowlisted record
 * through the shared canonical-JSON unique-key parser, rejects unknown and missing
 * fields, holds every caller-influenced identity to its closed grammar, and fails
 * closed. It proves SHAPE only: that the binding's component digests match the
 * product manifest, and that the named package resolves, are the resolver's job.
 */

import {
  enumValue, exact, record, textValue,
} from "../../operation-bundles/manifest-values.js";
import { OPERATION_PRINCIPAL_SURFACES } from "../../operation-bundles/principal.js";
import { parseBoundedUniqueJson } from "../../profile/templates/signing/json.js";
import { assertProductDigest, assertProductId, assertVersion } from "../ids.js";
import {
  ACTIVE_PRODUCT_BINDING_SCHEMA_VERSION, MAX_ACTIVE_PRODUCT_BINDING_BYTES,
} from "./types.js";
import type { ActiveProductBindingV1, PrincipalRefV1 } from "./types.js";
import { asBindingProblem, ProductBindingError } from "./problems.js";

/** The maximum UTF-8 bytes a principal id string may carry. */
const MAX_PRINCIPAL_ID_BYTES = 256;

const TOP_REQUIRED = [
  "schemaVersion", "productId", "productVersion", "packageDigest", "runtimeAuthorityDigest",
  "productManifestDigest", "knowledgeProfileDigest", "operationsPackDigest", "compositionLockDigest",
  "parityLedgerDigest", "activatedAt", "activatedBy",
] as const;
const TOP_OPTIONAL = ["parityCertificateDigest", "processDefinitionDigest"] as const;
const PRINCIPAL_KEYS = ["id", "surface"] as const;

/** The component-digest fields rebuilt uniformly through the shared digest grammar. */
const COMPONENT_DIGEST_FIELDS = [
  "packageDigest", "runtimeAuthorityDigest", "productManifestDigest", "knowledgeProfileDigest",
  "operationsPackDigest", "compositionLockDigest", "parityLedgerDigest",
] as const;

/** Rebuild one audit principal reference: a bounded id and a closed surface. */
function parsePrincipal(value: unknown): PrincipalRefV1 {
  const node = record(value, "activatedBy");
  exact(node, PRINCIPAL_KEYS);
  return {
    id: textValue(node.id, "activatedBy.id", MAX_PRINCIPAL_ID_BYTES),
    surface: enumValue(node.surface, OPERATION_PRINCIPAL_SURFACES, "activatedBy.surface"),
  };
}

/** Parse one exact millisecond UTC timestamp for the activation instant. */
function parseActivatedAt(value: unknown): string {
  const text = textValue(value, "activatedAt");
  if (!Number.isFinite(Date.parse(text)) || new Date(text).toISOString() !== text) {
    throw new ProductBindingError("activatedAt must be a canonical ISO timestamp");
  }
  return text;
}

/** Rebuild the seven required component digests as one exact record fragment. */
function parseComponentDigests(
  root: Record<string, unknown>,
): Pick<ActiveProductBindingV1, (typeof COMPONENT_DIGEST_FIELDS)[number]> {
  return {
    packageDigest: assertProductDigest(root.packageDigest),
    runtimeAuthorityDigest: assertProductDigest(root.runtimeAuthorityDigest),
    productManifestDigest: assertProductDigest(root.productManifestDigest),
    knowledgeProfileDigest: assertProductDigest(root.knowledgeProfileDigest),
    operationsPackDigest: assertProductDigest(root.operationsPackDigest),
    compositionLockDigest: assertProductDigest(root.compositionLockDigest),
    parityLedgerDigest: assertProductDigest(root.parityLedgerDigest),
  };
}

/** Add the optional process-definition authority digest when it is present. */
function withProcessDigest(binding: ActiveProductBindingV1, value: unknown): ActiveProductBindingV1 {
  return value === undefined ? binding : { ...binding, processDefinitionDigest: assertProductDigest(value) };
}

/** Rebuild and structurally validate one complete version-one active binding. */
export function parseActiveProductBinding(text: string): ActiveProductBindingV1 {
  return asBindingProblem(() => {
    const root = record(parseBoundedUniqueJson(text, MAX_ACTIVE_PRODUCT_BINDING_BYTES), "active product binding");
    exact(root, TOP_REQUIRED, TOP_OPTIONAL);
    if (root.schemaVersion !== ACTIVE_PRODUCT_BINDING_SCHEMA_VERSION) {
      throw new ProductBindingError("active product binding schemaVersion must be 1");
    }
    const binding: ActiveProductBindingV1 = {
      schemaVersion: ACTIVE_PRODUCT_BINDING_SCHEMA_VERSION,
      productId: assertProductId(root.productId),
      productVersion: assertVersion(root.productVersion),
      ...parseComponentDigests(root),
      activatedAt: parseActivatedAt(root.activatedAt),
      activatedBy: parsePrincipal(root.activatedBy),
    };
    const withProcess = withProcessDigest(binding, root.processDefinitionDigest);
    return root.parityCertificateDigest === undefined
      ? withProcess
      : { ...withProcess, parityCertificateDigest: assertProductDigest(root.parityCertificateDigest) };
  });
}
