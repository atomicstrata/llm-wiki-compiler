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

import path from "node:path";
import { diskLocalEntityScans } from "../storage/disk-local-reads.js";
import type { LegacyLocalEntityScans } from "../storage/legacy-local-reads.js";
import { CONCEPTS_DIR, QUERIES_DIR } from "./constants.js";
import {
  buildEmbeddingText,
  collectNamespacedPageRecordsFrom,
  diskEmbeddingPageReads,
  type EmbeddingPageReads,
} from "./embeddings-pages.js";
import { hashChunkText, splitIntoChunks } from "./retrieval.js";
import { sha256Text } from "../connectors/hash.js";
import { parseQualifiedPageId, qualifiedPageId, type PageId } from "./page-id.js";
import { pageEmbedSurfaces } from "./embed-eligibility.js";
import { collectEntityPagesFrom, invalidEntityPagePaths } from "../profile/collect.js";
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

/** Hex digits kept from SHA-256: enough to detect content changes, never used for integrity. */
const CONTENT_HASH_HEX_LENGTH = 16;

/**
 * Identify everything the embedding provider receives for a page: its page-level
 * text and every body chunk, in order. Embedding retry budgets and exclusions are
 * bound to this value, so changed content is never treated as already failed.
 */
export function pageContentHash(page: Pick<EligibleLivePage, "embeddingTextHash" | "chunkContentHashes">): string {
  return sha256Text([page.embeddingTextHash, ...page.chunkContentHashes].join("\n")).slice(0, CONTENT_HASH_HEX_LENGTH);
}

/** Each collected page's live content hash, keyed by pageId. */
export function contentHashesOf(collected: CollectedPage[]): ReadonlyMap<PageId, string> {
  return new Map(collected.map(page => [page.pageId, pageContentHash(page)]));
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
  // `async` so that a throw while the disk mechanisms are built REJECTS.
  return collectEligibleLivePagesFrom({ pages: diskEmbeddingPageReads(root), entities: diskLocalEntityScans(root) }, profile);
}

/** What the eligible-page collector reads: the reserved-page reads, and the entity-directory scans for typed pages. */
export interface EmbeddingCollectSources {
  readonly pages: EmbeddingPageReads;
  readonly entities: LegacyLocalEntityScans;
}

/**
 * {@link collectEligibleLivePages} over `sources`: THE ONE BODY. Reserved pages
 * first; the default profile stops there, before any entity scan; then typed
 * pages in entity declaration order, gated by eligibility and profile validity.
 */
export async function collectEligibleLivePagesFrom(
  sources: EmbeddingCollectSources,
  profile: LoadedProfile,
): Promise<CollectedPage[]> {
  const reserved = await collectReservedPages(sources.pages);
  if (isDefaultProfile(profile.profile)) return reserved;
  const typed = await collectTypedPages(sources.entities, profile);
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
  // `async` so that a throw while the disk mechanisms are built REJECTS.
  return requestedPagesExistenceFrom(diskEmbeddingPageReads(root), profile, requested);
}

/** {@link requestedPagesExistence} over `reads`: THE ONE BODY. Which directory owns an id, and what each error means, are decided here. */
export async function requestedPagesExistenceFrom(
  reads: EmbeddingPageReads,
  profile: LoadedProfile,
  requested: PageId[],
): Promise<Map<PageId, PageExistence>> {
  const located = requested.map((pageId) => ({ pageId, file: pageFileFor(pageId, profile) }));
  const listed = await listingsOfCrowdedDirectories(reads, located.flatMap(({ file }) => (file ? [file.directory] : [])));
  const out = new Map<PageId, PageExistence>();
  for (const { pageId, file } of located) {
    if (file === null || listed.get(file.directory)?.(file.name)) { out.set(pageId, "absent"); continue; }
    // The locator is POSIX project-relative, matching the declared-directory convention (see `isRegularFile`).
    out.set(pageId, await fileExistence(reads, path.posix.join(file.directory, file.name)));
  }
  return out;
}

/** Where a requested page's file would be, or null when no directory owns its namespace (so it cannot exist). */
function pageFileFor(pageId: PageId, profile: LoadedProfile): { directory: string; name: string } | null {
  const parsed = parseQualifiedPageId(pageId);
  const directory = parsed === null ? null : pageDirectoryFor(parsed.namespace, profile);
  return parsed === null || directory === null ? null : { directory, name: `${parsed.pagePart}.md` };
}

/** Requests at or above this many in one directory list it once instead of stat-ing each name the listing proves missing. */
const LISTING_MIN_REQUESTS = 8;

/** A test of whether a listing PROVES a name absent; `false` means "stat it". */
type ProvesAbsent = (name: string) => boolean;

/**
 * One listing per directory that holds at least {@link LISTING_MIN_REQUESTS}
 * requested pages. A listing only ever PROVES absence; a name it shows is
 * still stat-ed, so "present" and every "unknown" keep their single source.
 */
async function listingsOfCrowdedDirectories(reads: EmbeddingPageReads, directories: string[]): Promise<Map<string, ProvesAbsent>> {
  const counts = new Map<string, number>();
  for (const directory of directories) counts.set(directory, (counts.get(directory) ?? 0) + 1);
  const out = new Map<string, ProvesAbsent>();
  for (const [directory, count] of counts) {
    if (count < LISTING_MIN_REQUESTS) continue;
    const provesAbsent = await absenceFromListing(reads, directory);
    if (provesAbsent) out.set(directory, provesAbsent);
  }
  return out;
}

/** Plain ASCII without `~`: the only names whose absence a listing can prove on every filesystem. */
const LISTING_COMPARABLE_NAME = /^[\x20-\x7d]*$/;

/**
 * What one listing of `directory` proves. A missing directory (ENOENT/ENOTDIR)
 * proves every name absent, exactly as each stat would have; any other failure
 * proves nothing. Names are compared ASCII-case-folded and only when both sides
 * are plain ASCII without `~`, because a stat may resolve a name the listing
 * spells differently: case-insensitive volumes, Unicode normalization, and
 * Windows 8.3 short names (`PAGE~1.md`).
 */
async function absenceFromListing(reads: EmbeddingPageReads, directory: string): Promise<ProvesAbsent | null> {
  let names: string[];
  try {
    names = await reads.listRelativeNames(directory);
  } catch (error) {
    return ABSENT_CODES.has(String((error as NodeJS.ErrnoException).code)) ? () => true : null;
  }
  if (!names.every((name) => LISTING_COMPARABLE_NAME.test(name))) return null;
  const folded = new Set(names.map((name) => name.toLowerCase()));
  return (name) => LISTING_COMPARABLE_NAME.test(name) && !folded.has(name.toLowerCase());
}

/** One page file's existence: a regular file is present; only a missing path or parent proves absence. */
async function fileExistence(reads: EmbeddingPageReads, relPath: string): Promise<PageExistence> {
  try {
    return (await reads.isRegularFile(relPath)) ? "present" : "absent";
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
async function collectReservedPages(reads: EmbeddingPageReads): Promise<CollectedPage[]> {
  const tagged = await collectNamespacedPageRecordsFrom(reads);
  return tagged.map(({ namespace, record }) =>
    toCollectedPage(qualifiedPageId(namespace, record.slug), record),
  );
}

/** Collect typed entity pages, gated by eligibility + profile validity. */
async function collectTypedPages(entities: LegacyLocalEntityScans, profile: LoadedProfile): Promise<CollectedPage[]> {
  const { pages, problems } = await collectEntityPagesFrom(entities, profile.profile);
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
