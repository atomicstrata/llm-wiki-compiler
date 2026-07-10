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

import { collectNamespacedPageRecords, buildEmbeddingText } from "./embeddings-pages.js";
import { hashChunkText, splitIntoChunks } from "./retrieval.js";
import { qualifiedPageId, type PageId } from "./page-id.js";
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
