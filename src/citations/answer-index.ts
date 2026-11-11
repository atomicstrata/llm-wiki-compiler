/**
 * Fresh resolution snapshots in production concepts-then-queries scan order.
 * Retained metadata uses the shared handle-bound confinement proof and borrows
 * the streaming reader; pending records use existing candidate admission with
 * strict I/O enabled. No cache or mutation lock is owned here, so a publication
 * caller can collect fresh state while already holding its project lock.
 *
 * Disk access: {@link collectAnswerCitationIndex} runs the one collector,
 * {@link collectAnswerCitationIndexFrom}, over a private local-disk
 * {@link AnswerCitationSources}. The collector keeps every rule about WHAT is
 * indexed: the order, which names are pages, a page's identity and aliases,
 * which failures are thrown and which are skipped, and which candidates count.
 * The sources keep only WHERE things are and the confinement proofs. This is a
 * local compatibility seam so the real policy can run without a project
 * directory. It is not `ProjectStore`, and not a hosted, public or
 * access-control contract; nothing here selects a backend.
 */
import path from "path";
import type { AnswerCitationIndex, RetainedCitationTarget } from "./answer-types.js";
import { CONCEPTS_DIR, QUERIES_DIR } from "../utils/constants.js";
import { isInsideDir, safeRealpath } from "../utils/path-confine.js";
import { listDirectoryNames } from "../storage/disk-guarded-leaves.js";
import { readConfinedPageThrough } from "../storage/disk-local-reads.js";
import { diskLocalRecordDirs } from "../storage/disk-local-record-dirs.js";
import type { LegacyLocalRecordDirs } from "../storage/legacy-local-record-dirs.js";
import { listCandidatesFrom } from "../compiler/candidate-read.js";
import { slugify } from "../utils/markdown.js";
import { readResolutionFrontmatter, type PositionalBytes } from "./frontmatter-reader.js";

const STRICT_IO = { strictIo: true };

/** What reading one resolved entry came to. `unreadable` carries the fault the collector throws. */
type RetainedEntryRead<T> = { kind: "ok"; value: T } | { kind: "absent" } | { kind: "unreadable"; cause: Error };

/**
 * One page directory found at exactly its expected place. An ENTRY is whatever
 * `resolveEntry` hands back; the collector treats it as opaque and never
 * derives a page's identity from it.
 */
export interface StrictPageDirectory {
  /** Entry names in the backend's listing order. REJECTS raw when it cannot be listed, `ENOENT` included. */
  listNames(): Promise<string[]>;
  /**
   * The named entry, or `null` when it is absent or resolves outside this
   * directory. REJECTS raw on a genuine fault; a fault is never `null`.
   */
  resolveEntry(name: string): Promise<string | null>;
  /**
   * Lend the entry's bytes to `read`, for the duration of that call only. THIS
   * method owns the classification: `absent` when the entry is not there or is
   * not trustworthy evidence, `unreadable` when reading it faulted. That
   * includes an error `read` itself throws. It MAY ALSO REJECT raw, when a
   * genuine fault occurs before the entry can be opened.
   */
  readEntryThrough<T>(entry: string, read: (bytes: PositionalBytes) => Promise<T>): Promise<RetainedEntryRead<T>>;
}

/** A project whose root resolved. */
export interface CitationProject {
  /**
   * The page directory at `relDir`, or `null` when nothing is at exactly that
   * place (absent, or a link, even one that stays inside the project). REJECTS
   * raw on a genuine fault.
   */
  openPageDirectory(relDir: string): Promise<StrictPageDirectory | null>;
  /** Where pending candidates are listed and read from: the existing record-directory binding. */
  candidateDirs: LegacyLocalRecordDirs;
}

/** Everything the collector reads. */
export interface AnswerCitationSources {
  /** The project, or `null` when its root does not resolve. REJECTS raw on a genuine fault. */
  resolveProject(): Promise<CitationProject | null>;
}

/** Preserve collector order, filename identity, and string-only viewer aliases. */
async function collectRetainedDirectory(project: CitationProject, dir: string, pageDirectory: RetainedCitationTarget["pageDirectory"]): Promise<RetainedCitationTarget[]> {
  const directory = await project.openPageDirectory(dir);
  if (!directory) return [];
  const retained: RetainedCitationTarget[] = [];
  for (const file of await directoryFiles(directory)) {
    if (!file.endsWith(".md")) continue;
    const entry = await directory.resolveEntry(file);
    if (!entry) continue;
    const read = await directory.readEntryThrough(entry, readResolutionFrontmatter);
    if (read.kind === "unreadable") throw read.cause;
    if (read.kind !== "ok") continue;
    const slug = file.slice(0, -3);
    const aliases = Array.isArray(read.value.aliases)
      ? read.value.aliases.filter((alias): alias is string => typeof alias === "string") : [];
    retained.push({ id: `${pageDirectory}/${slug}`, pageDirectory, slug, aliases });
  }
  return retained;
}

/** Directory disappearance is benign; genuine listing failures are not. */
async function directoryFiles(directory: StrictPageDirectory): Promise<string[]> {
  try { return await directory.listNames(); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/** Collect resolution metadata without caching or acquiring a project lock. */
export function collectAnswerCitationIndex(root: string): Promise<AnswerCitationIndex> {
  return collectAnswerCitationIndexFrom(diskAnswerCitationSources(root));
}

/**
 * {@link collectAnswerCitationIndex}, with every read made through `sources`.
 * Strictly in sequence: the project, then all of concepts, then all of queries,
 * then the candidates. A fault in the retained half rejects before any
 * candidate is listed.
 */
export async function collectAnswerCitationIndexFrom(sources: AnswerCitationSources): Promise<AnswerCitationIndex> {
  const project = await sources.resolveProject();
  if (!project) return { retained: [], pending: [] };
  const concepts = await collectRetainedDirectory(project, CONCEPTS_DIR, "concepts");
  const queries = await collectRetainedDirectory(project, QUERIES_DIR, "queries");
  const candidates = await listCandidatesFrom(project.candidateDirs, STRICT_IO);
  const pending = candidates.filter((candidate) => !candidate.targetEntityType
    && (candidate.targetDirectory === undefined || candidate.targetDirectory === "concepts" || candidate.targetDirectory === "queries")
    // Approval writes the literal filename slug: normalization must not invent a
    // future target that the production bare-slug resolver could never match.
    && candidate.slug.length > 0 && slugify(candidate.slug) === candidate.slug)
    .map((candidate) => ({ target: candidate.slug, candidateId: candidate.id }));
  return { retained: [...concepts, ...queries], pending };
}

/**
 * LOCAL DISK. The page directory already verified at `expectedDir`, an absolute
 * resolved path. An entry is its resolved path. The read lends the REAL Node
 * handle through the handle-bound, no-follow page read, whose safety argument
 * is the open handle and the identity check made on it; that is why it stays
 * physical. Its one rejecting path is a genuine fault resolving the entry again.
 */
function diskPageDirectory(expectedDir: string): StrictPageDirectory {
  return {
    listNames: () => listDirectoryNames(expectedDir),
    resolveEntry: async (name) => {
      const real = await safeRealpath(path.join(expectedDir, name), STRICT_IO);
      return !real || !isInsideDir(real, expectedDir) ? null : real;
    },
    readEntryThrough: (entry, read) => readConfinedPageThrough(entry, expectedDir, read, STRICT_IO),
  };
}

/** LOCAL DISK. The project at `canonicalRoot`, already resolved. Building it does no I/O. */
function diskCitationProject(canonicalRoot: string): CitationProject {
  return {
    openPageDirectory: async (relDir) => {
      const expectedDir = path.join(canonicalRoot, relDir);
      if (await safeRealpath(expectedDir, STRICT_IO) !== expectedDir) return null;
      return diskPageDirectory(expectedDir);
    },
    candidateDirs: diskLocalRecordDirs(canonicalRoot),
  };
}

/** LOCAL DISK. The sources of an ordinary local project rooted at `root`. Building them does no I/O. */
function diskAnswerCitationSources(root: string): AnswerCitationSources {
  return {
    resolveProject: async () => {
      const canonicalRoot = await safeRealpath(root, STRICT_IO);
      return canonicalRoot ? diskCitationProject(canonicalRoot) : null;
    },
  };
}
