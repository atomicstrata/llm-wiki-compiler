/**
 * Facts derived from the bootstrap envelope and the health payload that more
 * than one screen shows: the whole-wiki verdict, the profile vocabulary, the
 * citation totals, and the labels for entity types. Pure functions so the
 * screens stay declarative and the rules are tested once.
 */
import type { EntityTypeRow, HealthPayload, PageRow, PagesEnvelope } from "./api";

/** `3 pages`, `1 page`. */
export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Warnings plus errors of the last lint run, or null when lint has never run. */
export function lintTotal(health: HealthPayload | null): number | null {
  if (health === null || health.lint === null) return null;
  return health.lint.warnings + health.lint.errors;
}

/** Only stale and orphaned pages are worth a warning; unverified is calm. */
export function isWarnFreshness(status: string): boolean {
  return status === "stale" || status === "orphaned";
}

/** The entity types a profile declares, or an empty list on a default project. */
export function entityTypes(wiki: PagesEnvelope): EntityTypeRow[] {
  return wiki.profilePipeline?.entityTypes ?? [];
}

/** Whether the project runs a profile rather than the default concepts and queries. */
export function isProfileProject(wiki: PagesEnvelope): boolean {
  return wiki.profileId !== "default";
}

/** `instrument_calibrations` reads as `Instrument calibrations`. */
export function typeLabel(type: string): string {
  const spaced = type.replace(/[_-]+/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Pages in one directory, newest first. */
export function pagesIn(wiki: PagesEnvelope, directory: string): PageRow[] {
  return wiki.pages
    .filter((page) => page.pageDirectory === directory)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Citation totals across the given pages. */
export function citationTotals(pages: PageRow[]): { total: number; unresolved: number } {
  let total = 0;
  let unresolved = 0;
  for (const page of pages) {
    total += page.citationCount;
    unresolved += page.unresolvedCitationCount;
  }
  return { total, unresolved };
}

/** The inventory a profile project shows in place of concept counts. */
export interface ProfileVocabulary {
  typeCount: number;
  pageCount: number;
  citationCount: number;
}

/** Profile inventory figures, or null on a default project. */
export function profileVocabulary(wiki: PagesEnvelope): ProfileVocabulary | null {
  const types = wiki.profilePipeline?.entityTypes;
  if (types === undefined) return null;
  const declared = new Set(types.map((row) => row.type));
  const typedPages = wiki.pages.filter((page) => declared.has(page.pageDirectory));
  return {
    typeCount: types.length,
    pageCount: types.reduce((sum, row) => sum + row.pageCount, 0),
    citationCount: citationTotals(typedPages).total,
  };
}

/** The whole-wiki verdict shown in the header pill. */
export interface Verdict {
  text: string;
  tone: "warn" | "ok" | "unknown";
}

/** Number of profile record problems, whichever field the server sent. */
function profileProblemCount(wiki: PagesEnvelope): number {
  return wiki.profileProblemTotal ?? wiki.profileProblems?.length ?? 0;
}

/**
 * Attention beats unmeasured on purpose: a wiki with lint findings must not
 * read as "unverified" just because its state file is also missing.
 */
export function wikiVerdict(wiki: PagesEnvelope, health: HealthPayload | null): Verdict {
  const lint = lintTotal(health);
  const attention = (lint ?? 0) > 0 || wiki.counts.stale > 0 || wiki.counts.orphaned > 0 || profileProblemCount(wiki) > 0;
  if (attention) return { text: "NEEDS ATTENTION", tone: "warn" };
  const unmeasured: string[] = [];
  if (wiki.stateStatus !== "ok") unmeasured.push("FRESHNESS UNVERIFIED");
  if (lint === null) unmeasured.push("LINT NEVER RUN");
  if (unmeasured.length > 0) return { text: unmeasured.join(" · "), tone: "unknown" };
  return { text: "ALL CLEAR", tone: "ok" };
}

/** `YYYY-MM-DD HH:MM` in UTC, as the timestamps are produced; "unknown" when absent. */
export function formatUtcTimestamp(iso: string): string {
  return iso.length >= 16 ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : "unknown";
}
