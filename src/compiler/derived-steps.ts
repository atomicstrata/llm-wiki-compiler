/**
 * @file src/compiler/derived-steps.ts
 * @description What compile's derived steps (entity pages, the timeline) share:
 * their reads and writes over a local project (compiled sources from the state
 * file, source reads, the pages in a wiki directory, compile's locked page
 * writer, model provenance and the clock), and the bookkeeping every such step
 * does the same way: telling its own pages from hand-written ones, asking the
 * model for a page, fitting its citations to the lines it was shown, and applying
 * writes and deletes while reporting what landed.
 *
 * PRECONDITION: the caller holds the project lock (compile does), because the
 * writes go through the lock-free executor core.
 */

import path from "path";
import { readState } from "../utils/state.js";
import { parseFrontmatter } from "../utils/markdown.js";
import { SOURCES_DIR } from "../utils/constants.js";
import { diskLocalReads } from "../storage/disk-local-reads.js";
import { readWikiPageContentOrWarnFrom } from "./confined-wiki-read.js";
import { applyCompilePageWritesLocked, type CompilePageWrite, type SkippedWrite } from "./compile-write.js";
import { addModelProvenanceMeta } from "./provenance.js";
import { fitCitations, splitAnswer, type PageRequest, type ShownLines } from "./source-excerpt.js";

/** The reads and writes every derived step composes. */
export interface DerivedSteps {
  /** Every compiled source with its content hash. */
  listSources(): Promise<{ file: string; hash: string }[]>;
  /** A source's whole text. */
  readSource(file: string): Promise<string>;
  /** The pages in `wiki/<directory>/`: slug → text, `""` for a page that could not be read. */
  listPages(directory: string): Promise<Map<string, string>>;
  /** Apply the writes as one batch under compile's held lock. */
  writePages(writes: CompilePageWrite[]): Promise<{ skipped: SkippedWrite[] }>;
  /** Provenance stamped into each page's frontmatter (model, prompt version). */
  provenance(): Record<string, unknown>;
  /** The current time, as an ISO string. */
  now(): string;
}

/** The derived steps over the local project at `root`. */
export function localDerivedSteps(root: string): DerivedSteps {
  const reads = diskLocalReads(root);
  return {
    listSources: async () => Object.entries((await readState(root)).sources).map(([file, state]) => ({ file, hash: state.hash })),
    readSource: (file) => reads.readText(path.join(SOURCES_DIR, file)),
    listPages: async (directory) => {
      const dir = path.join("wiki", directory);
      const slugs = (await reads.listNames(dir).catch(() => [])).filter((name) => name.endsWith(".md")).map((name) => name.slice(0, -".md".length));
      const texts = await Promise.all(slugs.map((slug) => readWikiPageContentOrWarnFrom(reads, dir, slug, false)));
      return new Map(slugs.map((slug, index): [string, string] => [slug, texts[index] ?? ""]));
    },
    writePages: (writes) => applyCompilePageWritesLocked(root, writes),
    provenance: () => {
      const fields: Record<string, unknown> = {};
      addModelProvenanceMeta(fields);
      return fields;
    },
    now: () => new Date().toISOString(),
  };
}

/** Every compiled source with its hash and whole text. */
export async function readSources(steps: Pick<DerivedSteps, "listSources" | "readSource">): Promise<{ file: string; hash: string; text: string }[]> {
  return Promise.all((await steps.listSources()).map(async (source) => ({ ...source, text: await steps.readSource(source.file) })));
}

/** A frontmatter value that should be a string, or `""` when it is missing or not one. */
export function stringField(meta: Record<string, unknown>, key: string): string {
  const value = meta[key];
  return typeof value === "string" ? value : "";
}

/** A page a step wrote before: its text and parsed frontmatter. */
export interface OwnPage {
  text: string;
  meta: Record<string, unknown>;
}

/**
 * A directory's pages split into the ones this step wrote (`isOwn` says so from
 * the frontmatter) and the slugs of all others. An empty or unreadable page is
 * among the others, so it is never replaced or deleted.
 */
export function ownPages(texts: Map<string, string>, isOwn: (meta: Record<string, unknown>) => boolean): { own: Map<string, OwnPage>; foreign: Set<string> } {
  const own = new Map<string, OwnPage>();
  const foreign = new Set<string>();
  for (const [slug, text] of texts) {
    const { meta } = parseFrontmatter(text);
    if (text && isOwn(meta)) own.set(slug, { text, meta });
    else foreign.add(slug);
  }
  return { own, foreign };
}

/** What a derived step did. */
export interface DerivedResult {
  written: string[];
  deleted: string[];
  errors: string[];
}

/** How a step names its pages in what it reports, and where it reports them. */
export interface PageReport {
  /** The directory under `wiki/` the step writes: `timeline`, `person`. */
  directory: string;
  /** Who writes these pages, for the hand-written-page message: "the timeline". */
  writer: string;
  /** A page as a message names it: `Timeline page "2026-W19"`, `Page "person/ana"`. */
  label(slug: string): string;
  /** A page as `written` and `deleted` list it: `2026-W19`, `person/ana`. */
  id(slug: string): string;
  result: DerivedResult;
}

/** Whether `slug` may be written: not when a page this step did not write holds the name, which is reported. */
export function claimable(report: PageReport, slug: string, foreign: ReadonlySet<string>): boolean {
  if (!foreign.has(slug)) return true;
  report.result.errors.push(`wiki/${report.directory}/${slug}.md was not written by ${report.writer}; left as it is`);
  return false;
}

/** The model's answer for a page, or null after reporting why there is none. */
export async function completePage(report: PageReport, complete: (request: PageRequest) => Promise<string>, request: PageRequest, slug: string): Promise<string | null> {
  try {
    const answer = await complete(request);
    if (splitAnswer(answer).body) return answer;
    report.result.errors.push(`${report.label(slug)} came back empty`);
  } catch (error) {
    report.result.errors.push(`${report.label(slug)} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return null;
}

/**
 * A model answer (summary line and body) with its citations fitted to `shown`,
 * the lines it was written from (see {@link fitCitations}); a span that cites no
 * shown line is reported. The page is still written.
 */
export function fitAndReportCitations(report: PageReport, slug: string, answer: string, shown: ShownLines[]): string {
  const fitted = fitCitations(answer, shown);
  if (fitted.outside > 0) report.result.errors.push(`${report.label(slug)} cites ${fitted.outside} span${fitted.outside === 1 ? "" : "s"} outside the lines it was written from`);
  return fitted.body;
}

/**
 * A page on disk with the citations in its body fitted to `shown`, its
 * frontmatter untouched: the summary was fitted with the answer it came from, so
 * a refresh and a regeneration fit the same text and a second compile writes nothing.
 */
export function fitPageCitations(text: string, shown: ShownLines[]): string {
  const end = text.startsWith("---\n") ? text.indexOf("\n---", 3) : -1;
  if (end === -1) return fitCitations(text, shown).body;
  const bodyStart = end + "\n---".length;
  return text.slice(0, bodyStart) + fitCitations(text.slice(bodyStart), shown).body;
}

/** Apply `writes`, report the ones the write floor skipped and list the rest as written; returns the writes that landed. */
export async function writeAndReport<T extends CompilePageWrite>(report: PageReport, steps: Pick<DerivedSteps, "writePages">, writes: T[]): Promise<T[]> {
  const { landed, blocked } = await applyWrites(steps, writes);
  for (const write of blocked) report.result.errors.push(`${report.label(write.slug)} skipped by the write floor`);
  report.result.written.push(...landed.map((write) => report.id(write.slug)));
  return landed;
}

/** Apply `deletes` (this step's own pages whose period or record is gone), reporting each. */
export async function deleteAndReport(report: PageReport, steps: Pick<DerivedSteps, "writePages">, deletes: CompilePageWrite[]): Promise<void> {
  const { landed, blocked } = await applyWrites(steps, deletes);
  for (const write of blocked) report.result.errors.push(`${report.label(write.slug)} not removed`);
  report.result.deleted.push(...landed.map((write) => report.id(write.slug)));
}

/** Apply `writes` and split them into those that landed and those the write floor skipped. */
async function applyWrites<T extends CompilePageWrite>(steps: Pick<DerivedSteps, "writePages">, writes: T[]): Promise<{ landed: T[]; blocked: T[] }> {
  if (writes.length === 0) return { landed: [], blocked: [] };
  const { skipped } = await steps.writePages(writes);
  const skippedItems = new Set<CompilePageWrite>(skipped.map((skip) => skip.item));
  return { landed: writes.filter((write) => !skippedItems.has(write)), blocked: writes.filter((write) => skippedItems.has(write)) };
}
