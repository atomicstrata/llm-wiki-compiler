/**
 * @file src/products/ids.ts
 * @description Closed grammars, length caps, and digest handling for every
 * caller-influenced product-package identity (design sections 7.1, 7.2). Product
 * identity is validated here, never inferred from directories or display names.
 * A digest is the exact string `sha256:` followed by 64 lowercase hex
 * characters; a digest-derived directory name is only that 64-hex suffix. Every
 * grammar is total and fails closed so an unsafe id never reaches a path join or
 * a canonical digest preimage.
 */

import { Buffer } from "node:buffer";
import type { Sha256Digest } from "../capability-providers/types.js";
import {
  MAX_HOST_ID_BYTES, MAX_LOCALE_ID_BYTES, MAX_MEMBER_ID_BYTES,
  MAX_PRODUCT_ID_BYTES, MAX_REASON_CODE_BYTES, MAX_SURFACE_ID_BYTES, MAX_VERSION_BYTES,
} from "./constants.js";
import { ProductIdentityError, type ProductIdentityKind } from "./problems.js";
import type { PackageMemberKind } from "./types.js";

export type { Sha256Digest } from "../capability-providers/types.js";

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const DIGEST_CODE_UNITS = 71;
const DIGEST_HEX = /^[0-9a-f]{64}$/;
const PRODUCT_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const MEMBER_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const SURFACE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HOST_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const SEMANTIC_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const REASON_CODE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LOCALE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

/** Require a bounded string matching one closed grammar or fail closed. */
function assertGrammar(value: unknown, kind: ProductIdentityKind, pattern: RegExp, maxBytes: number): string {
  if (typeof value !== "string" || value.length === 0
    || Buffer.byteLength(value, "utf8") > maxBytes || !pattern.test(value)) {
    throw new ProductIdentityError(kind);
  }
  return value;
}

/** Validate and brand one canonical `sha256:`-prefixed lowercase digest. */
export function assertProductDigest(value: unknown): Sha256Digest {
  if (typeof value !== "string" || value.length !== DIGEST_CODE_UNITS || !DIGEST.test(value)) {
    throw new ProductIdentityError("digest");
  }
  return value as Sha256Digest;
}

/** Return the 64-hex suffix a digest-derived directory name uses. */
export function digestDirectoryName(digest: Sha256Digest): string {
  return digest.slice("sha256:".length);
}

/** Validate one 64-hex content-addressed directory or file component. */
export function assertDigestHex(value: unknown): string {
  if (typeof value !== "string" || !DIGEST_HEX.test(value)) {
    throw new ProductIdentityError("package-directory");
  }
  return value;
}

/** Validate one product id against its closed grammar and length cap. */
export function assertProductId(value: unknown): string {
  return assertGrammar(value, "product-id", PRODUCT_ID, MAX_PRODUCT_ID_BYTES);
}

/** Validate one package member id against its closed grammar and length cap. */
export function assertMemberId(value: unknown): string {
  return assertGrammar(value, "member-id", MEMBER_ID, MAX_MEMBER_ID_BYTES);
}

/** Validate one experience-surface id against its closed grammar and length cap. */
export function assertSurfaceId(value: unknown): string {
  return assertGrammar(value, "surface-id", SURFACE_ID, MAX_SURFACE_ID_BYTES);
}

/** Validate one agent-host id against its closed grammar and length cap. */
export function assertHostId(value: unknown): string {
  return assertGrammar(value, "host-id", HOST_ID, MAX_HOST_ID_BYTES);
}

/** Validate one exact semantic version, never a range or moving tag. */
export function assertVersion(value: unknown): string {
  return assertGrammar(value, "version", SEMANTIC_VERSION, MAX_VERSION_BYTES);
}

/** Validate one stable reason code or required-feature id. */
export function assertReasonCode(value: unknown): string {
  return assertGrammar(value, "reason-code", REASON_CODE, MAX_REASON_CODE_BYTES);
}

/** Titlecase one four-letter script subtag; other subtags pass through. */
function normalizeSubtag(subtag: string, index: number): string {
  if (index === 0) return subtag.toLowerCase();
  if (/^[A-Za-z]{4}$/.test(subtag)) return subtag[0]!.toUpperCase() + subtag.slice(1).toLowerCase();
  if (/^[A-Za-z]{2}$/.test(subtag)) return subtag.toUpperCase();
  return subtag.toLowerCase();
}

/**
 * Validate one BCP-47-style locale tag and require it already be in normalized
 * form (lowercase language, titlecase script, uppercase region). A tag that is
 * not its own normalization fails closed so uniqueness and lexicographic sort
 * over the supported set are deterministic.
 */
export function assertLocale(value: unknown): string {
  const tag = assertGrammar(value, "locale-id", LOCALE, MAX_LOCALE_ID_BYTES);
  const normalized = tag.split("-").map(normalizeSubtag).join("-");
  if (normalized !== tag) throw new ProductIdentityError("locale-id");
  return tag;
}

/** The immutable-data media types each member kind may declare. */
const ALLOWED_MEMBER_MEDIA_TYPES: Readonly<Record<PackageMemberKind, readonly string[]>> = {
  "knowledge-profile": ["application/json"],
  "operations-pack": ["application/json"],
  "composition-lock": ["application/json"],
  "interaction-resource": ["application/json", "text/markdown", "text/plain"],
  "parity-ledger": ["application/json"],
  "parity-fixture": ["application/json"],
  "process-definition": ["application/json"],
  documentation: ["text/markdown", "text/plain"],
};

/**
 * Require one member media type from the per-kind allowlist. Executable media,
 * archives, native libraries, package-manager metadata, install scripts, and
 * provider binaries are outside every allowlist and therefore fail closed.
 */
export function assertMemberMediaType(kind: PackageMemberKind, mediaType: unknown): string {
  const allowed = ALLOWED_MEMBER_MEDIA_TYPES[kind];
  if (typeof mediaType !== "string" || !allowed.includes(mediaType)) {
    throw new ProductIdentityError("media-type");
  }
  return mediaType;
}
