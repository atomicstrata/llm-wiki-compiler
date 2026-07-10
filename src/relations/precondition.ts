/**
 * @file src/relations/precondition.ts
 * @description The PURE relation-count precondition checker: decides whether an
 * entity ENTERING a lifecycle state satisfies its declared
 * `transitionRelationRequirements`, given the already-read live-valid relations
 * and an injected endpoint FACTS resolver.
 *
 * PURE / LOCK-FREE / DETERMINISTIC. This function reads NO store, acquires NO
 * lock, and holds no ambient state — the caller does the lock-free read (via
 * {@link readLiveValidRelations}) and supplies both the relations and the
 * `resolveEndpoint` facts resolver. Isolating the count semantics here lets them
 * be proven adversarially in a unit test, apart from any I/O.
 *
 * The count semantics are deliberately strict — a precondition is a SECURITY
 * gate, so every rule fails toward NOT counting:
 *   1. Object-scope: only relations whose `role`-side endpoint id EXACTLY equals
 *      THIS entity's full branded id count — another entity's relations never do.
 *   2. Type + role: `rel.type === req.relationType` and this entity is on
 *      `req.role`.
 *   3. otherTypes: if set, the OTHER endpoint's entity type must be one of them.
 *   4. Validity: the other endpoint must resolve to {@link EndpointFacts} via
 *      `resolveEndpoint` — a `null` (dangling, fabricated, or field-contract-
 *      VIOLATING endpoint page) is dropped. Mere on-disk existence is NOT
 *      evidence; the resolver vouches the endpoint is profile-valid.
 *   5. otherStates: if set, the endpoint's facts must carry a lifecycle `state`
 *      that is one of them. FAIL-CLOSED: an endpoint with no lifecycle (or no
 *      lifecycle-field value) never qualifies under a state-filtered requirement.
 *   6. Distinct: DISTINCT other-endpoint ids are counted, not records — two
 *      relations to the SAME other endpoint count as one.
 * A requirement is unmet when its distinct-qualifying count is below `minCount`.
 *
 * SCOPE: this reports unmet-vs-satisfied over the RELATIONS it is GIVEN (it assumes
 * `liveValidRelations` is the trusted live set — a sick/unreadable STORE is the
 * caller's concern). But it DOES own the ENDPOINT read via `resolveEndpoint`, so it
 * distinguishes a genuinely-unqualifying endpoint (`null` → not counted) from an
 * UNREADABLE one: a resolver that throws {@link EndpointUnreadableError} PROPAGATES
 * out of this function ("cannot verify THIS endpoint"), so the caller can park a
 * healthy run rather than terminally deny it on a transient endpoint read fault.
 */

import pLimit from "p-limit";
import { entityId, parseEntityId, EntityIdError } from "../profile/identity.js";
import type { EntityId, LifecycleDef, RelationCountReq } from "../profile/types.js";
import type { RelationRef } from "./types.js";

/**
 * Max concurrent endpoint resolutions per requirement. A hub entity can be the
 * target of thousands of candidate relations; resolving them all at once opens a
 * handle per candidate and can EXHAUST file descriptors (EMFILE) — inside the
 * caller's held project lock — turning a healthy check into a self-inflicted
 * fault. This bounds the fan-out so the check never starves the process of fds.
 */
const ENDPOINT_RESOLVE_CONCURRENCY = 16;

/**
 * Thrown by an {@link EndpointResolver} when an endpoint page could not be READ
 * (a raw I/O fault: `EACCES` on a permission-restricted page, `EMFILE`/`ENFILE`
 * under fd pressure, `EIO` on a mid-read fault) — as opposed to a page that is
 * genuinely ABSENT or contract-invalid (which resolves to `null`). This is
 * "cannot verify THIS endpoint", NOT "the endpoint does not qualify": the checker
 * lets it propagate so a caller can PARK/retry a healthy run rather than
 * terminally deny it on a transient read fault. Mirrors the store-read leg's
 * unverifiable split, one level down at the endpoint-evidence leg.
 */
export class EndpointUnreadableError extends Error {
  constructor(cause: Error) {
    super(`endpoint page unreadable: ${cause.message}`, { cause });
    this.name = "EndpointUnreadableError";
  }
}

/**
 * One candidate relation edge that was found (correct type/role/otherTypes) but
 * did NOT count toward a requirement, and why: `not-evidence` (the endpoint is
 * dangling, fabricated, or field-contract-invalid) or `wrong-state` (the endpoint
 * resolved but its lifecycle `state` is not in the requirement's `otherStates`).
 * Carried on {@link UnmetRelationRequirement} so a denial can name the specific
 * offending edge instead of a bare "found 0".
 */
export interface RejectedCandidate {
  id: EntityId;
  reason: "not-evidence" | "wrong-state";
  state?: string;
}

/**
 * One relation-count precondition that is NOT satisfied. `needed` is the declared
 * `minCount`; `actual` is the distinct-existing count actually found. `rejected`
 * (when present) lists the matching edges that did NOT count and why, and
 * `otherStates` echoes the state filter — together they make a downstream denial
 * message name the specific shortfall (no edge vs dangling edge vs wrong state).
 */
export interface UnmetRelationRequirement {
  relationType: string;
  role: "from" | "to";
  otherTypes?: string[];
  otherStates?: string[];
  needed: number;
  actual: number;
  rejected?: RejectedCandidate[];
}

/**
 * The facts a resolver vouches for a QUALIFYING endpoint: one that parses, is a
 * declared type, has an on-disk confined page, AND satisfies its type's field
 * contract. `state` carries the endpoint's current lifecycle-field value when its
 * type declares a lifecycle and the page carries a string value — `undefined`
 * otherwise, so the `otherStates` filter can fail closed on it.
 */
export interface EndpointFacts {
  /** The endpoint's current lifecycle state, when declared and present. */
  state?: string;
}

/** Resolve an endpoint id to its {@link EndpointFacts}, or `null` when it does not qualify. */
export type EndpointResolver = (id: EntityId) => Promise<EndpointFacts | null>;

/**
 * A precomputed lookup of a relation's OTHER endpoints by `(type, role, own-id)`,
 * so a per-page precondition check is an O(1) map hit instead of a full linear
 * scan of every live relation. Built ONCE (see {@link buildRelationEndpointIndex})
 * and shared across all gated pages by the standing check — turning its
 * O(pages × requirements × relations) scan into O(relations + pages × requirements).
 */
export interface RelationEndpointIndex {
  /** The other-endpoint ids of relations of `relationType` with `ownId` on the `role` side (with duplicates). */
  others(relationType: string, role: "from" | "to", ownId: EntityId): EntityId[];
}

/** Separator joining the index-key fields; a NUL byte cannot appear in a type/role/id, so no value can forge a bucket boundary. */
const ENDPOINT_INDEX_SEPARATOR = "\0";

/** The index key for one `(type, role, own-id)` bucket, its fields NUL-joined so no value can forge a boundary. */
function endpointIndexKey(relationType: string, role: "from" | "to", ownId: EntityId): string {
  return `${relationType}${ENDPOINT_INDEX_SEPARATOR}${role}${ENDPOINT_INDEX_SEPARATOR}${ownId}`;
}

/**
 * Build the {@link RelationEndpointIndex} over `relations` in one pass. Each
 * relation is bucketed under BOTH sides — `(type, "from", rel.from) → rel.to` and
 * `(type, "to", rel.to) → rel.from` — so either role's lookup is a single map hit.
 */
export function buildRelationEndpointIndex(relations: RelationRef[]): RelationEndpointIndex {
  const buckets = new Map<string, EntityId[]>();
  const add = (type: string, role: "from" | "to", own: EntityId, other: EntityId): void => {
    const key = endpointIndexKey(type, role, own);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(other);
    else buckets.set(key, [other]);
  };
  for (const rel of relations) {
    add(rel.type, "from", rel.from, rel.to);
    add(rel.type, "to", rel.to, rel.from);
  }
  return { others: (type, role, ownId) => buckets.get(endpointIndexKey(type, role, ownId)) ?? [] };
}

/** Inputs to {@link checkRelationPreconditions}; grouped to keep the arg list small. */
export interface RelationPreconditionArgs {
  /** This entity's type (half of its branded id). */
  entityType: string;
  /** This entity's slug (the other half of its branded id). */
  slug: string;
  /** The lifecycle state being ENTERED, whose preconditions are checked. */
  enteredState: string;
  /** The governing lifecycle def carrying `transitionRelationRequirements`. */
  lifecycle: LifecycleDef;
  /** The live, profile-valid relations, already read LOCK-FREE by the caller. */
  liveValidRelations: RelationRef[];
  /** Facts resolver: `null` means the endpoint does NOT qualify as valid evidence. */
  resolveEndpoint: EndpointResolver;
  /**
   * An OPTIONAL precomputed {@link RelationEndpointIndex} over `liveValidRelations`.
   * When supplied (the standing check builds it ONCE across all gated pages), the
   * candidate lookup is an O(1) map hit instead of a linear scan; when omitted (the
   * write path, one page) the checker scans `liveValidRelations` directly.
   */
  relationIndex?: RelationEndpointIndex;
}

/** The own- (role-side) and other- (opposite-side) endpoint ids of a relation for a role. */
function endpointsForRole(rel: RelationRef, role: "from" | "to"): { own: EntityId; other: EntityId } {
  return role === "from" ? { own: rel.from, other: rel.to } : { own: rel.to, other: rel.from };
}

/**
 * Does the OTHER endpoint pass the `otherTypes` filter? Omitted `otherTypes` means
 * "any type qualifies". An id whose entity type cannot be parsed is treated as NOT
 * passing (fail toward not counting) when a filter is present.
 */
function otherTypeAllowed(otherId: EntityId, otherTypes: string[] | undefined): boolean {
  if (otherTypes === undefined) return true;
  try {
    return otherTypes.includes(parseEntityId(otherId).entityType);
  } catch (err) {
    if (err instanceof EntityIdError) return false;
    throw err;
  }
}

/**
 * The other-endpoint ids of the relations matching one requirement's type + role +
 * object-scope (this entity EXACTLY on the `role` side), WITH duplicates — from the
 * precomputed index when given (O(1)), else a linear scan of `relations`.
 */
function matchingOtherIds(
  selfId: EntityId,
  req: RelationCountReq,
  relations: RelationRef[],
  index: RelationEndpointIndex | undefined,
): EntityId[] {
  if (index !== undefined) return index.others(req.relationType, req.role, selfId);
  const out: EntityId[] = [];
  for (const rel of relations) {
    if (rel.type !== req.relationType) continue;
    const { own, other } = endpointsForRole(rel, req.role);
    if (own === selfId) out.push(other);
  }
  return out;
}

/**
 * The DISTINCT other-endpoint ids of the relations that qualify for one
 * requirement: correct type, this entity exactly on the `role` side (object-scope),
 * and the other endpoint passing the `otherTypes` filter. Validity + state are
 * checked separately (async) on this deduplicated set so `resolveEndpoint` runs
 * once per distinct endpoint.
 */
function distinctQualifyingOtherIds(
  selfId: EntityId,
  req: RelationCountReq,
  relations: RelationRef[],
  index: RelationEndpointIndex | undefined,
): EntityId[] {
  const seen = new Set<string>();
  const out: EntityId[] = [];
  for (const other of matchingOtherIds(selfId, req, relations, index)) {
    if (!otherTypeAllowed(other, req.otherTypes)) continue;
    if (seen.has(other)) continue;
    seen.add(other);
    out.push(other);
  }
  return out;
}

/**
 * Does `facts` pass the requirement's optional `otherStates` filter? Omitted
 * means "any state (or no lifecycle)". FAIL-CLOSED when present: facts with no
 * `state` (type has no lifecycle, or the page carries no value) never pass.
 */
function stateAllowed(facts: EndpointFacts, otherStates: string[] | undefined): boolean {
  if (otherStates === undefined) return true;
  return facts.state !== undefined && otherStates.includes(facts.state);
}

/** How many distinct candidates COUNTED, and the breakdown of those that did not. */
interface CandidateTally {
  counted: number;
  rejected: RejectedCandidate[];
}

/** Classify one resolved candidate: it counts, or it is rejected with a reason. */
function classifyResolved(id: EntityId, facts: EndpointFacts | null, otherStates: string[] | undefined): RejectedCandidate | null {
  if (facts === null) return { id, reason: "not-evidence" };
  if (stateAllowed(facts, otherStates)) return null; // counts
  return facts.state === undefined ? { id, reason: "wrong-state" } : { id, reason: "wrong-state", state: facts.state };
}

/**
 * Resolve every distinct candidate (bounded fan-out) and tally how many qualify
 * under `req`, recording the rejected ones. An {@link EndpointUnreadableError}
 * from the resolver PROPAGATES (a read fault is "cannot verify", not "rejected").
 */
async function tallyCandidates(candidates: EntityId[], req: RelationCountReq, resolveEndpoint: EndpointResolver): Promise<CandidateTally> {
  const limit = pLimit(ENDPOINT_RESOLVE_CONCURRENCY);
  const resolved = await Promise.all(candidates.map((id) => limit(async () => ({ id, facts: await resolveEndpoint(id) }))));
  const rejected: RejectedCandidate[] = [];
  for (const { id, facts } of resolved) {
    const reject = classifyResolved(id, facts, req.otherStates);
    if (reject !== null) rejected.push(reject);
  }
  return { counted: candidates.length - rejected.length, rejected };
}

/** Build the {@link UnmetRelationRequirement} record for a shortfall, omitting absent optional filters. */
function unmet(req: RelationCountReq, tally: CandidateTally): UnmetRelationRequirement {
  const base: UnmetRelationRequirement = { relationType: req.relationType, role: req.role, needed: req.minCount, actual: tally.counted };
  if (req.otherTypes !== undefined) base.otherTypes = req.otherTypes;
  if (req.otherStates !== undefined) base.otherStates = req.otherStates;
  if (tally.rejected.length > 0) base.rejected = tally.rejected;
  return base;
}

/**
 * Decide whether an entity entering `enteredState` satisfies its relation-count
 * preconditions. Returns the list of UNMET requirements — an empty array means all
 * preconditions are satisfied (or the state declares none).
 *
 * See the file overview for the strict, fail-toward-not-counting semantics. Pure
 * and lock-free: reads no store and acquires no lock, operating only on its args.
 *
 * @param args - The entity identity, entered state, lifecycle, live-valid
 *   relations (already read lock-free), and the endpoint facts resolver.
 * @returns The unmet requirements (empty when every precondition is satisfied).
 */
export async function checkRelationPreconditions(
  args: RelationPreconditionArgs,
): Promise<UnmetRelationRequirement[]> {
  const reqs = args.lifecycle.transitionRelationRequirements?.[args.enteredState];
  if (reqs === undefined || reqs.length === 0) return [];
  const selfId = entityId(args.entityType, args.slug);
  const unmetReqs: UnmetRelationRequirement[] = [];
  for (const req of reqs) {
    const candidates = distinctQualifyingOtherIds(selfId, req, args.liveValidRelations, args.relationIndex);
    const tally = await tallyCandidates(candidates, req, args.resolveEndpoint);
    if (tally.counted < req.minCount) unmetReqs.push(unmet(req, tally));
  }
  return unmetReqs;
}
