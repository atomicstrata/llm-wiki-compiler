/**
 * @file src/portable/scoped/namespaces.ts
 * @description Deterministic page-namespace membership and the logical
 * addresses of the scoped path's own records.
 *
 * A namespace is a managed logical prefix, `wiki/concepts/<name>/`, and a page
 * belongs to exactly one namespace by its path alone: `wiki/concepts/<name>/<slug>.md`.
 * Nothing is inferred from a topic, a cluster or a similarity. A flat
 * `wiki/concepts/<slug>.md` page belongs to no selectable namespace, and
 * deeper nesting belongs to none either. A page that does not exist yet
 * belongs to the namespace of the path its plan would create.
 */

import { CONCEPTS_PREFIX, PROPOSALS_PREFIX, SCOPED_STATE_PREFIX, SOURCES_PREFIX } from "../logical-paths.js";

/** A namespace name: one lowercase path segment. */
const NAMESPACE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/u;

/** One namespaced page path, capturing the namespace and the slug. */
const NAMESPACED_PAGE = /^wiki\/concepts\/([a-z0-9][a-z0-9-]{0,62})\/([^/]+)\.md$/u;

/** A source name the scoped path accepts: one segment under `sources/`, Markdown. */
const SOURCE_NAME = /^(?!\.)[^/\\\0-\x1f]+\.md$/u;

/** True for a name a namespace descriptor may carry. */
export function isNamespaceName(name: string): boolean {
  return NAMESPACE_NAME.test(name);
}

/** True for a source name a scoped predicate may list. */
export function isScopedSourceName(name: string): boolean {
  return SOURCE_NAME.test(name);
}

/** The logical path of `slug` in namespace `name`: under the managed prefix `wiki/concepts/<name>/`. */
export function namespacedPagePath(name: string, slug: string): string {
  return `${CONCEPTS_PREFIX}${name}/${slug}.md`;
}

/** The namespace a logical path belongs to, or `null` when it belongs to none. */
export function namespaceOf(path: string): string | null {
  return NAMESPACED_PAGE.exec(path)?.[1] ?? null;
}

/** The slug of a namespaced page path, or `null`. */
export function namespacedSlugOf(path: string): string | null {
  return NAMESPACED_PAGE.exec(path)?.[2] ?? null;
}

/** The logical path of one source. */
export function scopedSourcePath(name: string): string {
  return `${SOURCES_PREFIX}${name}`;
}

/** Where durable per-source records live. */
const SOURCE_RECORDS_PREFIX = `${SCOPED_STATE_PREFIX}sources/`;

/**
 * The durable completion record of one source. The name is percent-encoded,
 * so the record path is one safe segment and maps back to exactly one name.
 */
export function sourceRecordPath(name: string): string {
  return `${SOURCE_RECORDS_PREFIX}${encodeURIComponent(name)}`;
}

/** The source a durable record path names, or `null` when it names none. */
export function sourceOfRecordPath(path: string): string | null {
  if (!path.startsWith(SOURCE_RECORDS_PREFIX)) return null;
  try {
    const name = decodeURIComponent(path.slice(SOURCE_RECORDS_PREFIX.length));
    return sourceRecordPath(name) === path ? name : null;
  } catch {
    return null;
  }
}

/** The scoped records of one proposal, beside its V1-shaped plan and candidates. Never the V1 read-set. */
export function scopedProposalPaths(proposalOperationId: string): { readSet: string; coverage: string } {
  const base = `${PROPOSALS_PREFIX}${proposalOperationId}/`;
  return { readSet: `${base}scoped-read-set`, coverage: `${base}scoped-coverage` };
}
