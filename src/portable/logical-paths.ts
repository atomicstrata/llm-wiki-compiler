/**
 * @file src/portable/logical-paths.ts
 * @description The closed set of logical namespaces a portable project has, and
 * the rules a logical path must satisfy before any adapter sees it.
 *
 * A logical path names an object, not a file. Only the disk adapter turns one
 * into a filesystem location, and it maps the curated namespaces onto today's
 * layout unchanged. Proposals and approvals are separate namespaces that map to
 * a directory the legacy review commands never read.
 */

import { PortableRefusal } from "./errors.js";

/** Curated source text. */
export const SOURCES_PREFIX = "sources/";
/** Curated concept pages. */
export const CONCEPTS_PREFIX = "wiki/concepts/";
/** The wiki index the extraction prompt reads as context. */
export const INDEX_PATH = "wiki/index.md";
/** The Map of Content. */
export const MOC_PATH = "wiki/MOC.md";
/** Saved-query pages. */
export const QUERIES_PREFIX = "wiki/queries/";
/** Incremental compile state. */
export const STATE_PATH = "meta/state";
/**
 * Format-2 state-custody evidence (S2b): which canonical `state.json` entries
 * were observed at adoption and which scoped applies established completion.
 * Provenance and loss detection only — never a second source-state home.
 */
export const STATE_CUSTODY_PATH = "meta/state-custody";
/** Project configuration (review policy, source selection). */
export const CONFIG_PATH = "meta/config";
/** A configured CLP profile. The prototype compile refuses a project that has one. */
export const PROFILE_PATH = "meta/profile";
/**
 * The active-product binding: a SECOND source of an active profile, beside a
 * legacy `profile.json`. The prototype compile refuses a project that has one.
 */
export const ACTIVE_PRODUCT_PATH = "meta/active-product";
/**
 * Every place a project schema may live, in the order a local compile looks.
 * The first that exists wins, so a portable compile must look in the same order.
 */
export const SCHEMA_PATHS = [
  "meta/schema.json", "meta/schema.yaml", "meta/schema.yml", "wiki/.schema.yaml", "wiki/.schema.yml",
] as const;
/** Immutable proposal record batches. */
export const PROPOSALS_PREFIX = "proposals/";
/** Immutable approval records. */
export const APPROVALS_PREFIX = "approvals/";
/**
 * Narrow durable compile-state records of the scoped path (S2a). Only the
 * authority-only store holds them; the disk layout maps no such prefix, so a
 * directory refuses them rather than inventing a second state home.
 */
export const SCOPED_STATE_PREFIX = "meta/scoped-state/";
/** Retained-original reference records (slice S3). Only the originals store has a format for them. */
export const ORIGINALS_PREFIX = "originals/";

const NAMESPACE_PREFIXES = [SOURCES_PREFIX, "wiki/", PROPOSALS_PREFIX, APPROVALS_PREFIX, SCOPED_STATE_PREFIX, ORIGINALS_PREFIX] as const;
const NAMESPACE_EXACT: ReadonlySet<string> = new Set([
  STATE_PATH, STATE_CUSTODY_PATH, CONFIG_PATH, PROFILE_PATH, ACTIVE_PRODUCT_PATH, "meta/schema.json", "meta/schema.yaml", "meta/schema.yml",
]);

/** One safe path segment: no separators, no dot-only names, no control characters. */
const SAFE_SEGMENT = /^(?!\.+$)[^/\\\0-\x1f]+$/u;

/** An operation or record id as it appears in a logical path. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,200}$/;

/** True when `id` can be used as one path segment of a record address. */
export function isSafeRecordId(id: string): boolean {
  return SAFE_ID.test(id) && !id.includes("..");
}

/**
 * Validate a logical path: inside a known namespace, normalized, and made only
 * of safe segments. Adapters call this again, so a bug above cannot pass one.
 *
 * @throws PortableRefusal `operation_unsupported_on_portable_path` otherwise.
 */
export function assertLogicalPath(path: string): void {
  const inNamespace = NAMESPACE_EXACT.has(path) || NAMESPACE_PREFIXES.some((p) => path.startsWith(p));
  const segments = path.split("/");
  if (!inNamespace || segments.some((segment) => !SAFE_SEGMENT.test(segment))) {
    throw new PortableRefusal("operation_unsupported_on_portable_path", "not a portable logical path");
  }
}

/** True for sources and wiki pages: content a person may also edit outside the path. */
export function isCuratedPath(path: string): boolean {
  return path.startsWith(SOURCES_PREFIX) || path.startsWith("wiki/");
}

/** The logical path of a concept page. */
export function conceptPagePath(slug: string): string {
  return `${CONCEPTS_PREFIX}${slug}.md`;
}

/** The logical path of a source. */
export function sourcePath(name: string): string {
  return `${SOURCES_PREFIX}${name}`;
}

/** The addresses of one proposal's records. */
export function proposalPaths(proposalOperationId: string): {
  plan: string; readSet: string; candidatePrefix: string; candidate(id: string): string;
} {
  const base = `${PROPOSALS_PREFIX}${proposalOperationId}/`;
  return {
    plan: `${base}plan`,
    readSet: `${base}read-set`,
    candidatePrefix: `${base}candidates/`,
    candidate: (id) => `${base}candidates/${id}`,
  };
}

/** The address of one approval record. */
export function approvalPath(approvalId: string): string {
  return `${APPROVALS_PREFIX}${approvalId}`;
}
