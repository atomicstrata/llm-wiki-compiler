/**
 * Default schema constants.
 *
 * Projects without a schema file fall back to these defaults so the compiler
 * keeps working on day one. Every existing wiki — created before the schema
 * layer existed — is treated as a wiki of `concept` pages with no
 * cross-link minimums, preserving backward compatibility.
 */

import type { PageKind, PageKindRule, SchemaConfig } from "./types.js";

/** Minimum cross-links per kind, chosen to match each kind's purpose. */
const DEFAULT_MIN_LINKS: Record<PageKind, number> = {
  concept: 0,
  entity: 1,
  comparison: 2,
  overview: 3,
};

/** Human-readable descriptions used in prompts and review output. */
const DEFAULT_DESCRIPTIONS: Record<PageKind, string> = {
  concept: "A standalone idea, technique, or pattern worth documenting.",
  entity: "A specific thing — a person, product, organization, or named artifact.",
  comparison: "A side-by-side analysis weighing two or more concepts or entities.",
  overview: "A top-down map page that situates several concepts within a domain.",
};

/** Build the default per-kind rule table. */
function buildDefaultKindRules(): Record<PageKind, PageKindRule> {
  return {
    concept: { minWikilinks: DEFAULT_MIN_LINKS.concept, description: DEFAULT_DESCRIPTIONS.concept },
    entity: { minWikilinks: DEFAULT_MIN_LINKS.entity, description: DEFAULT_DESCRIPTIONS.entity },
    comparison: {
      minWikilinks: DEFAULT_MIN_LINKS.comparison,
      description: DEFAULT_DESCRIPTIONS.comparison,
    },
    overview: {
      minWikilinks: DEFAULT_MIN_LINKS.overview,
      description: DEFAULT_DESCRIPTIONS.overview,
    },
  };
}

/** The schema returned when no schema file exists. */
export function buildDefaultSchema(): SchemaConfig {
  return {
    version: 1,
    defaultKind: "concept",
    kinds: buildDefaultKindRules(),
    seedPages: [],
    timeline: { enabled: false, timeZone: machineTimeZone() },
    loadedFrom: null,
  };
}

/** The zone this machine runs in, which is the timeline's default. */
function machineTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}
