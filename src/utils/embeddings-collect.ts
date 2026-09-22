/**
 * Eligible-live-page assembly for the v3 embedding writer (spec §4.4/§4.5).
 *
 * Produces the `CollectedPage[]` the writer feeds into both the migration
 * ({@link EligibleLivePage}) and the re-embed pass: every page that is live on
 * disk, passes its embedding-eligibility predicate ({@link pageEmbedSurfaces}),
 * and — for typed pages — is profile-VALID. A both-false typed page (neither
 * search nor context) is NEVER collected, so it is never sent to the provider.
 *
 * Sources:
 *  - concepts/queries — via the confined {@link collectPageRecords}; both
 *    surfaces always eligible (subject to the legacy orphaned/untitled gate).
 *  - typed entity pages — via {@link collectEntityPages}; keyed by their branded
 *    `EntityId`, gated by the entity type's `RetrievalDef` and profile validity.
 *    A symlinked-escaping typed page is dropped by the collector before its
 *    bytes are read.
 *
 * Each collected page carries its retrieval text + live `embeddingTextHash` /
 * `chunkContentHashes` (computed with the SAME `hashChunkText` the store uses),
 * so the migration can content-verify a preserved vector without re-reading.
 */

import { stat } from "node:fs/promises";
import path from "node:path";
import { CONCEPTS_DIR, QUERIES_DIR } from "./constants.js";
import { collectNamespacedPageRecords, buildEmbeddingText } from "./embeddings-pages.js";
import { hashChunkText, splitIntoChunks } from "./retrieval.js";
import { parseQualifiedPageId, qualifiedPageId, type PageId } from "./page-id.js";
import { pageEmbedSurfaces } from "./embed-eligibility.js";
import { collectEntityPages, invalidEntityPagePaths } from "../profile/collect.js";
import { isDefaultProfile } from "../profile/default.js";
import type { LoadedProfile } from "../profile/types.js";
import type { EligibleLivePage } from "./embeddings-migrate.js";
import type { PageRecord } from "../pages/read.js";

/** An eligible live page plus the material the re-embed pass needs. */
export interface CollectedPage extends EligibleLivePage {
  /** The page's title — re-embedded into the page vector and stored on records. */
  title: string;
  /** The page's summary — part of the embedding text. */
  summary: string;
  /** The page body, already split into chunk texts (one per `chunkContentHashes`). */
  chunkTexts: string[];
  /** The exact text passed to the provider for the page-level embedding. */
  embeddingText: string;
}

/**
 * Collect every eligible, valid, live page across reserved + typed namespaces.
 * The result is keyed by qualified `pageId`; a both-false or profile-invalid
 * typed page is omitted entirely (never embedded — S2 privacy).
 *
 * @param root - Project root path.
 * @param profile - The resolved profile (default → only concepts/queries).
 * @returns Collected pages with retrieval text + live hashes.
 */
export async function collectEligibleLivePages(
  root: string,
  profile: LoadedProfile,
): Promise<CollectedPage[]> {
  const reserved = await collectReservedPages(root);
  if (isDefaultProfile(profile.profile)) return reserved;
  const typed = await collectTypedPages(root, profile);
  return [...reserved, ...typed];
}

/** What the disk says about one requested page: present, PROVABLY absent, or not answerable right now. */
export type PageExistence = "present" | "absent" | "unknown";

/** Only a missing path (or a missing parent) proves absence; every other failure is transient. */
const ABSENT_CODES: ReadonlySet<string> = new Set(["ENOENT", "ENOTDIR"]);

/**
 * Whether each requested page id still EXISTS on disk, eligible for embedding or
 * not: a reserved-namespace page under its fixed directory, a typed page under
 * the directory its entity declares. The embedding lifecycle needs this to tell a
 * DELETED page (settle its tombstone) from a page that is merely ineligible right
 * now (keep retrying until eligibility returns). Only ENOENT/ENOTDIR prove
 * absence; EACCES, EIO, and every other failure answer "unknown", which keeps the
 * retry. An id whose namespace no profile entity or reserved directory owns cannot
 * exist, so it is absent.
 */
export async function requestedPagesExistence(root: string, profile: LoadedProfile, requested: PageId[]): Promise<Map<PageId, PageExistence>> {
  const out = new Map<PageId, PageExistence>();
  for (const pageId of requested) {
    const parsed = parseQualifiedPageId(pageId);
    const directory = parsed === null ? null : pageDirectoryFor(parsed.namespace, profile);
    if (parsed === null || directory === null) { out.set(pageId, "absent"); continue; }
    out.set(pageId, await fileExistence(path.join(root, directory, `${parsed.pagePart}.md`)));
  }
  return out;
}

async function fileExistence(filePath: string): Promise<PageExistence> {
  try {
    return (await stat(filePath)).isFile() ? "present" : "absent";
  } catch (error) {
    return ABSENT_CODES.has(String((error as NodeJS.ErrnoException).code)) ? "absent" : "unknown";
  }
}

/** The project-relative directory a namespace's pages live in, or null when nothing owns it. */
function pageDirectoryFor(namespace: string, profile: LoadedProfile): string | null {
  if (namespace === path.basename(CONCEPTS_DIR)) return CONCEPTS_DIR;
  if (namespace === path.basename(QUERIES_DIR)) return QUERIES_DIR;
  return profile.profile.entities[namespace]?.directory ?? null;
}

/** Collect concept + query pages (both surfaces eligible, legacy gate applies). */
async function collectReservedPages(root: string): Promise<CollectedPage[]> {
  const tagged = await collectNamespacedPageRecords(root);
  return tagged.map(({ namespace, record }) =>
    toCollectedPage(qualifiedPageId(namespace, record.slug), record),
  );
}

/** Collect typed entity pages, gated by eligibility + profile validity. */
async function collectTypedPages(root: string, profile: LoadedProfile): Promise<CollectedPage[]> {
  const { pages, problems } = await collectEntityPages(root, profile.profile);
  const invalidPaths = invalidEntityPagePaths(problems);
  const out: CollectedPage[] = [];
  for (const page of pages) {
    const retrieval = profile.profile.entities[page.entityType]?.retrieval;
    const isProfileInvalid = invalidPaths.has(page.filePath);
    const surfaces = pageEmbedSurfaces({ meta: page.frontmatter, pageKind: "typed", retrieval, isProfileInvalid });
    if (!surfaces.embedded) continue;
    const record: PageRecord = {
      slug: page.slug,
      title: page.title ?? page.slug,
      summary: typeof page.frontmatter.summary === "string" ? page.frontmatter.summary : "",
      body: page.body.trim(),
    };
    out.push(toCollectedPage(qualifiedPageId(page.entityType, page.slug), record));
  }
  return out;
}

/** Build a {@link CollectedPage} from a pageId + record, computing live hashes. */
function toCollectedPage(pageId: PageId, record: PageRecord): CollectedPage {
  const embeddingText = buildEmbeddingText(record);
  const chunkTexts = splitIntoChunks(record.body);
  return {
    pageId,
    bareSlug: record.slug,
    embeddingTextHash: hashChunkText(embeddingText),
    chunkContentHashes: chunkTexts.map(hashChunkText),
    title: record.title,
    summary: record.summary,
    chunkTexts,
    embeddingText,
  };
}
