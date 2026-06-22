/**
 * @file src/context/typed-pages.ts
 * @description FIX F3: include a NON-DEFAULT profile's typed ENTITY PAGES in the
 * `llmwiki context` page POOL so they are LEXICALLY rankable (by prompt match —
 * no embeddings needed), selectable as primaries (body included), and reachable
 * through the snapshot graph's relation edges. The context builder ranks
 * `snapshot.pages` (legacy concept/query pages); a typed-only project would
 * otherwise rank an EMPTY pool. Here we read the profile's entity pages and
 * splice them into a COPY of the snapshot's page list keyed by EntityId, so they
 * participate in ranking + primary selection + graph expansion.
 *
 * DEFAULT project → no typed pages added → the augmented snapshot IS the original
 * snapshot (byte-identical context). The SEMANTIC (embedding) retrieval of typed
 * pages remains the DEFERRED PR4 (embedding key-qualification): typed pages are
 * lexically rankable + graph-reachable NOW; semantic-search of them is pending.
 */

import { loadNonDefaultProfile } from "../profile/block.js";
import { collectEntityPages } from "../profile/collect.js";
import type { EntityProblem, EntityProblemKind } from "../profile/collect.js";
import type { EntityPage } from "../profile/types.js";
import type { PageDirectory } from "../export/types.js";
import type { ClaimCitation } from "../utils/types.js";
import type { PageFreshness } from "../freshness/types.js";
import type { PageId, ViewerPage, ViewerSnapshot } from "../viewer/types.js";

/** Neutral freshness for a synthetic typed page (never source-tracked → unverified, never stale/contradicted). */
const NEUTRAL_FRESHNESS: PageFreshness = {
  freshnessStatus: "unverified",
  contradicted: false,
  archived: false,
};

/**
 * Project one collected {@link EntityPage} into a {@link ViewerPage}-shaped pool
 * entry keyed by its branded `EntityId`. The id IS the EntityId (so a relation
 * edge endpoint resolves to this page in the graph); `slug` keeps the validated
 * stem; `title` falls back to the slug; `body` carries the page prose so the
 * lexical ranker can match on it and the primary entry can include it. The
 * `pageDirectory` carries the entity TYPE (cast at this single boundary — typed
 * pages live only in the context pool, never the viewer's concept/query routes).
 * No wikilinks/citations/warnings — typed pages reach neighbors via relation edges.
 */
function entityPageToViewerPage(page: EntityPage): ViewerPage {
  return {
    id: page.id as unknown as PageId,
    slug: page.slug,
    pageDirectory: page.entityType as PageDirectory,
    title: page.title ?? page.slug,
    filePath: page.filePath,
    frontmatter: page.frontmatter,
    body: page.body,
    outgoingLinks: [] as PageId[],
    citations: [] as ClaimCitation[],
    warnings: [],
    freshness: NEUTRAL_FRESHNESS,
  };
}

/**
 * Problem kinds that INVALIDATE a typed page against its profile contract: a
 * page carrying any of these does not satisfy its declared field contract and so
 * must not be promoted as clean agent evidence. (`field-violation` is the only
 * one a PRODUCED page can carry — a non-slug-safe / slug-mismatch page is dropped
 * by the collector before it becomes a page — but the full set is listed so the
 * exclusion stays correct if the collector ever produces a page despite them.)
 */
const INVALIDATING_PROBLEM_KINDS: ReadonlySet<EntityProblemKind> = new Set([
  "field-violation",
  "non-slug-safe-filename",
  "slug-mismatch",
]);

/** Absolute `filePath`s of every page carrying an invalidating profile-contract problem. */
function invalidPagePaths(problems: EntityProblem[]): ReadonlySet<string> {
  const paths = new Set<string>();
  for (const problem of problems) {
    if (problem.filePath !== undefined && INVALIDATING_PROBLEM_KINDS.has(problem.kind)) {
      paths.add(problem.filePath);
    }
  }
  return paths;
}

/**
 * Return a snapshot whose `pages` pool ADDITIVELY includes the active non-default
 * profile's typed entity pages (FIX F3). For the built-in DEFAULT profile (or any
 * read error) the ORIGINAL snapshot is returned UNCHANGED, so the default context
 * pack is byte-identical. The typed pages are APPENDED after the legacy pages so
 * the legacy-page order — and thus the default ranking — is untouched.
 *
 * Profile-INVALID typed pages are EXCLUDED from the context pool: a page that the
 * collector flags with a field-contract problem (matched to the page by its
 * absolute `filePath`) is never promoted as clean primary evidence to the agent.
 * The violation is still surfaced to the user through status/lint — context
 * simply must not rank an unvalidated/invalid page as evidence.
 *
 * @param root - Absolute project root.
 * @param snapshot - The frozen viewer snapshot to augment.
 * @returns The snapshot, possibly with valid typed entity pages appended to `pages`.
 */
export async function augmentSnapshotWithTypedPages(
  root: string,
  snapshot: ViewerSnapshot,
): Promise<ViewerSnapshot> {
  const loaded = await loadNonDefaultProfile(root);
  if (loaded === undefined) return snapshot; // default profile → byte-identical pool
  let typed: ViewerPage[];
  try {
    const { pages, problems } = await collectEntityPages(root, loaded.profile);
    const invalid = invalidPagePaths(problems);
    typed = pages.filter((page) => !invalid.has(page.filePath)).map(entityPageToViewerPage);
  } catch {
    return snapshot; // a collector failure must not break context — fall back to the legacy pool
  }
  if (typed.length === 0) return snapshot;
  return { ...snapshot, pages: [...snapshot.pages, ...typed] };
}
