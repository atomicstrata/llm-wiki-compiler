/**
 * @file src/portable/scoped/coverage.ts
 * @description What a scoped proposal covered, stated honestly, and how its
 * candidates are bounded and guarded before they are persisted.
 *
 * Every source the proposal could read — named or admitted — is accounted
 * for. It is UNCHANGED when its durable record already matches its bytes and
 * nothing was generated for it; COMPLETE only when every concept its
 * extraction produced has a kept candidate; otherwise INCOMPLETE with the
 * reason: a candidate the floor blocked, one the bounds dropped, a target
 * whose authoritative co-owners were not all in scope, or no candidate at all.
 * Sources on the deferred frontier are incomplete by definition. Only complete
 * sources can ever get a completion record, and only at an apply that writes
 * all of their pages.
 */

import type { ReviewCandidate } from "../../utils/types.js";
import type { SkippedItem } from "../contracts.js";
import { PortableRefusal } from "../errors.js";
import type { Closure, OwnershipView } from "./closure.js";
import { SCOPED_HOST_CEILINGS, type CompileScopeV2, type IncompleteReasonV2 } from "./contracts.js";
import type { DroppedCandidate } from "./bounded-access.js";

/** The candidates kept, and why each other one was not. */
export interface BoundedCandidates {
  kept: ReviewCandidate[];
  skipped: SkippedItem[];
  /** Slug → why its candidate was not kept. */
  reasons: Map<string, IncompleteReasonV2>;
  /** Co-owners found on kept-out targets that are outside the scope: they join the frontier. */
  coOwners: string[];
}

/** The part of a declared scope coverage is computed from: its named sources and its bounds. */
export type CoverageScope = Pick<CompileScopeV2, "sources" | "bounds">;

/** The coverage record of one proposal over scope shape `S`, with incomplete reasons `R`. */
export interface CoverageOf<S, R> {
  scope: S;
  expanded: readonly string[];
  complete: readonly string[];
  unchanged: readonly string[];
  incomplete: readonly { source: string; reason: R }[];
  deferredFrontier: readonly string[];
}

/** What the coverage of one proposal is computed from. */
interface CoverageInput<S extends CoverageScope = CompileScopeV2, R extends string = never> {
  scope: S;
  closure: Closure;
  /** Slugs a path held back before bounding, each with its own reason: never generated into a write. */
  held?: ReadonlyMap<string, R>;
  /** Every candidate the compile emitted: kept, floor-blocked, bounded out or dropped at emission. */
  emitted: readonly DroppedCandidate[];
  bounded: BoundedCandidates;
  /** Slugs of candidates the emission bounds dropped before their bodies were retained. */
  droppedSlugs: ReadonlySet<string>;
  unchanged: ReadonlySet<string>;
}

/** Why one required concept has no kept candidate. */
function reasonFor<R extends string>(
  slug: string, input: CoverageInput<CoverageScope, R>, floorBlocked: ReadonlySet<string>,
): IncompleteReasonV2 | R {
  const held = input.held?.get(slug);
  if (held !== undefined) return held;
  if (floorBlocked.has(slug)) return "floor_blocked";
  const bounded = input.bounded.reasons.get(slug);
  if (bounded !== undefined) return bounded;
  return input.droppedSlugs.has(slug) ? "candidate_limit" : "not_generated";
}

/**
 * The owners of `path` outside `readable`, collecting at most `limit + 1`: a
 * target owned by corpus-many sources never materializes them all.
 */
function outsideOwners(snapshot: OwnershipView | undefined, path: string, readable: ReadonlySet<string>, limit: number): string[] {
  const outside: string[] = [];
  for (const owner of snapshot?.owners.get(path) ?? []) {
    if (readable.has(owner)) continue;
    outside.push(owner);
    if (outside.length > limit) break;
  }
  return outside;
}

/**
 * Keep candidates whose target's authoritative co-owners are all readable,
 * while the count and the total body bytes stay within their bounds. A target
 * a co-owner outside the scope also owns is deferred, never generated alone.
 */
export function boundCandidates(
  allowed: readonly ReviewCandidate[], skippedSoFar: readonly SkippedItem[], scope: Pick<CompileScopeV2, "bounds">,
  guard: { pathOf: (candidate: ReviewCandidate) => string; snapshot: OwnershipView | undefined; readable: ReadonlySet<string> },
): BoundedCandidates {
  const bounded: BoundedCandidates = { kept: [], skipped: [...skippedSoFar], reasons: new Map(), coOwners: [] };
  const coOwners = new Set<string>();
  let bytes = 0;
  for (const candidate of allowed) {
    const path = guard.pathOf(candidate);
    const outside = outsideOwners(guard.snapshot, path, guard.readable, SCOPED_HOST_CEILINGS.maxFrontier);
    for (const owner of outside) coOwners.add(owner);
    if (coOwners.size > SCOPED_HOST_CEILINGS.maxFrontier) throw new PortableRefusal("limit_exceeded", "shared-concept frontier");
    const size = Buffer.byteLength(candidate.body, "utf8");
    if (outside.length > 0) {
      bounded.skipped.push({ path, code: "limit_exceeded" });
      bounded.reasons.set(candidate.slug, "deferred");
    } else if (bounded.kept.length < scope.bounds.maxCandidates && bytes + size <= scope.bounds.maxCandidateBytes) {
      bounded.kept.push(candidate);
      bytes += size;
    } else {
      bounded.skipped.push({ path, code: "limit_exceeded" });
      bounded.reasons.set(candidate.slug, "candidate_limit");
    }
  }
  bounded.coOwners.push(...[...coOwners].sort());
  return bounded;
}

/** Every concept slug one source's extraction produced, as its candidates recorded them. */
function requiredSlugs(source: string, emitted: readonly DroppedCandidate[]): string[] {
  const slugs = new Set<string>();
  for (const candidate of emitted) {
    if (!candidate.sources.includes(source)) continue;
    slugs.add(candidate.slug);
    for (const slug of candidate.sourceStates?.[source]?.concepts ?? []) slugs.add(slug);
  }
  return [...slugs].sort();
}

/** The frontier: the closure's, plus co-owners met on deferred targets, bounded by the host ceiling. */
function frontierOf(closure: Closure, bounded: BoundedCandidates): string[] {
  const frontier = [...new Set([...closure.frontier, ...bounded.coOwners])].sort();
  if (frontier.length > SCOPED_HOST_CEILINGS.maxFrontier) throw new PortableRefusal("limit_exceeded", "shared-concept frontier");
  return frontier;
}

/** The coverage record of one proposal. */
function coverageOf<S extends CoverageScope, R extends string = never>(
  input: CoverageInput<S, R>, floorBlocked: ReadonlySet<string>,
): CoverageOf<S, IncompleteReasonV2 | R> {
  const { scope, closure, emitted, bounded } = input;
  const keptSlugs = new Set(bounded.kept.map((candidate) => candidate.slug));
  const readable = [...new Set([...scope.sources.names, ...closure.expanded])].sort();
  const complete: string[] = [];
  const unchanged: string[] = [];
  const incomplete: { source: string; reason: IncompleteReasonV2 | R }[] = [];
  for (const source of readable) {
    const required = requiredSlugs(source, emitted);
    if (required.length === 0) {
      if (input.unchanged.has(source)) unchanged.push(source);
      else incomplete.push({ source, reason: "not_generated" });
      continue;
    }
    const missing = required.find((slug) => !keptSlugs.has(slug));
    if (missing === undefined) complete.push(source);
    else incomplete.push({ source, reason: reasonFor(missing, input, floorBlocked) });
  }
  const frontier = frontierOf(closure, bounded);
  for (const source of frontier) incomplete.push({ source, reason: "deferred" });
  return { scope, expanded: closure.expanded, complete, unchanged, incomplete, deferredFrontier: frontier };
}

/** What a bounded plan is settled from. */
export interface SettleInput<S extends CoverageScope, R extends string> {
  scope: S;
  closure: Closure;
  bounded: BoundedCandidates;
  /** The candidates the content floor saw, and those it allowed. */
  floored: readonly ReviewCandidate[];
  allowed: readonly ReviewCandidate[];
  held?: ReadonlyMap<string, R>;
  pathOfSlug: (slug: string) => string;
}

/**
 * Settle a bounded plan: every candidate the emission bounds dropped is
 * reported skipped, the floor-blocked ones are named, and the coverage of
 * what was kept is stated. Shared by every scoped path.
 */
export function settledCoverage<S extends CoverageScope, R extends string = never>(
  access: { candidates: readonly ReviewCandidate[]; dropped: readonly DroppedCandidate[]; unchangedSources(): Set<string> },
  input: SettleInput<S, R>,
): CoverageOf<S, IncompleteReasonV2 | R> {
  const { bounded } = input;
  const floorBlocked = new Set(input.floored.filter((candidate) => !input.allowed.includes(candidate)).map((candidate) => candidate.slug));
  for (const dropped of access.dropped) bounded.skipped.push({ path: input.pathOfSlug(dropped.slug), code: "limit_exceeded" });
  return coverageOf({
    scope: input.scope, closure: input.closure, held: input.held, emitted: [...access.candidates, ...access.dropped], bounded,
    droppedSlugs: new Set(access.dropped.map((dropped) => dropped.slug)), unchanged: access.unchangedSources(),
  }, floorBlocked);
}
