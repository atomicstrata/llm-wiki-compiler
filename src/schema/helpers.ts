/**
 * Schema helper utilities shared by compile, lint, and CLI.
 *
 * Kept separate from `loader.ts` so callers that just need to interpret a
 * page's kind or count its wikilinks don't pull the YAML/JSON parser into
 * their dependency graph.
 */

import yaml from "js-yaml";
import type { PageKind, SchemaConfig } from "./types.js";
import { PAGE_KINDS } from "./types.js";
import { findWikilinks } from "../wiki/wikilinks.js";

/** Pattern matching [[Wikilink Title]] references in markdown content. */

/**
 * Resolve a page's kind from its raw frontmatter value, falling back to the
 * schema default when no explicit kind is set or the value is invalid.
 * @param rawKind - Raw `kind` value pulled from frontmatter (untyped).
 * @param schema - Resolved schema config.
 * @returns The resolved page kind.
 */
export function resolvePageKind(rawKind: unknown, schema: SchemaConfig): PageKind {
  if (typeof rawKind === "string" && (PAGE_KINDS as readonly string[]).includes(rawKind)) {
    return rawKind as PageKind;
  }
  return schema.defaultKind;
}

/**
 * Count the [[wikilinks]] in a page body.
 * Pure function so the linter can apply per-kind minimums without re-parsing.
 * @param body - Markdown body text.
 * @returns Number of wikilink references found.
 */
export function countWikilinks(body: string): number {
  return findWikilinks(body).length;
}

/**
 * Serialise a schema config to YAML for `llmwiki schema init` to write to disk.
 * The `loadedFrom` field is omitted because it's a runtime-only annotation.
 * @param schema - Resolved schema config.
 * @returns YAML string suitable for writing to a schema file.
 */
export function serializeSchemaToYaml(schema: SchemaConfig): string {
  const serializable = {
    version: schema.version,
    defaultKind: schema.defaultKind,
    kinds: schema.kinds,
    seedPages: schema.seedPages,
  };
  return yaml.dump(serializable, { lineWidth: -1, quotingType: '"' });
}
