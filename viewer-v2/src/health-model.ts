/**
 * Facts the health screen shows, derived from the health payload and the
 * bootstrap envelope: the lint caption, the contents strip, the lint rule
 * rows, the freshness and traceability panels, and the record problems of a
 * profile project. Pure functions so the screen stays declarative and each
 * rule is tested once. Health counts come from `/api/health`; per-page
 * freshness and citation totals come from `/api/pages`, so the Freshness
 * panel's badge and sentence both read the same rows and cannot disagree.
 */
import type { HealthPayload, LintRule, PageRow, PagesEnvelope } from "./api";
import { relativeAge } from "./recency";
import { pageHref } from "./route";
import { citationTotals, formatUtcTimestamp, plural, typeLabel } from "./wiki-model";

/** Rendered in place of a bold 0: an empty count is an absence, not news. */
const EMPTY_COUNT = "—";

/** How many rules keep a row of their own; the rest fold into one "other" row. */
const NAMED_RULE_LIMIT = 4;

/** Rules whose findings are facts about the wikilink graph, which the explorer draws. */
const LINK_GRAPH_RULES = new Set(["broken-wikilink", "orphaned-page", "schema-cross-link-minimum"]);

/** Path shape of a file the viewer can route to: `wiki/<dir>/<slug>.md`. */
const PAGE_FILE_PATTERN = /^wiki\/(concepts|queries)\/([^/]+)\.md$/;

/** Freshness statuses the compiler actually resolved; anything else is unverified. */
const RESOLVED_FRESHNESS = new Set(["fresh", "stale", "orphaned"]);

/** "Lint has never run", or when it last ran and how long ago. */
export function lintRunCaption(lint: HealthPayload["lint"], now: Date): string {
  if (lint === null) return "Lint has never run";
  const at = formatUtcTimestamp(lint.at);
  const stamp = at === "unknown" ? "Lint last run at an unknown time" : `Lint last run ${at}Z`;
  const since = relativeAge(lint.at, now);
  return since ? `${stamp} · ${since} ago` : stamp;
}

/** One column of the contents strip. */
export interface ContentsColumn {
  key: string;
  label: string;
  value: number;
  suffix: string;
}

/** The five contents columns; a missing health payload reads as zeros. */
export function contentsColumns(health: HealthPayload | null, wiki: PagesEnvelope): ContentsColumn[] {
  const citations = citationTotals(wiki.pages);
  const queries = health?.queries ?? 0;
  const pending = health?.pendingReviews ?? 0;
  return [
    { key: "concepts", label: "Concepts", value: health?.concepts ?? 0, suffix: "pages" },
    { key: "sources", label: "Sources", value: health?.sourceFiles ?? 0, suffix: `${health?.sources ?? 0} compiled` },
    { key: "citations", label: "Citations", value: citations.total, suffix: `${citations.total - citations.unresolved} cited` },
    { key: "queries", label: "Saved queries", value: queries, suffix: queries === 0 ? "none yet" : "answers" },
    { key: "reviews", label: "Awaiting review", value: pending, suffix: pending === 0 ? "queue clear" : "candidates" },
  ];
}

/** A count as the strip writes it: the digits, or a dash for nothing. */
export function countFigure(value: number): string {
  return value > 0 ? String(value) : EMPTY_COUNT;
}

/** One drawn row of the lint table; the folded aggregate is the row named "other". */
export interface LintRow {
  rule: string;
  count: number;
  affected: string;
  href: string | null;
}

/** A file's display name: its basename with the Markdown extension dropped. */
function pageNameOf(file: string): string {
  return file.length === 0 ? EMPTY_COUNT : (file.split("/").pop() ?? "").replace(/\.md$/, "");
}

/** The page route a lint finding's file resolves to, when the envelope has that page. */
function pageRouteFor(topFile: string, pageIndex: Set<string>): string | null {
  const match = PAGE_FILE_PATTERN.exec(topFile);
  if (match === null) return null;
  const [, directory, slug] = match;
  return pageIndex.has(`${directory}/${slug}`) ? pageHref(directory, slug) : null;
}

/** Where one rule's findings land: the one file, a strict-majority file with its share, or the file count. */
function affectedFilesText(rule: LintRule): string {
  const name = pageNameOf(rule.topFile);
  if (rule.fileCount <= 1) return name;
  const hasDominantFile = rule.topFileCount * 2 > rule.count;
  return hasDominantFile ? `${name} · ${rule.topFileCount} of ${rule.count}` : plural(rule.fileCount, "file");
}

/**
 * The rows the lint table draws: the four highest-count rules get a row each
 * (the cache arrives sorted by count), and the rest fold into one "other" row
 * that reports how many rules it stands for.
 */
export function lintRuleRows(rules: LintRule[], pageIndex: Set<string>): LintRow[] {
  const named = rules.slice(0, NAMED_RULE_LIMIT).map((rule) => ({
    rule: rule.rule, count: rule.count, affected: affectedFilesText(rule), href: pageRouteFor(rule.topFile, pageIndex),
  }));
  const folded = rules.slice(NAMED_RULE_LIMIT);
  if (folded.length === 0) return named;
  const count = folded.reduce((sum, rule) => sum + rule.count, 0);
  return [...named, { rule: "other", count, affected: plural(folded.length, "rule"), href: null }];
}

/** The footer's sentence about the dominant rule, and where its button goes. */
export interface LintFooter {
  insight: string;
  action: { href: string; label: string } | null;
}

/** Link-graph rules lead to the explorer; others to the page with most findings, when routable. */
function footerAction(dominant: LintRule, pageIndex: Set<string>): LintFooter["action"] {
  if (LINK_GRAPH_RULES.has(dominant.rule)) return { href: "#/graph", label: "Open the graph explorer" };
  const href = pageRouteFor(dominant.topFile, pageIndex);
  return href === null ? null : { href, label: `Open ${pageNameOf(dominant.topFile)}` };
}

/** The footer for the highest-count rule, or null on a clean run or a cache without rules. */
export function lintFooter(rules: LintRule[], total: number, pageIndex: Set<string>): LintFooter | null {
  const dominant = rules[0];
  if (dominant === undefined || total === 0) return null;
  return { insight: `${dominant.count} of ${total} problems come from ${dominant.rule}.`, action: footerAction(dominant, pageIndex) };
}

/** The Freshness panel: a badge and a sentence. */
export interface FreshnessSummary {
  badge: { text: string; tone: "ok" | "warn" | "unknown" };
  note: string;
}

/** The badge: UNVERIFIED when nothing could be checked, else the actionable counts or IN SYNC. */
function freshnessBadge(stale: number, orphaned: number, whollyUnverified: boolean): FreshnessSummary["badge"] {
  if (whollyUnverified) return { text: "UNVERIFIED", tone: "unknown" };
  const parts = [];
  if (stale > 0) parts.push(`${stale} STALE`);
  if (orphaned > 0) parts.push(`${orphaned} ORPHANED`);
  return parts.length === 0 ? { text: "IN SYNC", tone: "ok" } : { text: parts.join(" · "), tone: "warn" };
}

/** Real problems first, then what could not be checked, and only then the all-clear. */
function freshnessNote(total: number, stale: number, orphaned: number, unverified: number): string {
  if (total === 0) return "No concept pages yet.";
  if (stale + orphaned > 0) return `${plural(stale, "page")} stale and ${plural(orphaned, "page")} orphaned out of ${total}.`;
  if (unverified > 0) {
    const scope = unverified === total ? "Freshness could not be checked for any page" : `Freshness could not be checked for ${plural(unverified, "page")}`;
    return `${scope} — state.json is missing or unreadable. Run \`llmwiki compile\` to restore it.`;
  }
  return "Every page is newer than its sources. Nothing stale, nothing orphaned.";
}

/** The Freshness panel's facts, all derived from the concept rows. */
export function freshnessSummary(conceptPages: PageRow[]): FreshnessSummary {
  const statuses = conceptPages.map((page) => page.freshness.freshnessStatus);
  const stale = statuses.filter((status) => status === "stale").length;
  const orphaned = statuses.filter((status) => status === "orphaned").length;
  const unverified = statuses.filter((status) => !RESOLVED_FRESHNESS.has(status)).length;
  const whollyUnverified = statuses.length > 0 && unverified === statuses.length;
  return { badge: freshnessBadge(stale, orphaned, whollyUnverified), note: freshnessNote(statuses.length, stale, orphaned, unverified) };
}

/** The Traceability panel: the share of citations that resolve to a real source span. */
export interface Traceability {
  percent: number;
  detail: string;
  note: string;
}

/** A wiki with no citations is fully traced by definition; 0% would call an empty wiki a failure. */
export function traceability(pages: PageRow[]): Traceability {
  const { total, unresolved } = citationTotals(pages);
  const cited = total - unresolved;
  const percent = total === 0 ? 100 : Math.round((cited / total) * 100);
  let note = `${unresolved} ${unresolved === 1 ? "citation still points" : "citations still point"} at no source file — the rest resolve to a real span.`;
  if (total === 0) note = "No citations recorded yet.";
  else if (unresolved === 0) note = "Every citation resolves to a real source span.";
  return { percent, detail: `${cited} / ${total} citations`, note };
}

/** One record problem as the panel shows it. */
export interface ProblemRow {
  label: string;
  where: string | null;
  message: string;
  code: string;
}

/** The record problems panel's rows, true total, and the notice when the wire list was capped. */
export interface ProblemsSummary {
  rows: ProblemRow[];
  total: number;
  notice: string | null;
}

/** `slug-mismatch` reads as `Slug mismatch`; a field violation gets the plainer wording the old screen used. */
function problemLabel(kind: string): string {
  return kind === "field-violation" ? "Missing or invalid information" : typeLabel(kind);
}

/** The capped list with its true total, so a truncated list never presents itself as the whole set. */
export function problemsSummary(wiki: PagesEnvelope): ProblemsSummary {
  const problems = wiki.profileProblems ?? [];
  const total = wiki.profileProblemTotal ?? problems.length;
  const rows = problems.map((problem) => ({
    label: problemLabel(problem.kind), where: problem.path ?? problem.entityType ?? null, message: problem.message, code: problem.kind,
  }));
  const notice = rows.length < total ? `Showing ${rows.length} of ${plural(total, "problem")}.` : null;
  return { rows, total, notice };
}
