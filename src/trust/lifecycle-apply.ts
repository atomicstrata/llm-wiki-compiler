/**
 * @file src/trust/lifecycle-apply.ts
 * @description The LIFECYCLE-TRANSITION executor handler — the UNDER-LOCK
 * authority for a `lifecycle-transition` PlannedMutation. The dispatcher already
 * holds the project lock; this handler is the source of truth.
 *
 * It composes a REAL {@link TrustDecision} over the FINAL computed frontmatter
 * (NOT the raw caller evidence), running the SAME mandatory checks a typed page
 * update runs (`applyTypedCandidate`): the FSM transition validity
 * ({@link validateLifecycleTransition}) AND the typed entity-field contract
 * ({@link validateEntityFields}). A non-allow decision throws
 * {@link LifecycleTransitionError} with the page UNCHANGED.
 *
 * The page bytes are written via the SHARED {@link applyPageMutationLocked}
 * primitive (under the executor's OWN journal batch), so the lifecycle page
 * write inherits the SAME mandatory page floor + journal discipline as a compile
 * page write — WITHOUT re-entering the executor dispatcher or calling
 * `applyTypedCandidate`/`applyApprovedMutationsLocked`. The audit event records
 * the composed `decision` as a TOP-LEVEL field, exactly as relation events do.
 *
 * The synthetic page write carries `origin: "lifecycle"`, which
 * {@link resourceCapForOrigin} maps to the single-source cap — the SAME effective
 * floor cap a typed page update gets (a typed promotion uses `origin: "review"`,
 * also single-source), so a lifecycle page is neither over- nor under-capped.
 *
 * CROSS-STORE AUDIT RESIDUAL (honest boundary — no co-commit). The page mutation
 * (journalled, single-store-atomic) and its `lifecycle-transition` audit event
 * (the event store) live in SEPARATE stores and are NOT co-committed: this
 * handler commits the page batch and THEN emits the event, sequentially, with no
 * cross-store journal spanning both. Two checks run BEFORE the page write so a
 * deterministic event failure never lands an unaudited page: the event store is
 * pre-flighted for HEALTH ({@link prepareEventStoreForAppend} — a tampered/
 * symlinked/too-new store fails CLOSED with nothing written) AND the would-be
 * event record's SIZE is pre-flighted ({@link preflightEventAppend}) over the
 * SAME content that will be appended — and that content records ONLY the declared
 * requirement keys that SATISFIED the gate (bounded by the profile, never raw
 * caller keys), so a caller cannot pad `evidence` with junk to blow the record
 * cap. An over-cap event therefore fails the transition CLOSED
 * with the page UNTOUCHED, not page-committed-then-event-threw. The remaining
 * residual is the NON-DETERMINISTIC cross-store gap (a store healthy at both
 * pre-flights that fails mid-emit AFTER the page mutation lands — e.g. an I/O
 * fault), closed only by the Phase-5 cross-store op-ID journal. Do NOT read this
 * as all-or-none across the two stores.
 */

import { loadNonDefaultProfile } from "../profile/block.js";
import { LockBusyError } from "../utils/lock.js";
import { parseFrontmatter, safeReadFile } from "../utils/markdown.js";
import { resolveConfinedEntityPage } from "../profile/lifecycle-read.js";
import { prepareEventStoreForAppend } from "../events/store-read.js";
import { appendEventLocked, preflightEventAppend, type AppendEventInput } from "../events/store.js";
import { entityId } from "../profile/identity.js";
import { validateLifecycleTransition, LifecycleTransitionError } from "../profile/lifecycle.js";
import { entityFieldViolations } from "../profile/artifact-ref-validate.js";
import { composeTrustDecision, checkFromProblems, type TrustCheckResult, type TrustDecision } from "./decision.js";
import { applyPageMutationLocked } from "./page-apply.js";
import { openBatch, commitBatch } from "./journal.js";
import { allowedEvidence } from "./lifecycle-body.js";
import { rebuildLifecycleFrontmatter } from "./lifecycle-frontmatter.js";
import { enforceGatedStateEntry } from "./gated-state-entry.js";
import type { EntityTypeDef, ProfilePack } from "../profile/types.js";
import type { LifecycleTransitionPlannedMutation, PagePlannedMutation } from "./planner.js";

/** The origin a lifecycle page write carries; maps to the single-source floor cap. */
const LIFECYCLE_ORIGIN = "lifecycle";

/** Decisions under which a lifecycle page write is cleared to land bytes. */
const LIVE_WRITE_DECISIONS: ReadonlySet<TrustDecision> = new Set(["allow", "allow-with-warning"]);

/**
 * Thrown when a lifecycle transition is requested for a project with no profile,
 * an entity type with no declared lifecycle, or a slug with no on-disk page.
 * Fails CLOSED before any write so a transition is only ever attempted against a
 * real, lifecycle-bearing page. Lives HERE (with the under-lock authority) so the
 * SDK entry point can re-export it without forming an executor import cycle.
 */
export class LifecycleTransitionUnavailableError extends Error {
  constructor(reason: "no-profile" | "unknown-type" | "no-lifecycle" | "no-page", detail: string) {
    super(`cannot transition lifecycle: ${detail}`);
    this.name = "LifecycleTransitionUnavailableError";
    void reason;
  }
}

/**
 * Thrown when the SDK lifecycle entry point cannot acquire the project lock —
 * another process is writing this project. The transition is a read-modify-write,
 * so it MUST run single-writer; without the lock the prev-state read and the apply
 * could race (TOCTOU). Fails CLOSED, writing nothing. Lives HERE so the SDK entry
 * point re-exports it without an executor import cycle.
 *
 * Extends {@link LockBusyError} (the shared "lock busy" supertype that the
 * relation/event/embeddings store paths throw) so an SDK caller batching ops can
 * catch ALL lock contention with a single `instanceof LockBusyError`, while this
 * subtype keeps its OWN lifecycle-specific `name` + `message` (so callers that
 * match the precise type / its message are unaffected). The base constructor's
 * `timeoutMs` message is replaced — this is the fail-FAST acquire, not a bounded
 * blocking timeout, so a millisecond figure would be misleading.
 */
export class LifecycleTransitionLockError extends LockBusyError {
  constructor() {
    super(0);
    this.name = "LifecycleTransitionLockError";
    this.message = "cannot transition lifecycle: another llmwiki process is using this project (lock held)";
  }
}

/** The resolved page context a transition acts on: its def, real path, prev state, body. */
interface PageContext {
  def: EntityTypeDef;
  /** The active profile, loaded UNDER the held lock; reused for the relation-precondition read. */
  profile: ProfilePack;
  meta: Record<string, unknown>;
  /** The ORIGINAL raw frontmatter text (between the `---` fences), for a byte-preserving rewrite. */
  rawFrontmatter: string;
  body: string;
  prev: string | undefined;
}

/** Match the frontmatter block + body, capturing the raw inner frontmatter text. */
const FRONTMATTER_BLOCK = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

/** Extract the raw frontmatter text (between the fences) from a page's full content. */
function rawFrontmatterOf(content: string): string {
  return content.match(FRONTMATTER_BLOCK)?.[1] ?? "";
}

/**
 * Resolve the lifecycle-bearing entity def + read the on-disk page, failing
 * CLOSED via {@link LifecycleTransitionUnavailableError} when no profile declares
 * the type, the type has no lifecycle, or no page exists at its directory/slug.
 */
async function resolvePageContext(
  root: string,
  m: LifecycleTransitionPlannedMutation,
): Promise<PageContext> {
  const loaded = await loadNonDefaultProfile(root);
  if (!loaded) throw new LifecycleTransitionUnavailableError("no-profile", "the project has no non-default profile");
  const def = loaded.profile.entities[m.entityType];
  if (!def?.lifecycle) {
    throw new LifecycleTransitionUnavailableError("no-lifecycle", `entity type "${m.entityType}" has no declared lifecycle`);
  }
  const real = await resolveConfinedEntityPage(root, def, m.slug);
  if (real === null) {
    throw new LifecycleTransitionUnavailableError("no-page", `no page at ${def.directory}/${m.slug}.md to transition`);
  }
  const content = await safeReadFile(real);
  const { meta, body } = parseFrontmatter(content);
  return {
    def,
    profile: loaded.profile,
    meta,
    rawFrontmatter: rawFrontmatterOf(content),
    body,
    prev: meta[def.lifecycle.field] as string | undefined,
  };
}

/**
 * Compose the {@link TrustDecision} over the FINAL computed frontmatter, running
 * the SAME mandatory checks a typed page update runs: the FSM transition validity
 * AND the typed entity-field contract — both against `nextMeta`, never the raw
 * caller evidence. Returns the next frontmatter and the composed decision.
 */
function decideTransition(ctx: PageContext, m: LifecycleTransitionPlannedMutation): {
  nextMeta: Record<string, unknown>;
  accepted: ReturnType<typeof allowedEvidence>;
  decision: TrustDecision;
} {
  const field = ctx.def.lifecycle!.field;
  // The accepted (allow-listed) evidence — the ONLY caller keys that land on the
  // page; reused both for the merge and for the audit event's `evidenceKeys`.
  const accepted = allowedEvidence(ctx.def, m.toState, m.evidence);
  // Lifecycle field LAST so an allow-listed evidence key can never clobber it.
  const nextMeta = { ...ctx.meta, ...accepted, [field]: m.toState };
  const checks: TrustCheckResult[] = [
    checkFromProblems(
      "lifecycle-transition",
      validateLifecycleTransition(ctx.def.lifecycle!, ctx.prev, nextMeta[field], nextMeta),
    ),
    checkFromProblems("entity-field-contract", entityFieldViolations(ctx.profile, nextMeta, ctx.def)),
  ];
  return { nextMeta, accepted, decision: composeTrustDecision(checks, { reviewRouted: false }) };
}

/**
 * Build the synthetic typed-entity page mutation for the transition: an `update`
 * carrying the rebuilt frontmatter + preserved prose body, tagged with the composed
 * decision and the `lifecycle` origin (single-source floor cap).
 *
 * The frontmatter is rebuilt by a PARITY-SAFE raw splice
 * ({@link rebuildLifecycleFrontmatter}): only the lifecycle field's value line and
 * the accepted evidence keys are (re)rendered, so a date-only field the transition
 * never touched (e.g. `created: 2024-01-15`) keeps its ORIGINAL bytes — it is NOT
 * round-tripped through `parseFrontmatter`/`buildFrontmatter` and silently retyped
 * to an ISO datetime.
 */
function buildPageMutation(
  ctx: PageContext,
  m: LifecycleTransitionPlannedMutation,
  accepted: ReturnType<typeof allowedEvidence>,
  decision: TrustDecision,
): PagePlannedMutation {
  const frontmatter = rebuildLifecycleFrontmatter(
    ctx.rawFrontmatter,
    ctx.def.lifecycle!.field,
    m.toState,
    accepted,
  );
  return {
    kind: "page",
    operation: "update",
    target: { entityType: m.entityType, slug: m.slug, id: entityId(m.entityType, m.slug) },
    body: `${frontmatter}\n${ctx.body}`,
    provenance: { origin: LIFECYCLE_ORIGIN, decision, reviewRouted: false },
  };
}

/**
 * The declared `transitionRequirements[toState]` keys that are actually PRESENT in
 * the final frontmatter — i.e. the requirement evidence that truly SATISFIED the
 * gate. This includes a required field met by EXISTING page frontmatter (which the
 * caller did NOT re-supply), so an auditor sees what cleared the requirement, not
 * just what the caller happened to pass. Still bounded by the declared requirement
 * set (profile-controlled, small), so a caller can never inflate the payload with
 * junk keys — the anti-inflation property holds.
 */
function satisfyingEvidenceKeys(
  def: EntityTypeDef,
  toState: string,
  nextMeta: Record<string, unknown>,
): string[] {
  const declared = def.lifecycle!.transitionRequirements?.[toState] ?? [];
  return declared.filter((field) => nextMeta[field] !== undefined && nextMeta[field] !== null);
}

/**
 * Build the `lifecycle-transition` audit event input. `evidenceKeys` records the
 * declared `transitionRequirements[toState]` keys that actually SATISFIED the gate
 * (present in the final frontmatter) — see {@link satisfyingEvidenceKeys}. A
 * required field met by existing frontmatter (not re-supplied by the caller) is
 * therefore recorded, instead of misleadingly reading `[]`. The set stays bounded
 * by the declared requirements, so a caller cannot inflate the payload with junk.
 */
function buildLifecycleEvent(
  ctx: PageContext,
  m: LifecycleTransitionPlannedMutation,
  nextMeta: Record<string, unknown>,
  decision: TrustDecision,
): AppendEventInput {
  return {
    type: "lifecycle-transition",
    origin: "sdk",
    decision,
    payload: {
      entityType: m.entityType,
      slug: m.slug,
      from: ctx.prev ?? null,
      to: m.toState,
      evidenceKeys: satisfyingEvidenceKeys(ctx.def, m.toState, nextMeta),
    },
    at: new Date().toISOString(),
  };
}

/**
 * Throw {@link LifecycleTransitionError} (page UNCHANGED) when the composed
 * decision is not cleared to land bytes, surfacing the FSM + field-contract
 * problems that blocked it.
 */
function refuseNonLiveWrite(
  ctx: PageContext,
  m: LifecycleTransitionPlannedMutation,
  nextMeta: Record<string, unknown>,
): never {
  const field = ctx.def.lifecycle!.field;
  const problems = [
    ...validateLifecycleTransition(ctx.def.lifecycle!, ctx.prev, nextMeta[field], nextMeta),
    ...entityFieldViolations(ctx.profile, nextMeta, ctx.def),
  ];
  throw new LifecycleTransitionError(m.entityType, m.slug, problems);
}

/**
 * Apply a `lifecycle-transition` mutation WHILE THE CALLER ALREADY HOLDS the
 * project lock — the under-lock authority for the lifecycle kind. RE-loads the
 * active profile under the lock, reads the on-disk page, composes a real
 * {@link TrustDecision} over the FINAL frontmatter (FSM + entity-field contract),
 * and — only on a live-write decision — writes the page via the SHARED
 * {@link applyPageMutationLocked} primitive (the executor's own journal batch, no
 * dispatcher re-entry) then emits one `lifecycle-transition` audit event carrying
 * the composed `decision` TOP-LEVEL. A non-live-write decision throws
 * {@link LifecycleTransitionError} with the page UNCHANGED.
 *
 * AUDIT-BEFORE-PAGE ORDERING. The event is recorded with ONLY the declared
 * requirement keys that satisfied the gate (so the caller cannot inflate it), and
 * its record SIZE is
 * pre-flighted ({@link preflightEventAppend}) BEFORE the page write. So an event
 * that would exceed {@link MAX_EVENT_RECORD_BYTES}/store cap fails the transition
 * CLOSED with the page UNTOUCHED — closing the window where the page committed but
 * the trailing event append threw, leaving an unaudited, caller-controlled
 * mutation. Order: store health → build event → size pre-flight (fail closed,
 * page untouched) → page write → append the already-size-validated event.
 *
 * @param root - Absolute project root (the caller holds its lock).
 * @param m - The planned lifecycle transition (entity/slug/toState/evidence).
 * @returns The {@link TrustDecision} the authority composed over the final
 *   frontmatter (`allow`/`allow-with-warning`), so the seam records the REAL
 *   decision rather than a hardcoded literal.
 * @throws {LifecycleTransitionUnavailableError} When no profile/lifecycle/page.
 * @throws {LifecycleTransitionError} When the composed decision is non-live-write.
 * @throws {RelationPreconditionUnmetError} When a relation-count precondition for
 *   the entered state is genuinely unmet (page unchanged).
 * @throws {RelationPreconditionUnverifiableError} When the relation store is
 *   unreadable, so the precondition cannot be verified (page unchanged).
 * @throws {ArtifactPreconditionUnmetError} When a required artifact for the entered
 *   state is absent or resolves to a confirmed violation (page unchanged).
 * @throws {ArtifactPreconditionUnverifiableError} When a required artifact cannot be
 *   verified (unreadable / genuine store fault), so the precondition is unchecked (page unchanged).
 * @throws {EventStoreFullError} When the audit event would exceed its size cap.
 */
export async function applyLifecycleLocked(
  root: string,
  m: LifecycleTransitionPlannedMutation,
): Promise<TrustDecision> {
  const ctx = await resolvePageContext(root, m);
  const { nextMeta, accepted, decision } = decideTransition(ctx, m);
  if (!LIVE_WRITE_DECISIONS.has(decision)) refuseNonLiveWrite(ctx, m, nextMeta);
  // State-entry preconditions for the state being ENTERED — relation-count THEN
  // artifact-existence — via the SHARED seam, enforced under the already-held lock
  // (both enforcers are lock-free by contract) BEFORE any write. Routing through the
  // seam (not a lone relation call) is what closes the artifact-precondition bypass on
  // this path. `nextMeta` carries the post-transition frontmatter (the artifactRef the
  // gate resolves). Each enforcer early-outs when the entered state declares no such
  // requirement; an unmet/unverifiable precondition throws (page unchanged).
  await enforceGatedStateEntry({
    root,
    profile: ctx.profile,
    entityType: m.entityType,
    slug: m.slug,
    enteredState: m.toState,
    lifecycle: ctx.def.lifecycle!,
    meta: nextMeta,
  });
  // Audit pre-flight under the held lock: a healthy event store is a PRECONDITION.
  await prepareEventStoreForAppend(root);
  const event = buildLifecycleEvent(ctx, m, nextMeta, decision);
  // Size pre-flight BEFORE the page write: an over-cap event fails the transition
  // CLOSED with the page untouched, never page-committed-then-event-threw.
  await preflightEventAppend(root, event);
  const pageMutation = buildPageMutation(ctx, m, accepted, decision);
  const batch = await openBatch(root);
  await applyPageMutationLocked(root, pageMutation, batch);
  await commitBatch(batch);
  await appendEventLocked(root, event);
  return decision;
}
