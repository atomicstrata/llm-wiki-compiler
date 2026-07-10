/**
 * @file src/relations/enforce-precondition.ts
 * @description The SHARED, async relation-count precondition ENFORCER — the one
 * seam every live-apply write path composes to make a typed page enter a gated
 * lifecycle state only when its declared `transitionRelationRequirements` are
 * actually satisfied by the live relation graph.
 *
 * It wires together three already-built pieces so no write path re-derives them:
 *   1. the LOCK-FREE live+profile-valid relation read ({@link readLiveValidRelations}),
 *   2. the PURE count/validity/object-scope checker ({@link checkRelationPreconditions}),
 *   3. a LOCK-FREE endpoint FACTS resolver over the confined page reader that
 *      vouches an endpoint only when its page SATISFIES its type's field contract.
 *
 * FAIL-CLOSED, with a DELIBERATE two-error split so a downstream workflow can
 * tell a genuine denial apart from a transient one:
 *   - {@link RelationPreconditionUnmetError} — the store was READABLE and a
 *     precondition is genuinely NOT met (distinct-existing count < minCount). A
 *     HARD denial; the gated write must not land.
 *   - {@link RelationPreconditionUnverifiableError} — a read that BACKS the check
 *     could not complete: the relation store was unreadable (a store-sick throw)
 *     OR an endpoint page FAULTED on read (an {@link EndpointUnreadableError} from
 *     the facts resolver). This is "cannot verify", NOT "unmet"; still fail-closed
 *     (the gated write does not land), but a DISTINCT type so a caller can
 *     PARK/retry a healthy run rather than terminally fail it.
 *
 * LOCK-FREE INVARIANT: this enforcer acquires NOTHING — no project lock, no
 * `underLock`-wrapped API. It runs INSIDE the caller's already-held project lock
 * (the live-apply paths call it under that lock), so a self-acquire here would
 * release the held lock early (the `releaseLock` PID residual) or deadlock. Both
 * the relation read and the endpoint resolver are bare confined reads. Never add
 * locking here.
 */

import { parseEntityId, EntityIdError } from "../profile/identity.js";
import { readConfinedEntityFrontmatter } from "../profile/lifecycle-read.js";
import { validateEntityFields } from "../profile/field-contract.js";
import { lifecycleStates } from "../profile/validate-helpers.js";
import { GraphDirConfinementError } from "../utils/jsonl-store.js";
import type { EntityId, EntityTypeDef, LifecycleDef, ProfilePack } from "../profile/types.js";
import {
  checkRelationPreconditions,
  EndpointUnreadableError,
  type EndpointFacts,
  type EndpointResolver,
  type RejectedCandidate,
  type UnmetRelationRequirement,
} from "./precondition.js";
import { readLiveValidRelations } from "./live-valid.js";
import {
  RelationStoreCorruptError,
  RelationStoreTooNewError,
  RelationStoreSymlinkError,
  type RelationRef,
} from "./types.js";

/** How many rejected candidate edges a denial names before summarizing the rest. */
const MAX_REJECTED_SHOWN = 3;

/** Render one rejected candidate: dangling/invalid, or present-but-wrong-state. */
function describeRejected(rejected: RejectedCandidate, otherStates: string[] | undefined): string {
  if (rejected.reason === "not-evidence") return `${rejected.id} (endpoint missing or invalid)`;
  const allowed = otherStates ? `not in [${otherStates.join(", ")}]` : "not allowed";
  return `${rejected.id} (state ${JSON.stringify(rejected.state ?? "none")} ${allowed})`;
}

/**
 * The shortfall CLAUSE that names WHY a requirement is unmet: no matching edge at
 * all, or the specific edges that were found but did not count (dangling endpoint,
 * or wrong lifecycle state). Empty when the shortfall is purely "not enough
 * distinct edges" (the `needs N but found M` base already says that).
 */
function describeShortfall(req: UnmetRelationRequirement): string {
  const rejected = req.rejected ?? [];
  if (rejected.length === 0) return req.actual === 0 ? " (no matching relation edge)" : "";
  const shown = rejected.slice(0, MAX_REJECTED_SHOWN).map((r) => describeRejected(r, req.otherStates));
  const more = rejected.length > shown.length ? `; +${rejected.length - shown.length} more` : "";
  return ` — ${rejected.length} matching edge(s) not counted: ${shown.join("; ")}${more}`;
}

/**
 * Render one unmet requirement so a denial names its type, role, need, shortfall,
 * AND the specific offending edges (dangling / wrong-state) rather than a bare
 * "found 0". Exported so the write-side denial message and the read-side STANDING
 * problem message ({@link ../profile/relation-standing.js}) phrase a shortfall
 * IDENTICALLY — one string shape, not two that could drift.
 */
export function describeUnmet(req: UnmetRelationRequirement): string {
  return `${req.relationType}[${req.role}] needs ${req.needed} but found ${req.actual}${describeShortfall(req)}`;
}

/**
 * Thrown when the relation store was READABLE but a declared precondition is
 * genuinely unmet — at least one requirement's distinct-existing count is below
 * its `minCount`. Carries the {@link UnmetRelationRequirement} list and produces an
 * ACTIONABLE message naming, per unmet requirement, its relation type, role,
 * needed count, and the actual count found. A HARD denial: the gated write must
 * not land.
 */
export class RelationPreconditionUnmetError extends Error {
  /** The requirements that were not satisfied (each carries `needed` vs `actual`). */
  readonly unmet: UnmetRelationRequirement[];

  constructor(unmet: UnmetRelationRequirement[]) {
    super(`relation preconditions unmet: ${unmet.map(describeUnmet).join("; ")}`);
    this.name = "RelationPreconditionUnmetError";
    this.unmet = unmet;
  }
}

/**
 * Thrown when the relation store could NOT be read (a store-sick throw from
 * {@link readLiveValidRelations}: corrupt / too-new / symlinked leaf / symlinked
 * graph dir). This means "cannot verify", NOT "unmet" — a DISTINCT type so a
 * downstream workflow can PARK/retry a healthy run rather than terminally fail it.
 * Still fail-closed: the gated write does NOT land. The underlying store error is
 * carried as the `cause` for diagnosis.
 */
export class RelationPreconditionUnverifiableError extends Error {
  constructor(cause: Error) {
    super(`cannot verify relation preconditions (${cause.message})`, { cause });
    this.name = "RelationPreconditionUnverifiableError";
  }
}

/**
 * Is `err` a relation-store-UNAVAILABLE throw (the store could not be read), vs a
 * genuinely-unexpected programming error? Maps to
 * {@link RelationPreconditionUnverifiableError} both the typed store-sick classes
 * AND any raw OS I/O error — the read path rethrows raw `NodeJS.ErrnoException`s
 * for conditions with no typed class (`EACCES` on a permission-restricted graph
 * store, `EMFILE`/`ENFILE` under fd pressure, `EIO` on a mid-read fault). Those are
 * legitimately "cannot verify" and must PARK, not crash. This catch is scoped to
 * the relation-store read only, so any errno-bearing error IS a store I/O
 * condition; a real programming error (a `TypeError` etc. with no `.code`) has no
 * errno and still propagates.
 */
export function isStoreUnavailable(err: unknown): boolean {
  return (
    err instanceof RelationStoreCorruptError ||
    err instanceof RelationStoreTooNewError ||
    err instanceof RelationStoreSymlinkError ||
    err instanceof GraphDirConfinementError ||
    (err instanceof Error && typeof (err as NodeJS.ErrnoException).code === "string")
  );
}

/**
 * Build the LOCK-FREE endpoint FACTS resolver: does an endpoint id resolve to a
 * real, PROFILE-VALID on-disk page under `root`, and what lifecycle state does it
 * carry? Parses the id to its entity type + slug, looks up the type in `profile`,
 * reads the confined page's frontmatter via the handle-bound
 * {@link readConfinedEntityFrontmatter}, and validates it against the type's
 * field contract with the SHARED {@link validateEntityFields} (the same
 * implementation the collector and typed write gates enforce). NO lock acquire
 * (the enforcer runs inside the caller's held lock; a lock here would release it
 * early). An unparseable id, an undeclared entity type, an absent/escaping page,
 * or a page with ANY field-contract violation all resolve to `null` — mere
 * on-disk existence is NOT evidence, so a dangling, fabricated, or
 * contract-violating relation edge is dropped by the checker. But a page that
 * FAULTS on read (a raw I/O errno — `EACCES`/`EMFILE`/`EIO`) is NOT `null`: it
 * THROWS {@link EndpointUnreadableError}, which the checker propagates so the
 * enforcer maps it to {@link RelationPreconditionUnverifiableError} (park), never
 * miscounting a transient read fault as an unmet precondition.
 *
 * Exported so the read-side STANDING check ({@link ../profile/relation-standing.js})
 * resolves endpoint facts through the SAME confined resolver the write-side
 * enforcer uses — read and write agree on what "a qualifying endpoint" means,
 * rather than the read path hand-rolling a second, divergent check.
 */
export function makeEndpointFactsResolver(root: string, profile: ProfilePack): EndpointResolver {
  // MEMOIZE per resolver instance (each is call-scoped: one standing check or one
  // write enforce over an unchanging snapshot). A hub endpoint referenced by
  // hundreds of gated pages is then read + validated ONCE, not once per referencing
  // page — the standing check's dominant I/O cost. Caching the PROMISE also dedups
  // concurrent in-flight lookups; a rejected (unreadable) lookup caches its throw.
  const cache = new Map<EntityId, Promise<EndpointFacts | null>>();
  return (id) => {
    let cached = cache.get(id);
    if (cached === undefined) {
      cached = resolveEndpointFacts(root, profile, id);
      cache.set(id, cached);
    }
    return cached;
  };
}

/** Resolve one endpoint id to its facts (or `null`), throwing on an unreadable page. */
async function resolveEndpointFacts(root: string, profile: ProfilePack, id: EntityId): Promise<EndpointFacts | null> {
  let parsed: { entityType: string; slug: string };
  try {
    parsed = parseEntityId(id);
  } catch (err) {
    if (err instanceof EntityIdError) return null;
    throw err;
  }
  const def = profile.entities[parsed.entityType];
  if (!def) return null;
  const read = await readConfinedEntityFrontmatter(root, def, parsed.slug);
  if (read.kind === "unreadable") throw new EndpointUnreadableError(read.cause);
  if (read.kind === "absent") return null;
  if (validateEntityFields(read.meta, def).length > 0) return null;
  return endpointLifecycleFacts(read.meta, def);
}

/**
 * The facts of a validated endpoint page: its lifecycle-field value ONLY when the
 * type declares a lifecycle AND the page's value is a DECLARED state of that
 * lifecycle; `{}` otherwise, so a state-filtered requirement fails CLOSED on it.
 * Requiring the value to be a declared state (not any string) is what stops a
 * foreign/out-of-band state name — or a same-named state that belongs to a
 * DIFFERENT endpoint type — from vouching as evidence for a state it can never
 * legally reach.
 */
function endpointLifecycleFacts(frontmatter: Record<string, unknown>, def: EntityTypeDef): EndpointFacts {
  const lc = def.lifecycle;
  if (lc === undefined) return {};
  const value = frontmatter[lc.field];
  return typeof value === "string" && lifecycleStates(lc).has(value) ? { state: value } : {};
}

/** Inputs to {@link enforceRelationPreconditions}; grouped to keep the arg list small. */
export interface EnforceRelationPreconditionsArgs {
  /** Absolute project root (the CALLER already holds its lock). */
  root: string;
  /** The active profile, ALREADY loaded under the held lock (not re-loaded here). */
  profile: ProfilePack;
  /** The transitioning entity's type (half of its branded id). */
  entityType: string;
  /** The transitioning entity's slug (the other half of its branded id). */
  slug: string;
  /** The lifecycle state being ENTERED, whose preconditions are enforced. */
  enteredState: string;
  /** The governing lifecycle def carrying `transitionRelationRequirements`. */
  lifecycle: LifecycleDef;
}

/**
 * Enforce the relation-count preconditions for an entity ENTERING `enteredState`.
 * Returns normally when every precondition is satisfied (or the state declares
 * none); otherwise throws — {@link RelationPreconditionUnmetError} when a
 * precondition is genuinely unmet, or {@link RelationPreconditionUnverifiableError}
 * when the relation store could not be read.
 *
 * EARLY-OUT: when the lifecycle declares no `transitionRelationRequirements` for
 * `enteredState`, this returns IMMEDIATELY and reads NOTHING — so default and
 * non-gated writes never incur a relation read.
 *
 * See the file overview for the LOCK-FREE INVARIANT (this acquires no lock) and
 * the fail-closed two-error split.
 *
 * @param args - Root, the under-lock-loaded profile, entity type/slug, entered
 *   state, and the governing lifecycle def.
 * @throws {RelationPreconditionUnmetError} When a precondition count is unmet.
 * @throws {RelationPreconditionUnverifiableError} When the relation store is unreadable.
 */
export async function enforceRelationPreconditions(args: EnforceRelationPreconditionsArgs): Promise<void> {
  const reqs = args.lifecycle.transitionRelationRequirements?.[args.enteredState];
  if (reqs === undefined || reqs.length === 0) return; // early-out: read NOTHING
  let liveValidRelations: RelationRef[];
  try {
    // Lock-free read (see the file overview): the caller already holds the lock.
    liveValidRelations = await readLiveValidRelations(args.root, args.profile);
  } catch (err) {
    if (isStoreUnavailable(err)) throw new RelationPreconditionUnverifiableError(err as Error);
    throw err; // a genuinely-unexpected error propagates
  }
  let unmet: UnmetRelationRequirement[];
  try {
    unmet = await checkRelationPreconditions({
      entityType: args.entityType,
      slug: args.slug,
      enteredState: args.enteredState,
      lifecycle: args.lifecycle,
      liveValidRelations,
      resolveEndpoint: makeEndpointFactsResolver(args.root, args.profile),
    });
  } catch (err) {
    // An endpoint page that could not be READ (transient I/O fault) is "cannot
    // verify", NOT "unmet" — park the healthy run instead of terminally denying it.
    if (err instanceof EndpointUnreadableError) throw new RelationPreconditionUnverifiableError(err);
    throw err;
  }
  if (unmet.length > 0) throw new RelationPreconditionUnmetError(unmet);
}
