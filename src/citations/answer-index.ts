/**
 * Fresh resolution snapshots in production concepts-then-queries scan order.
 * Retained metadata uses the shared handle-bound confinement proof and borrows
 * the streaming reader; pending records use existing candidate admission with
 * strict I/O enabled. No cache or mutation lock is owned here, so a publication
 * caller can collect fresh state while already holding its project lock.
 */
import { readdir } from "fs/promises";
import path from "path";
import type { AnswerCitationIndex, RetainedCitationTarget } from "./answer-types.js";
import type { PageDirectory } from "../export/types.js";
import { CONCEPTS_DIR, QUERIES_DIR } from "../utils/constants.js";
import { isInsideDir, safeRealpath } from "../utils/path-confine.js";
import { readConfinedPageWith } from "../utils/confined-read.js";
import { listCandidates } from "../compiler/candidate-read.js";
import { slugify } from "../utils/markdown.js";
import { readResolutionFrontmatter } from "./frontmatter-reader.js";

const STRICT_IO = { strictIo: true };

/** Preserve collector order, filename identity, and string-only viewer aliases. */
async function collectRetainedDirectory(root: string, dir: string, pageDirectory: PageDirectory): Promise<RetainedCitationTarget[]> {
  const expectedDir = path.join(root, dir);
  if (await safeRealpath(expectedDir, STRICT_IO) !== expectedDir) return [];
  const retained: RetainedCitationTarget[] = [];
  for (const file of await directoryFiles(expectedDir)) {
    if (!file.endsWith(".md")) continue;
    const real = await safeRealpath(path.join(expectedDir, file), STRICT_IO);
    if (!real || !isInsideDir(real, expectedDir)) continue;
    const read = await readConfinedPageWith(real, expectedDir, readResolutionFrontmatter, STRICT_IO);
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
async function directoryFiles(dir: string): Promise<string[]> {
  try { return await readdir(dir); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/** Collect resolution metadata without caching or acquiring a project lock. */
export async function collectAnswerCitationIndex(root: string): Promise<AnswerCitationIndex> {
  const canonicalRoot = await safeRealpath(root, STRICT_IO);
  if (!canonicalRoot) return { retained: [], pending: [] };
  const concepts = await collectRetainedDirectory(canonicalRoot, CONCEPTS_DIR, "concepts");
  const queries = await collectRetainedDirectory(canonicalRoot, QUERIES_DIR, "queries");
  const candidates = await listCandidates(canonicalRoot, STRICT_IO);
  const pending = candidates.filter((candidate) => !candidate.targetEntityType
    && (candidate.targetDirectory === undefined || candidate.targetDirectory === "concepts" || candidate.targetDirectory === "queries")
    // Approval writes the literal filename slug: normalization must not invent a
    // future target that the production bare-slug resolver could never match.
    && candidate.slug.length > 0 && slugify(candidate.slug) === candidate.slug)
    .map((candidate) => ({ target: candidate.slug, candidateId: candidate.id }));
  return { retained: [...concepts, ...queries], pending };
}
