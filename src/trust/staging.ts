/**
 * @file src/trust/staging.ts
 * @description SDK-level NON-DEFAULT entity page staging loop (CLP Phase-3 PR6).
 *
 * Proves the full staging round-trip through the Write Planner WITHOUT any LLM:
 *
 *  1. {@link stageEntityPage} plans a non-default entity write via the TYPED
 *     {@link planPageMutation}, enforces the fail-closed staged-write volume
 *     bound ({@link assertStagedWriteBudget}) BEFORE persisting anything, builds a
 *     {@link StagedChange} wrapping the planned mutation, and persists it as a
 *     typed review candidate (`targetEntityType` + `trustDecision`) — the
 *     candidate store IS the staging mechanism per the Phase-2 spec.
 *  2. {@link promoteStagedEntityPage} re-reads that candidate, RE-PLANS the write
 *     (so the mandatory floor + path-confinement re-run at promotion time), and
 *     applies it through the executor so the page lands at
 *     `wiki/<entityType>/<slug>.md`, then clears the candidate.
 *
 * The DEFAULT compile/review/import path is untouched: this is an additive,
 * programmatic slice. The staged body is caller-provided (no generation).
 */

import {
  planPageMutation,
  type EntityRef,
  type PlanResult,
} from "./planner.js";
import {
  assertStagedWriteBudget,
  DEFAULT_STAGED_WRITE_PER_CALL,
  DEFAULT_STAGED_WRITE_PER_SESSION,
  type HeldReasonCode,
  type StagedChange,
} from "./staged-change.js";
import { applyApprovedMutations } from "./executor.js";
import { writeCandidate, readCandidate, deleteCandidate } from "../compiler/candidates.js";
import type { EntityId, ProfilePack } from "../profile/types.js";
import type { TrustDecision } from "./decision.js";

/** Decisions under which the planner emitted a live-write mutation. */
const LIVE_WRITE_DECISIONS: ReadonlySet<TrustDecision> = new Set(["allow", "allow-with-warning"]);

/**
 * Thrown when a caller tries to stage a page under an `entityType` that the
 * supplied {@link ProfilePack} does not declare. Staging fails CLOSED before any
 * planning or I/O so an unknown type can never land `wiki/<type>/<slug>.md`
 * outside the profile schema.
 */
export class UnknownEntityTypeError extends Error {
  constructor(entityType: string) {
    super(`entity type "${entityType}" is not declared by the profile`);
    this.name = "UnknownEntityTypeError";
  }
}

/** Inputs to {@link stageEntityPage}; the body is caller-provided (no LLM). */
export interface StageEntityPageInput {
  /** Profile entity type (the wiki subdirectory), e.g. `"papers"`. */
  entityType: string;
  /** Page slug (the filename stem); may be invalid — the planner decides. */
  slug: string;
  /** Full markdown body (frontmatter + prose) to stage verbatim. */
  body: string;
  /** The loaded non-default profile this page belongs to. */
  profile: ProfilePack;
  /** Staged writes already held this session (for the volume bound). */
  existingStagedCount: number;
  /** Injectable clock for deterministic `createdAt` (defaults to now). */
  now?: () => Date;
}

/**
 * Build the StagedChange `target` for a page. When the identity is slug-safe the
 * plan minted a typed {@link EntityRef}, which we reuse. When it is NOT slug-safe
 * the plan is empty (blocked) and no id was minted — we still return a typed-shape
 * target so {@link StagedChange.target} is total, casting the raw `type/slug`
 * (this target is never promoted: a blocked plan re-blocks on promotion).
 */
function buildPageTarget(entityType: string, slug: string, plan: PlanResult): EntityRef {
  const live = plan.planned[0]?.target;
  if (live && "id" in live) return live;
  return { entityType, slug, id: `${entityType}/${slug}` as EntityId };
}

/**
 * Why the change was held. A non-live-write decision is a real trust block;
 * otherwise the entity write is routed for review by policy in this slice.
 */
function heldReasonsFor(decision: TrustDecision): HeldReasonCode[] {
  return LIVE_WRITE_DECISIONS.has(decision) ? ["manual-review-requested"] : ["trust-blocked"];
}

/**
 * Stage a NON-DEFAULT entity page for review. Fails CLOSED before any I/O: it
 * first enforces the staged-write volume bound, then verifies `input.entityType`
 * is declared by `input.profile` (throwing {@link UnknownEntityTypeError} if
 * not), so an overflow or an unknown type writes nothing. It then plans the
 * write through the typed planner, captures it as a {@link StagedChange}, and
 * persists it as a typed candidate carrying `targetEntityType` + `trustDecision`.
 *
 * Volume bound: the PER-CALL cap (requested vs {@link DEFAULT_STAGED_WRITE_PER_CALL})
 * is self-contained and self-enforced here. The PER-SESSION cap, however, is
 * enforced against the caller-supplied `input.existingStagedCount` — there is no
 * on-disk source of truth for a running session total, so keeping that count
 * accurate across calls is the CALLER's responsibility.
 *
 * @param root - Absolute project root.
 * @param input - The entity page to stage (caller-provided body).
 * @returns The persisted {@link StagedChange}.
 * @throws {StagedWriteOverflowError} When the staged-write volume bound is hit.
 * @throws {UnknownEntityTypeError} When `entityType` is not declared by the profile.
 */
export async function stageEntityPage(
  root: string,
  input: StageEntityPageInput,
): Promise<StagedChange> {
  assertStagedWriteBudget(input.existingStagedCount, 1, {
    perCall: DEFAULT_STAGED_WRITE_PER_CALL,
    perSession: DEFAULT_STAGED_WRITE_PER_SESSION,
  });
  if (!(input.entityType in input.profile.entities)) {
    throw new UnknownEntityTypeError(input.entityType);
  }
  const plan = await planPageMutation({
    root,
    entityType: input.entityType,
    slug: input.slug,
    body: input.body,
    origin: "sdk",
    reviewRouted: true,
    allowOverwrite: false,
  });
  const candidate = await writeCandidate(root, {
    title: input.slug,
    slug: input.slug,
    summary: "",
    sources: [],
    body: input.body,
    targetEntityType: input.entityType,
    trustDecision: plan.decision,
  });
  return {
    id: candidate.id,
    kind: "page",
    target: buildPageTarget(input.entityType, input.slug, plan),
    operation: plan.planned[0]?.operation ?? "create",
    planned: plan.planned,
    heldReasons: heldReasonsFor(plan.decision),
    trustDecision: plan.decision,
    createdAt: (input.now ? input.now() : new Date()).toISOString(),
  };
}

/**
 * Promote a staged entity page candidate into the live wiki. Re-reads the typed
 * candidate, RE-PLANS the write (`allowOverwrite:true`, `origin:"review"`) so the
 * mandatory floor + path confinement re-run, applies it through the executor so
 * the page lands at `wiki/<entityType>/<slug>.md`, and clears the candidate.
 *
 * If the candidate is missing/untyped, or the re-plan blocks (empty plan), it
 * throws and the candidate is RETAINED — nothing partial ever lands.
 *
 * @param root - Absolute project root.
 * @param candidateId - The staged candidate's id.
 * @throws {Error} When the candidate is missing, untyped, or its re-plan blocks.
 */
export async function promoteStagedEntityPage(root: string, candidateId: string): Promise<void> {
  const candidate = await readCandidate(root, candidateId);
  if (!candidate) throw new Error(`staged candidate not found: ${candidateId}`);
  const entityType = candidate.targetEntityType;
  if (!entityType) throw new Error(`candidate ${candidateId} is not a typed entity page`);
  const { planned } = await planPageMutation({
    root,
    entityType,
    slug: candidate.slug,
    body: candidate.body,
    origin: "review",
    reviewRouted: false,
    allowOverwrite: true,
  });
  if (planned.length === 0) {
    throw new Error(`staged candidate ${candidateId} blocked by the write planner; retained`);
  }
  await applyApprovedMutations(root, planned);
  await deleteCandidate(root, candidateId);
}
