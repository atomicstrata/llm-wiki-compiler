/**
 * @file src/entities/owner.ts
 * @description The owner page: the memory owner's own record (`person/<owner>`),
 * the page about who they are now. Memory only writes it; whether an agent
 * loads it on every turn is the reader's choice, not memory's.
 *
 * Its body is written by the model from the timeline's week pages, newest first
 * within a budget, keeping their citations, so its claims resolve to source
 * lines; citations of lines no week cited are fitted or reported like any
 * page's. Its frontmatter is a record page's (no fields). Below the body, a
 * generated "People" section lists every record of the owner's type, grouped by
 * the type's first declared enum field (a person's relationship), built with no
 * model call.
 *
 * It runs after the timeline, which it reads. The body is regenerated only when
 * the weeks it was written from change (its `entitySignature` hashes them);
 * otherwise only its aliases and People section are refreshed. With the timeline
 * off no week pages are read, so the page is the People section alone and costs
 * no call.
 */

import { shortDigest } from "../utils/short-digest.js";
import { extractClaimCitations } from "../utils/markdown.js";
import { withGenerated, type PageLink } from "../wiki/generated-section.js";
import {
  claimable, completePage, createdAtOf, fitAndReportCitations, ownPages, stringField, writeAndReport,
  type DerivedResult, type DerivedSteps, type OwnPage, type PageReport,
} from "../compiler/derived-steps.js";
import { SUMMARY_PREFIX, splitAnswer, type PageRequest, type ShownLines } from "../compiler/source-excerpt.js";
import { TIMELINE_NAMESPACE, weekPages } from "../timeline/pages.js";
import { ownerPageId, type AliasRegistry } from "./identity.js";
import { entityReport, isRecordPage, meetsFieldContract, recordPage, withAliases, type RecordPageMeta } from "./pages.js";
import type { ExtractableType } from "./schema.js";

/** Bump only when the owner page's prompt or layout changes in a way it must pick up; it regenerates the page. */
const OWNER_PAGE_VERSION = 1;
/** Characters of week pages one owner-page prompt may carry, newest first. */
const OWNER_EXCERPT_BUDGET = 60_000;
/** The summary of an owner page with no week pages to write from. */
const OWNER_SUMMARY = "The owner of this memory.";

/** The reads, model call and write the owner page composes. */
export interface OwnerSteps extends DerivedSteps {
  readRegistry(): Promise<AliasRegistry>;
  complete(request: PageRequest): Promise<string>;
}

/** A week page the owner page is written from. */
interface WeekInput {
  week: string;
  body: string;
}

/** Everything the owner page is built from. */
interface OwnerDraft {
  steps: OwnerSteps;
  type: ExtractableType;
  report: PageReport;
  id: string;
  names: string[];
  page: OwnPage | undefined;
  weeks: WeekInput[];
  people: string;
  signature: string;
}

/** How the owner page is written: from which types, and whether the timeline (its week pages) is on. */
export interface OwnerConfig {
  /** The extracted types; the owner page belongs to the one the registry's owner is of. */
  types: ExtractableType[];
  /** False when the timeline is off: week pages left from when it was on are not read. */
  useTimeline: boolean;
}

/** Bring the owner page up to date; does nothing when the registry names no owner of an extracted type. */
export async function generateOwnerPageWith(steps: OwnerSteps, config: OwnerConfig): Promise<DerivedResult> {
  const result: DerivedResult = { written: [], deleted: [], errors: [] };
  const registry = await steps.readRegistry();
  const type = config.types.find((candidate) => candidate.type === registry.owner?.type);
  const id = type ? ownerPageId(registry, type.type) : null;
  if (!type || !id) return result;
  const report = entityReport(type.type, result);
  const { own, foreign } = ownPages(await steps.listPages(type.type), isRecordPage);
  if (!claimable(report, id, foreign)) return result;
  const names = registry.owner!.names;
  const weeks = config.useTimeline ? recentWeeks(await steps.listPages(TIMELINE_NAMESPACE)) : [];
  const draft: OwnerDraft = {
    steps, type, report, id, names, weeks, page: own.get(id),
    people: peopleSection(own, id, type), signature: ownerSignature(names[0], weeks),
  };
  const text = await ownerPageText(draft);
  if (text !== null && text !== draft.page?.text) await writeAndReport(report, steps, [{ entityType: type.type, slug: id, body: text }]);
  return result;
}

/**
 * The page's new text. A current page gets its aliases and People section
 * refreshed. Otherwise the page is regenerated, after its frontmatter is checked
 * against the type's field contract so a page that cannot be written costs no
 * call; when the call fails, the page on disk keeps its body and still gets the
 * refresh. Null when there is nothing to write.
 */
async function ownerPageText(draft: OwnerDraft): Promise<string | null> {
  const { page } = draft;
  if (page && stringField(page.meta, "entitySignature") === draft.signature) return refreshed(draft, page);
  const meta = ownerMeta(draft);
  if (!meetsFieldContract(draft.report, draft.id, meta, draft.type.def)) return null;
  if (draft.weeks.length === 0) return recordPage(meta, "", draft.people);
  const answer = await completePage(draft.report, (request) => draft.steps.complete(request), ownerRequest(draft.names[0], draft.weeks), draft.id);
  if (answer === null) return page ? refreshed(draft, page) : null;
  const shown = citedLines(draft.weeks);
  const { summary, body } = splitAnswer(fitAndReportCitations(draft.report, draft.id, answer, shown));
  const sources = [...new Set(shown.map((lines) => lines.file))].sort();
  return recordPage({ ...meta, summary: summary || OWNER_SUMMARY, sources, provenance: draft.steps.provenance() }, body, draft.people);
}

/** The owner page's frontmatter before the model writes its summary: a record page with no fields, sources or provenance. */
function ownerMeta(draft: OwnerDraft): RecordPageMeta {
  const now = draft.steps.now();
  return {
    title: draft.names[0], titleField: draft.type.def.titleField, summary: OWNER_SUMMARY, aliases: draft.names.slice(1), fields: {},
    signature: draft.signature, createdAt: createdAtOf(draft.page, now), updatedAt: now, provenance: {},
  };
}

/** A page on disk with its aliases and People section brought up to date, with no model call. */
function refreshed(draft: OwnerDraft, page: OwnPage): string {
  return withGenerated(withAliases(page.text, draft.names.slice(1)), draft.people);
}

/** The week pages, newest first, as many as fit the budget (always at least the newest). */
function recentWeeks(texts: Map<string, string>): WeekInput[] {
  const kept: WeekInput[] = [];
  let used = 0;
  for (const week of weekPages(texts)) {
    if (kept.length > 0 && used + week.body.length > OWNER_EXCERPT_BUDGET) break;
    kept.push(week);
    used += week.body.length;
  }
  return kept;
}

/** The signature of what the owner page's body is written from; equal signatures mean the body is current. */
function ownerSignature(name: string, weeks: WeekInput[]): string {
  return shortDigest([OWNER_PAGE_VERSION, name, weeks]);
}

/** The request for the owner page. */
function ownerRequest(name: string, weeks: WeekInput[]): PageRequest {
  const system = `Write the page about ${name}, the owner of this personal memory, from the weekly pages below (newest first), in the third person: who ${name} is now, their life and work, what is going on, their preferences and how they communicate. Prefer what is newest; say when something is from earlier.
First line: "${SUMMARY_PREFIX} " and one sentence.
Then short "## " sections of bullets. End each bullet with the citations it draws on, copied exactly from the weekly pages.
Only what the pages say. No title.`;
  const pages = weeks.map(({ week, body }) => `--- WEEK: ${week} ---\n\n${body}`).join("\n\n");
  return { system, messages: [{ role: "user", content: `Weekly pages:\n\n${pages}\n\nWrite the page about ${name}.` }] };
}

/** The source lines the weeks cite: the only lines the owner page may cite, since it is written from them. */
function citedLines(weeks: WeekInput[]): ShownLines[] {
  return weeks.flatMap((week) => extractClaimCitations(week.body).flatMap((citation) => citation.spans))
    .map((span) => ({ file: span.file, ranges: span.lines ? [span.lines] : [] }));
}

/** A record as the People section lists it. */
interface PersonEntry extends PageLink {
  summary: string;
  group: string | null;
}

/**
 * The People section: every record of the type with a page, grouped by the type's
 * first declared enum field in its declared order, then any other value a page
 * still carries, then those with none. Empty when there are no records.
 */
function peopleSection(pages: Map<string, OwnPage>, ownerId: string, type: ExtractableType): string {
  const groupField = Object.entries(type.def.fields ?? {}).find(([name, def]) => def.type === "enum" && name !== type.def.titleField);
  const entries = [...pages].filter(([slug]) => slug !== ownerId).map(([slug, page]): PersonEntry => ({
    target: `${type.type}/${slug}`, title: stringField(page.meta, "title") || slug, summary: stringField(page.meta, "summary"),
    group: groupField ? stringField(page.meta, groupField[0]) || null : null,
  }));
  if (entries.length === 0) return "";
  return `## People\n\n${groupedEntries(entries, groupField?.[1].enum ?? [])}`;
}

/** Entries as `### Group` lists: declared values first, then other values, then "Not stated". */
function groupedEntries(entries: PersonEntry[], groupOrder: string[]): string {
  const others = [...new Set(entries.map((entry) => entry.group).filter((group): group is string => group !== null && !groupOrder.includes(group)))].sort();
  return [...groupOrder, ...others, null].map((group) => ({
    group, members: entries.filter((entry) => entry.group === group).sort((a, b) => a.title.localeCompare(b.title)),
  })).filter(({ members }) => members.length > 0).map(({ group, members }) => {
    const heading = group === null ? "Not stated" : group[0].toUpperCase() + group.slice(1);
    return `### ${heading}\n\n${members.map((entry) => `- [[${entry.target}|${entry.title}]]${entry.summary ? ` — ${entry.summary}` : ""}`).join("\n")}`;
  }).join("\n\n");
}
