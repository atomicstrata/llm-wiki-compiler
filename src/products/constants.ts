/**
 * @file src/products/constants.ts
 * @description WOP V3 product-package launch ceilings and closed-grammar length
 * caps (design section 7.5). Byte limits carry a `BYTES` suffix so bounds
 * arithmetic never compares unlike units; count limits name the counted
 * resource. These are the version-one values; a compatibility floor may only
 * lower a cap through a versioned change, never clamp a collection at runtime.
 */

import { parseSha256Digest } from "../capability-providers/ids.js";
import { canonicalDigest } from "../profile/templates/signing/canonical.js";
import type { Sha256Digest } from "../capability-providers/types.js";

const KIBIBYTE_BYTES = 1024;
const MEBIBYTE_BYTES = 1024 * KIBIBYTE_BYTES;
const GIBIBYTE_BYTES = 1024 * MEBIBYTE_BYTES;

/**
 * THE host-pinned safety floor every compiled product action is sealed against.
 *
 * A FIXED, DOMAIN-SEPARATED CONSTANT, because there is no host safety-policy
 * subsystem to resolve one from — exactly the position Milestone A's authority
 * resolver already records for its own `safetyFloorDigest`
 * ({@link ../operation-bundles/operations-authority-resolver}). Naming that fact
 * in the preimage is the honest encoding: the plan states which floor it was
 * compiled under, and the day a real floor exists this constant becomes a
 * resolution and every plan compiled before it is provably distinguishable.
 *
 * IT IS A CONSTANT RATHER THAN A PARAMETER ON PURPOSE. A per-call floor is a
 * value a caller could choose, and the floor is precisely the thing a caller
 * must not be able to lower. The compiler copies it into the plan and derives
 * the run's digests from it, so it is host authority, not host configuration.
 */
export const PRODUCT_SAFETY_FLOOR_DIGEST: Sha256Digest = parseSha256Digest(
  canonicalDigest({ component: "productSafetyFloor", configured: false }),
);

/** Only version-one product packages load through this subsystem. */
export const PRODUCT_PACKAGE_SCHEMA_VERSION = 1;

/** Only version-one runtime-authority preimages are digested. */
export const PRODUCT_RUNTIME_AUTHORITY_SCHEMA_VERSION = 1;

/** Only version-one advisory install receipts are written or read. */
export const PRODUCT_INSTALL_RECEIPT_SCHEMA_VERSION = 1;

// --- Section 7.5 byte ceilings ------------------------------------------

/** Maximum UTF-8 bytes accepted for one product-package manifest document. */
export const MAX_PRODUCT_MANIFEST_BYTES = 1 * MEBIBYTE_BYTES;

/** Maximum bytes in the root operations pack. */
export const MAX_ROOT_OPERATIONS_PACK_BYTES = 4 * MEBIBYTE_BYTES;

/** Maximum bytes in one imported operations pack. */
export const MAX_IMPORTED_OPERATIONS_PACK_BYTES = 4 * MEBIBYTE_BYTES;

/** Maximum bytes in the entire resolved operations-pack graph. */
export const MAX_OPERATIONS_PACK_GRAPH_BYTES = 16 * MEBIBYTE_BYTES;

/** Maximum bytes in one knowledge-profile member. */
export const MAX_KNOWLEDGE_PROFILE_BYTES = 16 * MEBIBYTE_BYTES;

/** Maximum bytes in one composition-lock member. */
export const MAX_COMPOSITION_LOCK_BYTES = 4 * MEBIBYTE_BYTES;

/** Maximum bytes in one canonical product process definition. */
export const MAX_PROCESS_DEFINITION_BYTES = 1 * MEBIBYTE_BYTES;

/** Maximum bytes in one interaction resource. */
export const MAX_INTERACTION_RESOURCE_BYTES = 2 * MEBIBYTE_BYTES;

/** Maximum bytes across all interaction resources. */
export const MAX_ALL_INTERACTION_RESOURCES_BYTES = 32 * MEBIBYTE_BYTES;

/** Maximum bytes in the parity ledger. */
export const MAX_PARITY_LEDGER_BYTES = 16 * MEBIBYTE_BYTES;

/** Maximum bytes in one parity-fixture declaration. */
export const MAX_PARITY_FIXTURE_BYTES = 2 * MEBIBYTE_BYTES;

/** Maximum bytes in one documentation member. */
export const MAX_DOCUMENTATION_MEMBER_BYTES = 4 * MEBIBYTE_BYTES;

/** Maximum bytes across all declarative package members. */
export const MAX_ALL_DECLARATIVE_MEMBER_BYTES = 128 * MEBIBYTE_BYTES;

// --- Section 7.5 count and store ceilings -------------------------------

/** Maximum members declared in one product package's complete member table. */
export const MAX_PACKAGE_MEMBERS = 4_096;

/** Maximum interaction-resource members in one package. */
export const MAX_INTERACTION_RESOURCE_MEMBERS = 1_024;

/** Maximum provider pins declared in one package. */
export const MAX_PROVIDER_PINS = 1_024;

/** Maximum experience surfaces declared in one package. */
export const MAX_SUPPORTED_SURFACES = 1_024;

/** Maximum normalized locale tags declared in one package. */
export const MAX_SUPPORTED_LOCALES = 512;

/** Maximum runtime rows declared in one compatibility contract. */
export const MAX_COMPATIBILITY_RUNTIMES = 256;

/** Maximum agent-host rows declared in one compatibility contract. */
export const MAX_COMPATIBILITY_HOSTS = 256;

/** Maximum required-feature ids declared in one compatibility contract. */
export const MAX_COMPATIBILITY_FEATURES = 256;

/** Maximum unsupported-combination rows declared in one compatibility contract. */
export const MAX_COMPATIBILITY_UNSUPPORTED = 256;

/** Maximum required sandbox-backend classes declared in one compatibility contract. */
export const MAX_COMPATIBILITY_SANDBOX_BACKENDS = 256;

/** Maximum compatible knowledge or workspace import modes declared per dimension. */
export const MAX_COMPATIBILITY_IMPORT_MODES = 256;

/** Maximum installed product packages retained per project. */
export const MAX_INSTALLED_PACKAGES_PER_PROJECT = 32;

/** Maximum total product-package store bytes, including partial and orphan bytes. */
export const MAX_PRODUCT_PACKAGE_STORE_BYTES = 2 * GIBIBYTE_BYTES;

/** Maximum UTF-8 bytes accepted when reading one advisory install receipt leaf. */
export const MAX_PRODUCT_INSTALL_RECEIPT_BYTES = 64 * KIBIBYTE_BYTES;

// --- Section 7.1/7.2 closed-grammar length caps -------------------------

/** Maximum UTF-8 bytes in one product id. */
export const MAX_PRODUCT_ID_BYTES = 128;
/** Maximum UTF-8 bytes in one package member id. */
export const MAX_MEMBER_ID_BYTES = 128;
/** Maximum UTF-8 bytes in one experience-surface id. */
export const MAX_SURFACE_ID_BYTES = 64;
/** Maximum UTF-8 bytes in one agent-host id. */
export const MAX_HOST_ID_BYTES = 64;
/** Maximum UTF-8 bytes in one normalized locale tag. */
export const MAX_LOCALE_ID_BYTES = 35;
/** Maximum UTF-8 bytes in one semantic version string. */
export const MAX_VERSION_BYTES = 64;
/** Maximum UTF-8 bytes in one display name or publisher string. */
export const MAX_DISPLAY_TEXT_BYTES = 256;
/** Maximum UTF-8 bytes in one stable reason code or feature id. */
export const MAX_REASON_CODE_BYTES = 64;
