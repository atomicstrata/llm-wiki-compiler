/**
 * Page-level embedding: discover retrievable pages on disk, build their
 * embedding text, embed the changed/cold ones, and merge results into the
 * existing entry set. Phase 2 swaps the per-page loop for batched embedding.
 */

import path from "path";
import { getEmbeddingProvider } from "./embedding-provider.js";
import { CONCEPTS_DIR, QUERIES_DIR } from "./constants.js";
import { type EmbeddingEntry } from "./embeddings-store.js";
import { embedTextBatch, enrichEmbedError, makeCountingProvider } from "./embeddings-batch.js";
import { safeRealpath, isInsideDir } from "./path-confine.js";
import { listDirectoryNames } from "../storage/disk-guarded-leaves.js";
import { readConfinedExactFile } from "../storage/disk-local-reads.js";
import { frontmatterOfRead, sharedPageRead } from "../storage/shared-page-reads.js";
import { locationIsRegularFile } from "../storage/disk-locations.js";
import type { ConfinedReadResult } from "../storage/legacy-local-reads.js";
import type { PageRecord } from "../pages/read.js";
import { prefetchInOrder } from "./prefetch-in-order.js";

/** A reserved-namespace page record tagged with the directory it came from. */
export interface NamespacedPageRecord {
  /** `concepts` or `queries` — the reserved namespace of the source directory. */
  namespace: string;
  record: PageRecord;
}

/** Reserved namespaces and their on-disk directories, in priority order. */
const RESERVED_DIRS: ReadonlyArray<{ namespace: string; dir: string }> = [
  { namespace: path.basename(CONCEPTS_DIR), dir: CONCEPTS_DIR },
  { namespace: path.basename(QUERIES_DIR), dir: QUERIES_DIR },
];

/**
 * The PHYSICAL reads the embedding page collectors run over: the reserved scan
 * and the requested-page existence check. Each member is ONE incumbent
 * mechanism; which names are pages, the parse, eligibility, order and what a
 * failure means stay with the collectors. Directory and entry locators are
 * opaque strings (on disk, absolute canonical paths). It is distinct from
 * `LegacyLocalReads`, whose `readConfinedPage` confines to the LEXICAL
 * `<root>/<dir>` and whose `realDirectory` refuses linked directories: this
 * scan confines to the RESOLVED directory, so an in-project linked directory
 * is read, as before. Naming these selects no backend.
 */
export interface EmbeddingPageReads {
  /** MECHANISM. The project's canonical locator, or `null` when it cannot be resolved. Never rejects. */
  projectDirectory(): Promise<string | null>;
  /** MECHANISM (confinement). `relDir` under `project`, resolved through links, only when it stays inside `project`; otherwise `null`. Never rejects. */
  confinedDirectory(project: string, relDir: string): Promise<string | null>;
  /** MECHANISM. A confined directory's entry names, in listing order. Rejects raw. */
  listNames(directory: string): Promise<string[]>;
  /** MECHANISM (handle-bound confined read). The exact entry `name`, only when it resolves inside `directory`. Never rejects. */
  readConfinedEntry(directory: string, name: string): Promise<ConfinedReadResult>;
  /**
   * MECHANISM. Whether `relPath` is a regular file, following links. Rejects
   * raw; the caller decides what each error means. `relPath` is POSIX
   * project-relative (`/`-joined, as profile directories are declared and
   * canonicalized), whatever the platform; the disk binding joins it onto the
   * root natively.
   */
  isRegularFile(relPath: string): Promise<boolean>;
  /**
   * MECHANISM. The entry names of `relDir`, POSIX project-relative like
   * {@link isRegularFile}, links followed and NOT confined: it answers only
   * which names are missing, never what any entry holds. Rejects raw.
   */
  listRelativeNames(relDir: string): Promise<string[]>;
}

/**
 * LOCAL DISK. The incumbent mechanisms for `root`: `safeRealpath`, the
 * resolved-and-contained directory check, `listDirectoryNames`,
 * `readConfinedExactFile`, `locationIsRegularFile` and `listDirectoryNames`
 * again for a project-relative directory, with their exact
 * arguments. Building it does no I/O. In no package index.
 */
export function diskEmbeddingPageReads(root: string): EmbeddingPageReads {
  return {
    projectDirectory: () => safeRealpath(root),
    confinedDirectory: async (project, relDir) => {
      const resolved = await safeRealpath(path.join(project, relDir));
      return resolved && isInsideDir(resolved, project) ? resolved : null;
    },
    listNames: (directory) => listDirectoryNames(directory),
    readConfinedEntry: (directory, name) => sharedPageRead(directory, name, () => readConfinedExactFile(directory, path.join(directory, name))),
    isRegularFile: (relPath) => locationIsRegularFile(path.join(root, relPath)),
    listRelativeNames: (relDir) => listDirectoryNames(path.join(root, relDir)),
  };
}

/**
 * Scan concepts/ and queries/ directories, returning retrievable pages tagged
 * with the reserved namespace they came from.
 *
 * Each `.md` entry is realpath-confirmed to resolve INSIDE its canonical entity
 * directory and read through {@link readConfinedExactFile} (handle-bound), so a
 * symlinked page escaping the project tree is dropped before it is read — its
 * bytes never reach the embedding provider. A legit in-dir symlink (resolving
 * inside the dir) is still read.
 */
export async function collectNamespacedPageRecords(root: string): Promise<NamespacedPageRecord[]> {
  // `async` so that a throw while the disk mechanisms are built REJECTS.
  return collectNamespacedPageRecordsFrom(diskEmbeddingPageReads(root));
}

/**
 * {@link collectNamespacedPageRecords} over `reads`: THE ONE BODY. The reserved
 * directories in priority order, each skipped when it does not resolve inside
 * the project or cannot be listed; `.md` names in listing order; and the
 * confined read, parse and legacy gate per page.
 */
export async function collectNamespacedPageRecordsFrom(reads: EmbeddingPageReads): Promise<NamespacedPageRecord[]> {
  const records: NamespacedPageRecord[] = [];
  const project = await reads.projectDirectory();
  if (!project) return records;
  for (const { namespace, dir } of RESERVED_DIRS) {
    const directory = await reads.confinedDirectory(project, dir);
    if (!directory) continue;
    let files: string[];
    try {
      files = await reads.listNames(directory);
    } catch {
      continue;
    }
    const pageFiles = files.filter((f) => f.endsWith(".md"));
    for (const pending of prefetchInOrder(pageFiles, (file) => readConfinedPageRecord(reads, directory, file))) {
      const record = await pending;
      if (record) records.push({ namespace, record });
    }
  }
  return records;
}

/** Scan concepts/ and queries/ for retrievable pages (untagged). */
export async function collectPageRecords(root: string): Promise<PageRecord[]> {
  return (await collectNamespacedPageRecords(root)).map((r) => r.record);
}

/**
 * Confine, read, and parse a single page into a PageRecord. The entry is dropped
 * (returns null) when its realpath escapes `expectedDir`, when the handle-bound
 * read fails closed, or when the page is an orphan / lacks a title.
 */
async function readConfinedPageRecord(reads: EmbeddingPageReads, expectedDir: string, file: string): Promise<PageRecord | null> {
  const read = await reads.readConfinedEntry(expectedDir, file);
  if (!("content" in read)) return null;
  const { meta, body } = frontmatterOfRead(read);
  if (meta.orphaned || typeof meta.title !== "string") return null;
  return {
    slug: file.replace(/\.md$/, ""),
    title: meta.title,
    summary: typeof meta.summary === "string" ? meta.summary : "",
    body,
  };
}

/** Build the text that represents a page in the embedding space. */
export function buildEmbeddingText(record: Pick<PageRecord, "title" | "summary">): string {
  return record.summary
    ? `${record.title}\n\n${record.summary}`
    : record.title;
}

/**
 * Embed every page in `records` whose slug is in `slugsToEmbed`, batched.
 * Vectors come back in input order, so zip them onto the selected records.
 */
export async function embedPages(
  records: PageRecord[],
  slugsToEmbed: Set<string>,
  batchSize: number,
  expectedDim?: number,
): Promise<{ entries: EmbeddingEntry[]; requests: number }> {
  const { provider, requestCount } = makeCountingProvider(getEmbeddingProvider());
  const now = new Date().toISOString();
  const selected = records.filter((r) => slugsToEmbed.has(r.slug));
  if (selected.length === 0) return { entries: [], requests: 0 };

  let vectors: number[][];
  try {
    vectors = await embedTextBatch(provider, selected.map(buildEmbeddingText), batchSize, expectedDim);
  } catch (err) {
    throw enrichEmbedError(err, "page", (i) => selected[i]?.slug);
  }
  const entries = selected.map((record, i) => ({
    slug: record.slug,
    title: record.title,
    summary: record.summary,
    vector: vectors[i],
    updatedAt: now,
  }));
  return { entries, requests: requestCount() };
}
