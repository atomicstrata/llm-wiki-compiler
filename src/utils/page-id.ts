/**
 * Qualified page-id grammar helpers.
 *
 * A `PageId` is a `<namespace>/<page-part>` string that uniquely addresses a
 * wiki page across all namespaces (concepts, queries, and any declared entity
 * type). The grammar splits on the FIRST `/` only.
 *
 * ## Namespace rules
 * - Must be slug-safe: `^[a-z0-9][a-z0-9-]*$` (same as entity-type ids).
 * - Reserved namespaces are `concepts` and `queries` (the DEFAULT wiki dirs).
 *
 * ## Page-part rules
 * - Non-empty and not `.` or `..`.
 * - Must NOT contain `/`, `\`, `:`, or NUL — all path-dangerous.
 * - MAY contain spaces, Unicode, and `#` (raw DEFAULT stems preserve these).
 *
 * ## Relation to EntityId
 * A typed `EntityId` (`<entityType>/<slug>`, from `src/profile/identity.ts`)
 * is structurally a `PageId` with a slug-safe page-part (a slug). The
 * `parseEntityId` / `entityId` helpers from identity.ts are the narrower
 * surface for fully-slug-safe entity pages; `parseQualifiedPageId` is the
 * wider gate that also accepts raw DEFAULT stems (spaces, Unicode, `#`).
 */

/**
 * A qualified page identity: `<namespace>/<page-part>`.
 *
 * The namespace is slug-safe (`^[a-z0-9][a-z0-9-]*$`). The page-part may
 * contain spaces, Unicode, and `#` but not `/`, `\`, `:`, or NUL.
 * Split on the FIRST `/` only — use {@link parseQualifiedPageId} to
 * decompose and validate.
 */
export type PageId = string;

import path from "path";
import { isSlugSafe } from "../profile/identity.js";
import { CONCEPTS_DIR, QUERIES_DIR } from "./constants.js";

/** Reserved namespace names derived from the DEFAULT wiki directory paths. */
const RESERVED_NAMESPACES: ReadonlySet<string> = new Set([
  path.basename(CONCEPTS_DIR),
  path.basename(QUERIES_DIR),
]);

/** Characters that make a page-part path-dangerous. */
const DANGEROUS_PAGE_PART_PATTERN = /[/\\:\0]/;

/** Validate a page-part: non-empty, not dot-only, no dangerous characters. */
function isValidPagePart(pagePart: string): boolean {
  if (pagePart.length === 0) return false;
  if (pagePart === "." || pagePart === "..") return false;
  return !DANGEROUS_PAGE_PART_PATTERN.test(pagePart);
}

/**
 * Parse a qualified `<namespace>/<page-part>` id into its two halves.
 *
 * Returns `null` if the id is malformed: no slash, non-slug-safe namespace,
 * or a page-part that is empty / dot-only / contains path-dangerous chars.
 * A second `/` in the page-part is rejected (page-parts are single-segment).
 *
 * @param pageId - The raw qualified page id string.
 * @returns Parsed parts or `null` on any grammar violation.
 */
export function parseQualifiedPageId(pageId: string): { namespace: string; pagePart: string } | null {
  const firstSlash = pageId.indexOf("/");
  if (firstSlash < 0) return null;

  const namespace = pageId.slice(0, firstSlash);
  const pagePart = pageId.slice(firstSlash + 1);

  if (!isSlugSafe(namespace)) return null;
  if (!isValidPagePart(pagePart)) return null;

  return { namespace, pagePart };
}

/**
 * Build a qualified page id from a namespace and page-part.
 *
 * Does NOT validate inputs — callers must ensure both halves are valid, or
 * round-trip through {@link parseQualifiedPageId} to verify.
 *
 * @param namespace - Slug-safe namespace (e.g. `"concepts"`, `"papers"`).
 * @param pagePart - Raw page part (stem or slug); must not contain `/\:\0`.
 * @returns The concatenated `<namespace>/<pagePart>` string.
 */
export function qualifiedPageId(namespace: string, pagePart: string): string {
  return `${namespace}/${pagePart}`;
}

/**
 * Extract the namespace (directory) component from a valid qualified page id.
 *
 * Returns the namespace string, or `""` if the id has no slash (defensive
 * fallback — prefer validating with {@link parseQualifiedPageId} first).
 *
 * @param pageId - A valid qualified page id.
 * @returns The namespace portion before the first `/`.
 */
export function pageDirectoryFromPageId(pageId: string): string {
  return parseQualifiedPageId(pageId)?.namespace ?? "";
}

/**
 * Extract the page-part (stem or slug) from a valid qualified page id.
 *
 * Returns the page-part string, or `""` if the id is malformed (defensive
 * fallback — prefer validating with {@link parseQualifiedPageId} first).
 *
 * @param pageId - A valid qualified page id.
 * @returns The page-part portion after the first `/`.
 */
export function slugFromPageId(pageId: string): string {
  return parseQualifiedPageId(pageId)?.pagePart ?? "";
}

/**
 * Check whether a namespace is a reserved DEFAULT wiki namespace.
 *
 * The reserved set is `concepts` and `queries` — the basenames of
 * {@link CONCEPTS_DIR} and {@link QUERIES_DIR} from `constants.ts`.
 *
 * @param ns - The namespace string to test.
 * @returns `true` if `ns` is `"concepts"` or `"queries"`.
 */
export function isReservedNamespace(ns: string): boolean {
  return RESERVED_NAMESPACES.has(ns);
}
