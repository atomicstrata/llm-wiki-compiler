/**
 * Live page registry: a reader-side foundation that resolves qualified PageIds
 * to on-disk pages through confined, handle-bound reads — never via a
 * reconstructed `path.join(root, slug)` call.
 *
 * Two tiers are exposed:
 *
 *   1. **Cheap live-id `Set<PageId>`** (`buildLiveIdSet`) — built metadata-only
 *      via `scanEntityDir` with `includeBody:false`. No page body is read.
 *
 *   2. **Lazy `LiveRegistryEntry`** (`buildLiveRegistryEntry`) — resolves one
 *      page's realpath through the confinement layer and computes its live
 *      `embeddingTextHash` and `chunkHashes` using the SAME deterministic hash
 *      the chunk store uses (`hashChunkText`). The body read goes through
 *      `readConfinedPage` (handle-bound), so a symlinked-escaping page is
 *      dropped before any bytes are returned.
 *
 *   Loaders (`loadPageRecordsByPageId`, `loadSelectedPagesByPageId`) resolve
 *   each pageId via the registry entry → read through `readConfinedPage`. An
 *   absent, malformed, or escaping id is dropped (never read out-of-tree).
 *
 * Namespace → directory resolution:
 *   - `concepts` → `CONCEPTS_DIR` (`wiki/concepts`)
 *   - `queries`  → `QUERIES_DIR`  (`wiki/queries`)
 *   - a typed entity namespace → `profile.entities[namespace].directory`
 *   - unknown namespace → dropped (never falls back to `wiki/<namespace>`)
 */

import path from "path";
import { safeRealpath, isInsideDir } from "./path-confine.js";
import { readConfinedPage } from "./confined-read.js";
import { scanEntityDir, type RawEntityScan } from "../wiki/collect.js";
import { parseFrontmatter } from "./markdown.js";
import { qualifiedPageId, parseQualifiedPageId, type PageId } from "./page-id.js";
import { hashChunkText, splitIntoChunks } from "./retrieval.js";
import { buildEmbeddingText } from "./embeddings-pages.js";
import { pageEmbedSurfaces } from "./embed-eligibility.js";
import { isSlugSafe } from "../profile/identity.js";
import { validateEntityFields } from "../profile/field-contract.js";
import { CONCEPTS_DIR, QUERIES_DIR } from "./constants.js";
import type { PageRecord } from "../pages/read.js";
import type { ProfilePack, LoadedProfile, EntityTypeDef } from "../profile/types.js";

/** Immutable realpath + confinement anchor for one live page. */
export interface LiveRegistryEntry {
  /** Realpath captured at resolve time; used as the `readConfinedPage` argument. */
  capturedRealpath: string;
  /** The canonical directory the file must stay inside. */
  expectedCanonicalDir: string;
  /** SHA-256 prefix of `buildEmbeddingText({title, summary})`. */
  embeddingTextHash: string;
  /** Ordered hashes of `splitIntoChunks(body)`, one per chunk. */
  chunkHashes: string[];
}

/**
 * Build a namespace→project-relative-directory map from the reserved namespaces
 * (`concepts`/`queries`) and optionally from a profile's declared entity types.
 * An unknown namespace (not reserved, not declared) has no entry and is dropped.
 *
 * @param profile - Optional profile pack; when present each entity type's
 *   `directory` is added under its entity-type name as the namespace key.
 */
export function buildNamespaceDirs(profile?: ProfilePack): Map<string, string> {
  const map = new Map<string, string>();
  map.set("concepts", CONCEPTS_DIR);
  map.set("queries", QUERIES_DIR);
  if (profile) {
    for (const [entityType, def] of Object.entries(profile.entities)) {
      map.set(entityType, def.directory);
    }
  }
  return map;
}

/** Reserved namespace names that use the legacy concept/query eligibility gate. */
const RESERVED_NAMESPACES = new Set(["concepts", "queries"]);

/**
 * True when a concept/query scan passes the legacy eligibility gate: the page
 * must be live (not orphaned) AND titled. Mirrors the WRITE gate in
 * `readConfinedPageRecord` so orphaned/untitled pages cannot resurrect from a
 * stale or forged v3 store (F2).
 */
function isLegacyScanEligible(scan: RawEntityScan): boolean {
  return scan.parseStatus.orphaned !== true && scan.parseStatus.hasTitle;
}

/** A retrieval surface a typed page's `RetrievalDef` flag is consulted for. */
type SurfaceName = "search" | "context";

/**
 * True when a typed-namespace scan is PROFILE-VALID: slug-safe stem, any declared
 * frontmatter `slug` matches the stem, and the field contract is satisfied.
 * The shared precondition for every typed-page eligibility decision (embed-set,
 * search-fallback, context-fallback) — separated from the surface-flag check so
 * each caller can ask its own surface question without re-deriving validity.
 */
function isTypedScanProfileValid(scan: RawEntityScan, def: EntityTypeDef): boolean {
  if (!isSlugSafe(scan.stem)) return false;
  const declaredSlug = typeof scan.frontmatter.slug === "string" ? scan.frontmatter.slug : undefined;
  if (declaredSlug !== undefined && declaredSlug !== scan.stem) return false;
  return validateEntityFields(scan.frontmatter, def).length === 0;
}

/**
 * True when a profile-valid typed scan is eligible for the given retrieval
 * SURFACE: its entity type's `includeInSearch` (search) / `includeInContext`
 * (context) flag is not `false`. Routes through `pageEmbedSurfaces` so the
 * read-side fallback and the write gate share one truth table (F2/F3).
 */
function isTypedScanSurfaceEligible(scan: RawEntityScan, def: EntityTypeDef, surface: SurfaceName): boolean {
  if (!isTypedScanProfileValid(scan, def)) return false;
  const surfaces = pageEmbedSurfaces({ meta: scan.frontmatter, pageKind: "typed", retrieval: def.retrieval, isProfileInvalid: false });
  return surface === "search" ? surfaces.inSearch : surfaces.inContext;
}

/**
 * True when a typed-namespace scan passes the writer's embed-eligibility gate:
 * profile-valid (slug-safe, no field violations, slug matches stem) AND
 * `pageEmbedSurfaces` embedded (the entity type's RetrievalDef says embedded).
 * Mirrors `collectTypedPages` + `pageEmbedSurfaces` so the read prefilter and
 * the write gate never diverge (F2).
 */
function isTypedScanEligible(scan: RawEntityScan, def: EntityTypeDef): boolean {
  if (!isTypedScanProfileValid(scan, def)) return false;
  const surfaces = pageEmbedSurfaces({ meta: scan.frontmatter, pageKind: "typed", retrieval: def.retrieval, isProfileInvalid: false });
  return surfaces.embedded;
}

/**
 * Build a `Set<PageId>` of ALL EMBED-ELIGIBLE live pages across `namespaces`,
 * reading ONLY page metadata (no body I/O). Uses `scanEntityDir` with
 * `includeBody:false` so large-body pages are never read just to build the id set.
 *
 * Applies the SAME eligibility predicate as the writer (`pageEmbedSurfaces`):
 * - concepts/queries: legacy gate — non-orphaned AND titled.
 * - typed pages: profile-valid (slug-safe, field-contract satisfied) AND embedded
 *   per the entity type's `RetrievalDef`.
 *
 * An ineligible page's `pageId` is absent from the returned set, so a v3 store
 * entry for it fails the prefilter — it can never be ranked or rehydrated, even
 * from a stale or forged store (F2).
 *
 * An unknown namespace (not in `namespaceDirs`) is silently skipped.
 *
 * @param root - Project root path (raw; canonicalized internally).
 * @param namespaces - Namespace names to scan (e.g. `["concepts", "queries"]`).
 * @param namespaceDirs - Namespace→dir map; defaults to reserved concepts/queries.
 * @param profile - Active loaded profile; required for typed-namespace eligibility.
 * @returns Qualified page ids for all embed-eligible pages across the namespaces.
 */
export async function buildLiveIdSet(
  root: string,
  namespaces: string[],
  namespaceDirs?: Map<string, string>,
  profile?: LoadedProfile,
): Promise<Set<PageId>> {
  const dirs = namespaceDirs ?? buildNamespaceDirs();
  const ids = new Set<PageId>();
  await Promise.all(
    namespaces.map(async (ns) => {
      const relDir = dirs.get(ns);
      if (!relDir) return;
      const { scans } = await scanEntityDir(root, relDir, { includeBody: false });
      for (const scan of scans) {
        if (!isScanEligible(scan, ns, profile)) continue;
        ids.add(qualifiedPageId(ns, scan.stem));
      }
    }),
  );
  return ids;
}

/**
 * True when a scan passes the embed-eligibility gate for its namespace:
 * reserved namespaces use the legacy gate; typed namespaces use the profile gate.
 * A typed namespace with no profile is treated as eligible (no gate to apply).
 */
function isScanEligible(scan: RawEntityScan, ns: string, profile?: LoadedProfile): boolean {
  if (RESERVED_NAMESPACES.has(ns)) return isLegacyScanEligible(scan);
  if (!profile) return true; // no profile → no gate for typed namespaces
  const def = profile.profile.entities[ns];
  if (!def) return false; // unknown typed namespace → drop
  return isTypedScanEligible(scan, def);
}

/**
 * Resolve a single `pageId` to its on-disk realpath and compute its live
 * hashes — `embeddingTextHash` over `buildEmbeddingText({title, summary})` and
 * `chunkHashes` over `splitIntoChunks(body)`. Both use `hashChunkText` so live
 * values are byte-comparable to stored chunk `contentHash` values.
 *
 * The body read goes through `readConfinedPage` (handle-bound). A page whose
 * realpath escapes the expected directory returns `null` (fail closed).
 * An unknown namespace (not in `namespaceDirs`) returns `null`.
 *
 * @param root - Project root path.
 * @param pageId - Qualified page id (`<namespace>/<pagePart>`).
 * @param namespaceDirs - Namespace→dir map; defaults to reserved concepts/queries.
 * @returns A `LiveRegistryEntry` or `null` if the page is absent / out-of-tree.
 */
export async function buildLiveRegistryEntry(
  root: string,
  pageId: PageId,
  namespaceDirs?: Map<string, string>,
): Promise<LiveRegistryEntry | null> {
  const parsed = parseQualifiedPageId(pageId);
  if (!parsed) return null;
  const { namespace, pagePart } = parsed;
  const dirs = namespaceDirs ?? buildNamespaceDirs();
  const relDir = dirs.get(namespace);
  if (!relDir) return null;
  const canonicalRoot = await safeRealpath(root);
  if (!canonicalRoot) return null;
  const expectedCanonicalDir = path.join(canonicalRoot, relDir);
  const filePath = path.join(expectedCanonicalDir, `${pagePart}.md`);
  const capturedRealpath = await safeRealpath(filePath);
  if (!capturedRealpath || !isInsideDir(capturedRealpath, expectedCanonicalDir)) return null;
  const content = await readConfinedPage(capturedRealpath, expectedCanonicalDir);
  if (content === null) return null;
  return buildEntryFromContent(capturedRealpath, expectedCanonicalDir, content);
}

/** Build a `LiveRegistryEntry` from already-read confined content. */
function buildEntryFromContent(
  capturedRealpath: string,
  expectedCanonicalDir: string,
  content: string,
): LiveRegistryEntry {
  const { meta, body } = parseFrontmatter(content);
  const title = typeof meta.title === "string" ? meta.title : "";
  const summary = typeof meta.summary === "string" ? meta.summary : "";
  const embeddingTextHash = hashChunkText(buildEmbeddingText({ title, summary }));
  const chunkHashes = splitIntoChunks(body).map(hashChunkText);
  return { capturedRealpath, expectedCanonicalDir, embeddingTextHash, chunkHashes };
}

/**
 * Resolve each `pageId` to its content via the live registry. Absent,
 * malformed, and symlink-escaping ids are silently dropped — they are NEVER
 * read out-of-tree. The read goes through `readConfinedPage` (handle-bound).
 *
 * @param root - Project root path.
 * @param pageIds - Qualified page ids to resolve.
 * @param namespaceDirs - Namespace→dir map; defaults to reserved concepts/queries.
 * @returns `PageRecord` objects for all found, readable pages.
 */
export async function loadPageRecordsByPageId(
  root: string,
  pageIds: PageId[],
  namespaceDirs?: Map<string, string>,
): Promise<PageRecord[]> {
  const dirs = namespaceDirs ?? buildNamespaceDirs();
  const records: PageRecord[] = [];
  for (const pageId of pageIds) {
    const record = await resolvePageRecord(root, pageId, dirs);
    if (record) records.push(record);
  }
  return records;
}

/**
 * Resolve a selected set of page refs (qualified page ids) to `PageRecord`s.
 * Functionally identical to `loadPageRecordsByPageId` — exposed as a
 * separate entry point so callers can pass a refs list without type confusion.
 *
 * @param root - Project root path.
 * @param refs - Qualified page ids to resolve.
 * @param namespaceDirs - Namespace→dir map; defaults to reserved concepts/queries.
 * @returns `PageRecord` objects for all found, readable pages.
 */
export async function loadSelectedPagesByPageId(
  root: string,
  refs: PageId[],
  namespaceDirs?: Map<string, string>,
): Promise<PageRecord[]> {
  return loadPageRecordsByPageId(root, refs, namespaceDirs);
}

/** A resolved page record paired with the qualified `pageId` it was loaded from. */
export interface PageRecordWithId {
  pageId: PageId;
  record: PageRecord;
}

/**
 * Resolve each `pageId` to its content like {@link loadPageRecordsByPageId}, but
 * pair every found record with the qualified `pageId` it came from. Absent /
 * malformed / escaping ids are dropped (same confined read). Callers that must
 * render a page under its namespace (e.g. answer grounding) use this so a
 * same-slug `concepts/foo` and `papers/foo` stay distinguishable.
 *
 * @param root - Project root path.
 * @param pageIds - Qualified page ids to resolve.
 * @param namespaceDirs - Namespace→dir map; defaults to reserved concepts/queries.
 * @returns `{pageId, record}` pairs for all found, readable pages.
 */
export async function loadPageRecordPairsByPageId(
  root: string,
  pageIds: PageId[],
  namespaceDirs?: Map<string, string>,
): Promise<PageRecordWithId[]> {
  const dirs = namespaceDirs ?? buildNamespaceDirs();
  const pairs: PageRecordWithId[] = [];
  for (const pageId of pageIds) {
    const record = await resolvePageRecord(root, pageId, dirs);
    if (record) pairs.push({ pageId, record });
  }
  return pairs;
}

/**
 * Resolve a single `pageId` to a `PageRecord` through the confined read.
 * Returns `null` when the id is absent, malformed, escapes the tree, or names
 * an unknown namespace.
 */
async function resolvePageRecord(
  root: string,
  pageId: PageId,
  dirs: Map<string, string>,
): Promise<PageRecord | null> {
  const parsed = parseQualifiedPageId(pageId);
  if (!parsed) return null;
  const { namespace, pagePart } = parsed;
  const relDir = dirs.get(namespace);
  if (!relDir) return null;
  const canonicalRoot = await safeRealpath(root);
  if (!canonicalRoot) return null;
  const expectedDir = path.join(canonicalRoot, relDir);
  const filePath = path.join(expectedDir, `${pagePart}.md`);
  const capturedRealpath = await safeRealpath(filePath);
  if (!capturedRealpath || !isInsideDir(capturedRealpath, expectedDir)) return null;
  const content = await readConfinedPage(capturedRealpath, expectedDir);
  if (content === null) return null;
  return parsePageRecord(content, pagePart);
}

/** Parse raw confined content into a `PageRecord`. */
function parsePageRecord(content: string, pagePart: string): PageRecord {
  const { meta, body } = parseFrontmatter(content);
  return {
    slug: pagePart,
    title: typeof meta.title === "string" ? meta.title : pagePart,
    summary: typeof meta.summary === "string" ? meta.summary : "",
    body: body.trim(),
  };
}

/** A live, surface-eligible page candidate for LLM fallback selection. */
export interface SurfaceCandidate {
  pageId: PageId;
  slug: string;
  title: string;
  summary: string;
}

/** Read a frontmatter field as a string, defaulting to `""` when absent/non-string. */
function frontmatterString(meta: Record<string, unknown>, key: string): string {
  const value = meta[key];
  return typeof value === "string" ? value : "";
}

/** Project a scan into a `SurfaceCandidate` under `namespace`, reading title/summary. */
function scanToCandidate(scan: RawEntityScan, namespace: string): SurfaceCandidate {
  return {
    pageId: qualifiedPageId(namespace, scan.stem),
    slug: scan.stem,
    title: frontmatterString(scan.frontmatter, "title"),
    summary: frontmatterString(scan.frontmatter, "summary"),
  };
}

/**
 * Collect the surface-eligible candidates for ONE namespace. Reserved namespaces
 * use the legacy gate (non-orphaned AND titled); a typed namespace requires the
 * profile + its entity `def` and passes the profile-validity + surface-flag gate.
 * An unknown namespace, or a typed namespace with no profile/def, yields none.
 */
async function collectNamespaceCandidates(
  root: string,
  surface: SurfaceName,
  namespace: string,
  relDir: string,
  profile?: LoadedProfile,
): Promise<SurfaceCandidate[]> {
  const { scans } = await scanEntityDir(root, relDir, { includeBody: false });
  const def = profile?.profile.entities[namespace];
  return scans
    .filter((scan) =>
      RESERVED_NAMESPACES.has(namespace)
        ? isLegacyScanEligible(scan)
        : Boolean(def) && isTypedScanSurfaceEligible(scan, def as EntityTypeDef, surface),
    )
    .map((scan) => scanToCandidate(scan, namespace));
}

/**
 * Enumerate live pages across `namespaces` ELIGIBLE for the given retrieval
 * surface ("search"|"context"), carrying title+summary for LLM fallback
 * selection. Same eligibility as the semantic prefilter:
 *   - concepts/queries: legacy gate (non-orphaned AND titled);
 *   - typed: profile-valid (slug-safe, slug matches stem, field-contract ok)
 *     AND the entity type's surface flag (includeInSearch for "search",
 *     includeInContext for "context") !== false  [via pageEmbedSurfaces].
 * An opted-out / both-false / profile-invalid typed page is NEVER returned, so a
 * confidential typed page's id/title can never reach the fallback selector LLM.
 *
 * @param root - Project root path (raw; canonicalized internally).
 * @param surface - Retrieval surface whose flag a typed namespace is gated by.
 * @param namespaces - Namespace names to enumerate (reserved + typed).
 * @param namespaceDirs - Namespace→dir map; defaults to reserved concepts/queries.
 * @param profile - Active loaded profile; required for typed-namespace eligibility.
 * @returns Surface-eligible candidates across the namespaces (metadata only).
 */
export async function buildSurfaceEligibleCandidates(
  root: string,
  surface: SurfaceName,
  namespaces: string[],
  namespaceDirs?: Map<string, string>,
  profile?: LoadedProfile,
): Promise<SurfaceCandidate[]> {
  const dirs = namespaceDirs ?? buildNamespaceDirs();
  const perNamespace = await Promise.all(
    namespaces.map((ns) => {
      const relDir = dirs.get(ns);
      if (!relDir) return Promise.resolve<SurfaceCandidate[]>([]);
      return collectNamespaceCandidates(root, surface, ns, relDir, profile);
    }),
  );
  return perNamespace.flat();
}
