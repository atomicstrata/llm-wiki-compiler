/**
 * Shared primitives for the wiki lint rule families.
 *
 * The lint rules are split across sibling modules by family — wikilink/orphan/
 * freshness/quality in {@link file://./rules.ts}, citation/provenance in
 * {@link file://./rules-citations.ts}, and schema cross-links in
 * {@link file://./rules-crosslinks.ts}. The helpers every family needs to walk
 * the wiki (`collectAllPages`, `readMarkdownFiles`, `findMatchesInContent`) live
 * here so the family modules can import them WITHOUT importing `rules.ts` — which
 * re-exports the families and would otherwise close an import cycle.
 *
 * `collectAllPagesFrom` is THE ONE BODY of the page collection and holds no
 * project root: it reaches the project only through {@link LintPageSources}.
 * `collectAllPages(root)` is a delegate over a private binding built per call.
 * The sources answer FACTS (whether a path resolves, a directory's names or
 * typed entries, a file's text, where a path is); the body owns both scopes,
 * the filters, the depth, the failure rules and the order. Naming the sources
 * selects no backend and rules on no mechanism: every member of the local
 * binding is still an UNCONFINED local-disk call, exactly as before.
 *
 * {@link LintLinkSources} adds the pending candidate records for the two
 * consumers that ask for them, the broken-wikilink rule and the fix plan. The
 * two disk factories are exported for the sibling rule modules ONLY, so the
 * disk wiring is written once; no package entry re-exports this module.
 *
 * NOT MIGRATED HERE: the citation rule family, the lint orchestrator, source
 * removal and the eval collectors still take a root and call
 * `collectAllPages(root)`.
 */

import path from "path";
import { CONCEPTS_DIR, QUERIES_DIR } from "../utils/constants.js";
import { listDirectoryEntries } from "../storage/disk-guarded-leaves.js";
import { diskLocalReads } from "../storage/disk-local-reads.js";
import { diskLocalRecordDirs } from "../storage/disk-local-record-dirs.js";
import type { LegacyLocalRecordDirs } from "../storage/legacy-local-record-dirs.js";
import type { LocalEntry } from "../storage/legacy-local-reads.js";
import { oncePer } from "../utils/pass-memo.js";

/** Pattern matching ^[filename.md] citation markers in markdown content. */
export const CITATION_PATTERN = /\^\[([^\]]+)\]/g;

/** Match result with its line number and captured group. */
export interface LineMatch {
  captured: string;
  line: number;
}

/**
 * Scan all lines of a page's content and return regex matches with line numbers.
 * Shared by rules that need to locate patterns within page bodies.
 */
export function findMatchesInContent(content: string, pattern: RegExp): LineMatch[] {
  const results: LineMatch[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const matches = lines[i].matchAll(pattern);
    for (const match of matches) {
      results.push({ captured: match[1], line: i + 1 });
    }
  }
  return results;
}

/**
 * Everything the page collection asks of the project. Every path is
 * project-relative. Each member is ONE incumbent primitive with its own link
 * behaviour and raw errors; none confines, caps, sorts or normalizes.
 */
export interface LintPageSources {
  /** Whether the path resolves, following links. Never rejects. */
  exists(relPath: string): Promise<boolean>;
  /** Entry names of a directory, in the backend's listing order. Rejects raw when it cannot be listed. */
  listNames(relDir: string): Promise<string[]>;
  /** Entries of a directory with what each one IS, no link followed, in the backend's listing order. Returns a promise that rejects raw when it cannot be listed. */
  listEntries(relDir: string): Promise<LocalEntry[]>;
  /** A file's whole text as UTF-8, following links. Rejects raw, for a directory too. */
  readText(relPath: string): Promise<string>;
  /** The path a page is reported under. On local disk, `path.join(root, relPath)`. */
  locate(relPath: string): string;
}

/**
 * LOCAL DISK. The sources for the project at `root`, built per call by each
 * root-taking rule and held by none. Building them does no I/O. Four members are the
 * ordinary local read binding's own; the typed listing is the unguarded
 * `readdir(..., { withFileTypes: true })`, called at once, with each entry's
 * kind named.
 */
export function diskLintPageSources(root: string): LintPageSources {
  const { exists, listNames, readText, locate } = diskLocalReads(root);
  return {
    exists, listNames, readText, locate,
    listEntries: (relDir) => listDirectoryEntries(locate(relDir)).then((entries) => entries.map((entry): LocalEntry => ({
      name: entry.name,
      kind: entry.isFile() ? "file" : entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "link" : "other",
    }))),
  };
}

/**
 * What the broken-wikilink rule and the fix plan ask of the project, in the
 * order they ask: the pages, then the pending candidate records. Both read the
 * SAME two things so they cannot disagree about a link.
 */
export interface LintLinkSources {
  /** The page collection's sources. */
  pages: LintPageSources;
  /** The pending candidate records, read through the tolerant candidate list after the pages. */
  candidates: LegacyLocalRecordDirs;
}

/** LOCAL DISK. The link sources for the project at `root`, built per call. Building them does no I/O. */
export function diskLintLinkSources(root: string): LintLinkSources {
  return { pages: diskLintPageSources(root), candidates: diskLocalRecordDirs(root) };
}

/**
 * Read all .md files from a directory, returning their paths and parsed content.
 * Returns an empty array if the directory does not exist.
 */
async function readMarkdownFiles(
  sources: LintPageSources, relDir: string,
): Promise<Array<{ filePath: string; content: string }>> {
  if (!(await sources.exists(relDir))) return [];

  const entries = await sources.listNames(relDir);
  const mdFiles = entries.filter((f) => f.endsWith(".md"));

  const results = await Promise.all(
    mdFiles.map(async (fileName) => {
      const relPath = path.join(relDir, fileName);
      const content = await sources.readText(relPath);
      return { filePath: sources.locate(relPath), content };
    }),
  );

  return results;
}

/**
 * The page set a rule family walks. TWO SCOPES, and which one a rule takes is a
 * jurisdiction decision, not a convenience:
 *
 * - `"generic"` — the generic compiler's `concepts/` and `queries/` pages. The
 *   quality family (summaries, body length, staleness, orphans) stays here,
 *   because on a profile project those judgements belong to the PROFILE lint
 *   family, which knows each entity kind's required fields — the generic rules
 *   firing there too would double-report every finding.
 * - `"wiki-wide"` — every markdown page under `wiki/`, whatever directories the
 *   active profile declares. The explicit tiered CLI and §4.6 fix plan take
 *   this scope for wikilinks. Existing flat lint and direct rule calls retain
 *   generic coverage, including on old profile projects.
 *
 * A fix plan and the broken-wikilink check it accompanies take the SAME scope: their
 * agreement ("no fix where the linter saw no problem") is a tested invariant,
 * and two scopes would break it silently on exactly the pages one saw and the
 * other did not.
 */
export type PageScope = "generic" | "wiki-wide";

/** Collect the pages one rule family walks, under its declared scope. */
export async function collectAllPages(
  root: string, scope: PageScope = "generic",
): Promise<Array<{ filePath: string; content: string }>> {
  return collectAllPagesFrom(diskLintPageSources(root), scope);
}

type LintPage = { filePath: string; content: string };

const runCollections = new WeakMap<LintPageSources, Map<PageScope, Promise<LintPage[]>>>();

/** `sources` for ONE lint run: every rule collects the same pages, so each listing and page text is read once and every later ask gets the first answer (its promise, so a failure repeats too), and a page collection is built once per scope. */
export function readOncePageSources(sources: LintPageSources): LintPageSources {
  const perPath = <T>(read: (relPath: string) => Promise<T>) => oncePer((relPath: string) => relPath, read);
  const run: LintPageSources = {
    exists: perPath((relPath) => sources.exists(relPath)),
    listNames: perPath((relPath) => sources.listNames(relPath)),
    listEntries: perPath((relPath) => sources.listEntries(relPath)),
    readText: perPath((relPath) => sources.readText(relPath)),
    locate: (relPath) => sources.locate(relPath),
  };
  runCollections.set(run, new Map());
  return run;
}

/** {@link collectAllPages} through `sources`: THE ONE BODY, for both scopes; once per scope within a run. */
export async function collectAllPagesFrom(
  sources: LintPageSources, scope: PageScope = "generic",
): Promise<LintPage[]> {
  const collections = runCollections.get(sources);
  if (!collections) return collectPagesFrom(sources, scope);
  if (!collections.has(scope)) collections.set(scope, collectPagesFrom(sources, scope));
  return [...await collections.get(scope)!];
}

async function collectPagesFrom(sources: LintPageSources, scope: PageScope): Promise<LintPage[]> {
  if (scope === "generic") {
    const conceptPages = await readMarkdownFiles(sources, CONCEPTS_DIR);
    const queryPages = await readMarkdownFiles(sources, QUERIES_DIR);
    return [...conceptPages, ...queryPages];
  }
  const wikiRoot = "wiki";
  if (!(await sources.exists(wikiRoot))) return [];
  // RECURSIVE, because a profile may validly declare nested entity directories
  // (wiki/research/papers) — a one-level walk silently returned no pages for
  // them, which is the exact partial-coverage failure this widening replaced.
  // Bounded by depth so a symlink cycle cannot walk forever; dot-directories
  // (.obsidian) are artifacts, not pages.
  const pages = await walkMarkdown(sources, wikiRoot, MAX_WIKI_WALK_DEPTH);
  return pages.sort((left, right) => left.filePath.localeCompare(right.filePath));
}

/** The deepest nesting a profile's entity directories may reasonably reach. */
const MAX_WIKI_WALK_DEPTH = 6;

/** Every markdown page under `relDir`, to the given remaining depth. A link is neither a directory nor a file here, so it is skipped. */
async function walkMarkdown(
  sources: LintPageSources, relDir: string, depth: number,
): Promise<Array<{ filePath: string; content: string }>> {
  if (depth === 0) return [];
  const entries = await sources.listEntries(relDir).catch((): LocalEntry[] => []);
  const results = await Promise.all(entries
    .filter((entry) => !entry.name.startsWith("."))
    .map(async (entry) => {
      const relPath = path.join(relDir, entry.name);
      if (entry.kind === "directory") return walkMarkdown(sources, relPath, depth - 1);
      if (entry.kind !== "file" || !entry.name.endsWith(".md")) return [];
      return [{ filePath: sources.locate(relPath), content: await sources.readText(relPath) }];
    }));
  return results.flat();
}
