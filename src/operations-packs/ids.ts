/**
 * @file src/operations-packs/ids.ts
 * @description Closed grammars, length caps, and digest handling for every
 * caller-influenced operations-pack identity (design sections 10, 14.1, 15.1,
 * 19.1), mirroring {@link ../products/ids}. Identity is validated here, never
 * inferred. Action and recipe ids are qualified dotted ids whose every segment
 * is slug-safe; alias ids, tokens, and role ids are single slugs; references are
 * dotted-optional slugs. Every grammar is total and fails closed so an unsafe id
 * never reaches a canonical digest preimage or an export-table key. A digest is
 * the exact string `sha256:` followed by 64 lowercase hex characters.
 */

import { Buffer } from "node:buffer";
import type { Sha256Digest } from "../capability-providers/types.js";
import {
  MAX_MESSAGE_KEY_BYTES, MAX_PACK_ID_BYTES, MAX_QUALIFIED_ID_BYTES,
  MAX_REF_ID_BYTES, MAX_SLUG_ID_BYTES, RESERVED_IDENTIFIERS,
} from "./constants.js";
import { PackIdentityError, type PackIdentityKind } from "./problems.js";

export type { Sha256Digest } from "../capability-providers/types.js";

const MAX_VERSION_BYTES = 64;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const PACK_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const SLUG_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/**
 * A PAGE frontmatter key a field mapping may target: an existing slug, or a
 * lower-camelCase declared profile field (`resultSummary`).
 *
 * Profile entity fields are camelCase by convention, and a slug-only target
 * grammar cannot name them — so a pack could not write, and therefore could not
 * PRESERVE, any camelCase field. A whole-page replace silently drops what it
 * cannot name, so that gap turns a legal page into one no recipe can round-trip.
 * Deliberately still closed: no dots, brackets, spaces, path separators, or an
 * uppercase leading character — this names one frontmatter key, never a path
 * into a nested structure.
 */
const PAGE_FIELD_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$|^[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)*$/;
const QUALIFIED_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/;
const REF_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)*$/;
const MESSAGE_KEY = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const SEMANTIC_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Require a bounded string matching one closed grammar or fail closed. */
function assertGrammar(value: unknown, kind: PackIdentityKind, pattern: RegExp, maxBytes: number): string {
  if (typeof value !== "string" || value.length === 0
    || Buffer.byteLength(value, "utf8") > maxBytes || !pattern.test(value)) {
    throw new PackIdentityError(kind);
  }
  return value;
}

/** The first dotted segment of a qualified id, used for reserved-word checks. */
function firstSegment(id: string): string {
  return id.slice(0, id.indexOf(".") === -1 ? id.length : id.indexOf("."));
}

/**
 * Reject a qualified id whose first segment or full text is a reserved core,
 * recovery, or review verb (section 14.1). A qualified id shadowing generic
 * dispatch is refused before it can reach the export table.
 */
function assertNotReserved(id: string, kind: PackIdentityKind): string {
  if (RESERVED_IDENTIFIERS.has(id) || RESERVED_IDENTIFIERS.has(firstSegment(id))) {
    throw new PackIdentityError(kind);
  }
  return id;
}

/** Validate and brand one canonical `sha256:`-prefixed lowercase digest. */
export function assertPackDigest(value: unknown): Sha256Digest {
  if (typeof value !== "string" || !DIGEST.test(value)) throw new PackIdentityError("digest");
  return value as Sha256Digest;
}

/** Validate one pack id against its closed grammar and length cap. */
export function assertPackId(value: unknown): string {
  return assertGrammar(value, "pack-id", PACK_ID, MAX_PACK_ID_BYTES);
}

/** Validate one qualified dotted action id and reject reserved collisions. */
export function assertActionId(value: unknown): string {
  return assertNotReserved(assertGrammar(value, "action-id", QUALIFIED_ID, MAX_QUALIFIED_ID_BYTES), "action-id");
}

/** Validate one qualified dotted recipe id and reject reserved collisions. */
export function assertRecipeId(value: unknown): string {
  return assertNotReserved(assertGrammar(value, "recipe-id", QUALIFIED_ID, MAX_QUALIFIED_ID_BYTES), "recipe-id");
}

/** Validate one alias id and reject reserved collisions. */
export function assertAliasId(value: unknown): string {
  return assertNotReserved(assertGrammar(value, "alias-id", SLUG_ID, MAX_SLUG_ID_BYTES), "alias-id");
}

/** Validate one alias invocation token and reject core-command collisions. */
export function assertToken(value: unknown): string {
  return assertNotReserved(assertGrammar(value, "token", SLUG_ID, MAX_SLUG_ID_BYTES), "token");
}

/** Validate one provider capability role id. */
export function assertRoleId(value: unknown): string {
  return assertGrammar(value, "role-id", SLUG_ID, MAX_SLUG_ID_BYTES);
}

/** Validate one generic slug identifier (setting field, tag, gate, format). */
export function assertSlug(value: unknown): string {
  return assertGrammar(value, "slug", SLUG_ID, MAX_SLUG_ID_BYTES);
}

/**
 * Names the pipeline OVERWRITES on an evidence item after projection, so a
 * mapping targeting one would have its authored value silently replaced —
 * reconcile overlays its verdict on `finding-class`, and the store snapshot
 * carries the page's own digest/byte-count as the update precondition. Literals
 * (not imports) to keep this module free of runtime dependencies; the negative
 * sweep pins them against their defining constants.
 */
const RESERVED_PAGE_FIELD_NAMES: ReadonlySet<string> = new Set([
  "finding-class", "current-digest", "current-byte-count",
]);

/**
 * Validate one PAGE field-mapping target: a slug, or a lower-camelCase profile
 * field name, and never a name the pipeline itself writes. Used ONLY where the
 * target becomes a page frontmatter key — relation mappings and every
 * structural key stay on {@link assertSlug}, whose slug-safety the relation
 * draft vocabulary depends on.
 */
export function assertPageFieldName(value: unknown): string {
  const name = assertGrammar(value, "page-field-name", PAGE_FIELD_NAME, MAX_SLUG_ID_BYTES);
  if (RESERVED_PAGE_FIELD_NAMES.has(name)) throw new PackIdentityError("page-field-name");
  return name;
}

/**
 * Validate one slug that must NOT be a name the pipeline itself writes. Used
 * for a mapping's source ref: reconcile restores the snapshot's digest fields
 * and overlays its verdict, so a ref naming one reads the pipeline's value.
 */
export function assertUnreservedSlug(value: unknown): string {
  const name = assertSlug(value);
  if (RESERVED_PAGE_FIELD_NAMES.has(name)) throw new PackIdentityError("slug");
  return name;
}

/** True when a name is a plain slug — the vocabulary a relation draft requires. */
export function isSlugName(value: string): boolean {
  return SLUG_ID.test(value);
}

/** Validate one dotted-optional reference id (recipe/flow/output/rule ref). */
export function assertRefId(value: unknown): string {
  return assertGrammar(value, "ref-id", REF_ID, MAX_REF_ID_BYTES);
}

/** Validate one localized message key (label, summary, guided presentation). */
export function assertMessageKey(value: unknown): string {
  return assertGrammar(value, "message-key", MESSAGE_KEY, MAX_MESSAGE_KEY_BYTES);
}

/** Validate one exact semantic version, never a range or moving tag. */
export function assertPackVersion(value: unknown): string {
  return assertGrammar(value, "version", SEMANTIC_VERSION, MAX_VERSION_BYTES);
}
