/**
 * @file src/profile/relation-standing.ts
 * @description The STANDING-INVARIANT read-side re-evaluation of relation-count
 * lifecycle preconditions.
 *
 * The write-side enforcer ({@link ../relations/enforce-precondition.js}) checks a
 * `transitionRelationRequirements` precondition only at the MOMENT a typed page
 * ENTERS a gated state. But relations are append-only and can later be
 * SUPERSEDED / COMPACTED / rendered dangling, and the profile can change — any of
 * which can leave a page STILL SITTING in a gated state whose precondition no
 * longer holds. This module surfaces that drift: it re-evaluates every entity page
 * CURRENTLY in a gated state against the CURRENT live-valid relation graph and
 * reports each standing violation.
 *
 * READ-ONLY + LOCK-FREE: it writes NOTHING and acquires NO lock. The relation
 * store is read EXACTLY ONCE per call (via the lock-free {@link readLiveValidRelations}),
 * and page state comes from the bounded frontmatter-only scan (no bodies). It
 * reuses the write path's PURE checker ({@link checkRelationPreconditions}) and the
 * write path's confined endpoint FACTS resolver ({@link makeEndpointFactsResolverFrom}),
 * so a standing check and a write agree, byte-for-byte, on both the count semantics
 * AND what "a qualifying endpoint" means (existing, field-contract-valid, and in
 * an allowed lifecycle state when the requirement filters on one).
 *
 * FAIL-CLOSED, two-outcome, mirroring the enforcer's split: a genuine standing
 * violation is a {@link LIFECYCLE_RELATION_UNMET_KIND} problem (ACTIONABLE — names
 * the entity, relation type, role, needed vs actual count); a store that cannot be
 * READ is a DISTINCT {@link LIFECYCLE_RELATION_UNVERIFIABLE_KIND} problem ("cannot
 * verify", never a crash). Both surface through the SAME `EntityProblemView`
 * channel every read surface already renders, so no surface reports a drifted
 * project as silently healthy and a raw store throw never crashes a read surface.
 *
 * OMITTED-FOR-DEFAULT: a profile that declares no gated state reads NOTHING and
 * returns `[]`; a profile that declares gating but has no page currently in a gated
 * state also reads no relations. So the built-in default (no lifecycles) and any
 * non-gated profile add zero problems and stay byte-identical.
 *
 * ONE BODY: {@link collectStandingRelationProblems} runs
 * {@link collectStandingRelationProblemsFrom} over local-disk
 * {@link StandingRelationSources}. Which types and pages are gated, both short
 * circuits, the single relation read and both "cannot verify" catches are
 * decided in that body; the sources only look.
 */

import { entityId, isSlugSafe } from "./identity.js";
import { diskEntityPageReads, type EntityPageReads } from "./lifecycle-read.js";
import { diskLocalEntityScans } from "../storage/disk-local-reads.js";
import type { LegacyLocalEntityScans } from "../storage/legacy-local-reads.js";
import { type GraphStoreReads } from "../utils/jsonl-store.js";
import { diskRelationGraphReads } from "../relations/graph-reads.js";
import { scanEntityDirFrom } from "../wiki/collect.js";
import type { EntityId, EntityProblemView, EntityTypeDef, LifecycleDef, ProfilePack } from "./types.js";
import type { RelationRef } from "../relations/types.js";
import {
  buildRelationEndpointIndex,
  checkRelationPreconditions,
  EndpointUnreadableError,
  type EndpointResolver,
  type RelationEndpointIndex,
  type UnmetRelationRequirement,
} from "../relations/precondition.js";
import { readLiveValidRelationsFrom } from "../relations/live-valid.js";
import { isStoreUnavailable, makeEndpointFactsResolverFrom, describeUnmet } from "../relations/enforce-precondition.js";

/** Problem `kind` for a page whose gated-state relation precondition no longer holds. */
export const LIFECYCLE_RELATION_UNMET_KIND = "lifecycle-relation-requirement-unmet" as const;
/** Problem `kind` for a standing check that could NOT read the relation store. */
export const LIFECYCLE_RELATION_UNVERIFIABLE_KIND = "lifecycle-relation-requirement-unverifiable" as const;

/** An entity type whose lifecycle DECLARES at least one gated state (relation precondition). */
interface GatedType {
  entityType: string;
  def: EntityTypeDef;
  lifecycle: LifecycleDef;
}

/** A specific page CURRENTLY sitting in a gated state, carrying its type + slug + state. */
interface GatedPage extends GatedType {
  slug: string;
  state: string;
}

/**
 * The entity types whose lifecycle declares a non-empty
 * `transitionRelationRequirements` — the only types whose pages CAN carry a
 * standing precondition. A profile with none short-circuits the whole check.
 */
function gatedTypes(profile: ProfilePack): GatedType[] {
  const out: GatedType[] = [];
  for (const [entityType, def] of Object.entries(profile.entities) as [string, EntityTypeDef][]) {
    const lifecycle = def.lifecycle;
    const reqs = lifecycle?.transitionRelationRequirements;
    if (lifecycle && reqs && Object.keys(reqs).length > 0) out.push({ entityType, def, lifecycle });
  }
  return out;
}

/**
 * The pages of one gated type that are CURRENTLY in a state declaring a relation
 * precondition, read frontmatter-only (no bodies). A non-slug-safe stem is skipped
 * (it is not an enrolled entity id), and a page whose current state declares no
 * requirement is not a standing concern.
 */
async function gatedPagesOfType(source: LegacyLocalEntityScans, type: GatedType): Promise<GatedPage[]> {
  const { scans } = await scanEntityDirFrom(source, type.def.directory, { includeBody: false });
  const out: GatedPage[] = [];
  for (const scan of scans) {
    const state = scan.frontmatter[type.lifecycle.field];
    if (typeof state !== "string" || !isSlugSafe(scan.stem)) continue;
    const reqs = type.lifecycle.transitionRelationRequirements?.[state];
    if (reqs !== undefined && reqs.length > 0) out.push({ ...type, slug: scan.stem, state });
  }
  return out;
}

/** Every page in the project currently sitting in a gated state, across all gated types. */
async function collectGatedPages(source: LegacyLocalEntityScans, types: GatedType[]): Promise<GatedPage[]> {
  const out: GatedPage[] = [];
  for (const type of types) out.push(...(await gatedPagesOfType(source, type)));
  return out;
}

/** The ACTIONABLE standing-violation problem for one page + one unmet requirement. */
function unmetProblem(page: GatedPage, req: UnmetRelationRequirement): EntityProblemView {
  return {
    kind: LIFECYCLE_RELATION_UNMET_KIND,
    entityType: page.entityType,
    path: `${page.def.directory}/${page.slug}.md`,
    message:
      `Entity ${page.entityType}/${page.slug} is in lifecycle state "${page.state}" whose relation ` +
      `precondition is no longer satisfied: ${describeUnmet(req)}.`,
  };
}

/** The DISTINCT "cannot verify" problem for a standing check whose store read failed closed. */
function unverifiableProblem(cause: Error): EntityProblemView {
  return {
    kind: LIFECYCLE_RELATION_UNVERIFIABLE_KIND,
    message: `Cannot verify standing relation preconditions: relation store unreadable (${cause.message}).`,
  };
}

/** Re-run the PURE checker for one gated page against the once-read live relations. */
async function standingProblemsForPage(
  page: GatedPage,
  relations: RelationRef[],
  resolveEndpoint: EndpointResolver,
  relationIndex: RelationEndpointIndex,
): Promise<EntityProblemView[]> {
  const unmet = await checkRelationPreconditions({
    entityType: page.entityType,
    slug: page.slug,
    enteredState: page.state,
    lifecycle: page.lifecycle,
    liveValidRelations: relations,
    resolveEndpoint,
    relationIndex,
  });
  return unmet.map((req) => unmetProblem(page, req));
}

/**
 * Re-evaluate every entity page CURRENTLY in a gated lifecycle state against the
 * CURRENT live-valid relation graph and return one problem per standing violation.
 *
 * READ-ONLY + LOCK-FREE (see the file overview): reads the relation store EXACTLY
 * ONCE, acquires no lock, writes nothing. A satisfied gated page, a non-gated page,
 * and a lifecycle-less profile all contribute NO problem. When the relation store
 * cannot be read, returns a SINGLE {@link LIFECYCLE_RELATION_UNVERIFIABLE_KIND}
 * problem instead of throwing, so no read surface crashes.
 *
 * @param root - Absolute project root directory.
 * @param profile - The CURRENT governing profile pack (its lifecycles gate).
 * @returns The standing-violation problems (empty when every gated page is satisfied
 *   or nothing is gated).
 */
export async function collectStandingRelationProblems(
  root: string,
  profile: ProfilePack,
): Promise<EntityProblemView[]> {
  return collectStandingRelationProblemsFrom(
    { scans: diskLocalEntityScans(root), graph: diskRelationGraphReads(root), pages: diskEntityPageReads(root) }, profile);
}

/**
 * Everything {@link collectStandingRelationProblemsFrom} reads. OWNED BY THE
 * STANDING CHECK: a narrow seam; not `ProjectStore`, not a hosted or
 * access-control contract, and it selects no backend. Nothing ties the three to
 * one project; production builds all from one root.
 */
export interface StandingRelationSources {
  /** The gated entity directories, frontmatter only, through the existing entity-scan binding. */
  scans: LegacyLocalEntityScans;
  /** The relation store, through the graph-store read; asked at most ONCE per call. */
  graph: GraphStoreReads;
  /** One confined page per DISTINCT relation endpoint. */
  pages: EntityPageReads;
}

/**
 * {@link collectStandingRelationProblems} over {@link StandingRelationSources}:
 * THE ONE BODY. No gated type reads nothing; no page in a gated state reads no
 * relations; then one relation read and the endpoint pages.
 */
export async function collectStandingRelationProblemsFrom(
  sources: StandingRelationSources,
  profile: ProfilePack,
): Promise<EntityProblemView[]> {
  const types = gatedTypes(profile);
  if (types.length === 0) return []; // no gating declared → read NOTHING
  const gated = await collectGatedPages(sources.scans, types);
  if (gated.length === 0) return []; // nothing currently gated → no relation read
  let relations: RelationRef[];
  try {
    relations = await readLiveValidRelationsFrom(sources.graph, profile); // ONE lock-free read
  } catch (err) {
    if (isStoreUnavailable(err)) return [unverifiableProblem(err as Error)];
    throw err; // a genuinely-unexpected error propagates (never masked as "cannot verify")
  }
  const resolveEndpoint = makeEndpointFactsResolverFrom(sources.pages, profile);
  const relationIndex = buildRelationEndpointIndex(relations); // built ONCE, shared across all gated pages
  const problems: EntityProblemView[] = [];
  try {
    for (const page of gated) problems.push(...(await standingProblemsForPage(page, relations, resolveEndpoint, relationIndex)));
  } catch (err) {
    // An endpoint page read fault is "cannot verify", never a crash and never a
    // silent "healthy" — surface it as the DISTINCT unverifiable standing problem.
    if (err instanceof EndpointUnreadableError) return [unverifiableProblem(err)];
    throw err;
  }
  return problems;
}
