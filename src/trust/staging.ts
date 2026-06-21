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
  type StagedChange,
} from "./staged-change.js";
import { promoteCandidateUnderLock } from "./promote.js";
import { writeCandidate } from "../compiler/candidates.js";
import { loadNonDefaultProfile } from "../profile/block.js";
import {
  validateEntityFields,
  EntityFieldContractError,
} from "../profile/field-contract.js";
import { parseFrontmatter } from "../utils/markdown.js";
import type { ProfilePack } from "../profile/types.js";
import type { TrustDecision } from "./decision.js";

export { EntityFieldContractError } from "../profile/field-contract.js";

/**
 * Validate a staged page body's frontmatter against its entity type's declared
 * field contract via the SHARED {@link validateEntityFields} (the same validator
 * the read-surface collector uses), throwing {@link EntityFieldContractError} —
 * before any planning or I/O — when the contract is violated, so a contract-
 * violating typed page never persists a candidate. A clean body is a no-op.
 *
 * @param entityType - The (already type-checked) profile entity type.
 * @param slug - The page slug (for the error message only).
 * @param body - The full markdown body whose frontmatter is validated.
 * @param profile - The profile whose entity definition supplies the contract.
 * @throws {EntityFieldContractError} When the frontmatter violates the contract.
 */
function assertFieldContract(
  entityType: string,
  slug: string,
  body: string,
  profile: ProfilePack,
): void {
  const { meta } = parseFrontmatter(body);
  const violations = validateEntityFields(meta, profile.entities[entityType]!);
  if (violations.length > 0) {
    throw new EntityFieldContractError(entityType, slug, violations);
  }
}

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

/**
 * Thrown when staging a page whose typed plan was BLOCKED by the Write Planner
 * (no live-write mutation — e.g. a non-slug-safe slug like `../evil`, or an
 * oversized body). Staging fails CLOSED so a blocked/unsafe page NEVER persists
 * a candidate that a later `review approve` could try to promote: the decision
 * is surfaced here and nothing is written.
 */
export class BlockedStagedWriteError extends Error {
  /** The non-live-write decision the planner reached for the blocked write. */
  readonly decision: TrustDecision;

  constructor(entityType: string, slug: string, decision: TrustDecision) {
    super(`staged page ${entityType}/${slug} blocked by the write planner (${decision}); nothing written`);
    this.name = "BlockedStagedWriteError";
    this.decision = decision;
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
 * Build the StagedChange `target` for a page from the live mutation the planner
 * emitted. Staging only persists a candidate for a live-write plan (a blocked
 * plan throws {@link BlockedStagedWriteError} before this runs), so the planned
 * mutation always carries a minted typed {@link EntityRef}.
 */
function buildPageTarget(plan: PlanResult): EntityRef {
  const live = plan.planned[0]?.target;
  if (live && "id" in live) return live;
  // Unreachable: stageEntityPage throws on an empty plan before building a target.
  throw new Error("internal: staged plan has no live mutation target");
}

/**
 * Stage a NON-DEFAULT entity page for review. Fails CLOSED before any I/O: it
 * first enforces the staged-write volume bound, then verifies `input.entityType`
 * is declared by `input.profile` (throwing {@link UnknownEntityTypeError} if
 * not), then validates the body's frontmatter against the entity type's declared
 * FIELD contract (throwing {@link EntityFieldContractError} on a missing required
 * field / enum / range violation), so an overflow, an unknown type, or a contract
 * violation writes nothing. It then plans the
 * write through the typed planner, captures it as a {@link StagedChange}, and
 * persists it as a typed candidate carrying `targetEntityType` + `trustDecision`.
 * If the typed plan is BLOCKED (no live-write mutation — e.g. a non-slug-safe
 * slug or an oversized body), it throws {@link BlockedStagedWriteError} and
 * persists NOTHING, so a blocked write never lands an un-promotable candidate.
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
 * @throws {EntityFieldContractError} When the body's frontmatter violates the profile field contract.
 * @throws {BlockedStagedWriteError} When the typed plan is blocked (no live write).
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
  assertFieldContract(input.entityType, input.slug, input.body, input.profile);
  const plan = await planPageMutation({
    root,
    entityType: input.entityType,
    slug: input.slug,
    body: input.body,
    origin: "sdk",
    reviewRouted: true,
    allowOverwrite: false,
  });
  if (plan.planned.length === 0) {
    throw new BlockedStagedWriteError(input.entityType, input.slug, plan.decision);
  }
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
    target: buildPageTarget(plan),
    operation: plan.planned[0]!.operation,
    planned: plan.planned,
    heldReasons: ["manual-review-requested"],
    trustDecision: plan.decision,
    createdAt: (input.now ? input.now() : new Date()).toISOString(),
  };
}

/**
 * Promote a staged entity page candidate into the live wiki by delegating to the
 * shared {@link promoteCandidateUnderLock} routine — the SAME under-lock read →
 * validate-profile → re-plan → apply → delete sequence `review approve` uses for
 * its typed branch (DRY). Holding ONE lock across read+apply+delete closes the
 * concurrent-reject race, and re-validating the candidate's `targetEntityType`
 * against the freshly-loaded profile refuses a type the profile no longer
 * declares — the page lands at `wiki/<entityType>/<slug>.md` or nothing does.
 *
 * @param root - Absolute project root.
 * @param candidateId - The staged candidate's id.
 * @throws {Error} When the candidate is missing or untyped.
 * @throws {CandidateProfileError} When the profile no longer declares the type.
 * @throws {CandidatePromotionBlockedError} When the re-plan blocks (empty plan).
 */
export async function promoteStagedEntityPage(root: string, candidateId: string): Promise<void> {
  await promoteCandidateUnderLock(root, candidateId);
}

/**
 * @experimental
 * Thrown when the SDK staging entry point is called on a project that has NO
 * non-default profile. Staging targets a typed `wiki/<entityType>/<slug>.md`
 * path, which only a non-default profile declares — so a default project cannot
 * stage. Fails CLOSED before any planning or I/O.
 */
export class StagingRequiresProfileError extends Error {
  constructor() {
    super("staging requires a non-default profile; this project has none");
    this.name = "StagingRequiresProfileError";
  }
}

/**
 * @experimental
 * SDK staging input: the entity page to stage WITHOUT the `ProfilePack` — the SDK
 * loads the active non-default profile itself. `existingStagedCount` is the
 * caller's per-session bookkeeping (defaults to 0); the per-session cap is the
 * caller's responsibility, consistent with {@link stageEntityPage}.
 */
export interface SdkStageEntityPageInput {
  /** Profile entity type (the wiki subdirectory), e.g. `"papers"`. */
  entityType: string;
  /** Page slug (the filename stem); may be invalid — the planner decides. */
  slug: string;
  /** Full markdown body (frontmatter + prose) to stage verbatim. */
  body: string;
  /** Staged writes already held this session (for the volume bound). Defaults to 0. */
  existingStagedCount?: number;
}

/**
 * @experimental
 * SDK entry point for staging a non-default entity page: loads the active
 * non-default profile INTERNALLY (throwing {@link StagingRequiresProfileError}
 * when the project has none) and delegates to {@link stageEntityPage}. The caller
 * never passes a {@link ProfilePack} — the SDK owns it.
 *
 * @param root - Absolute project root.
 * @param input - The entity page to stage (no profile; body caller-provided).
 * @returns The persisted {@link StagedChange}.
 * @throws {StagingRequiresProfileError} When the project has no non-default profile.
 */
export async function stageEntityPageForProject(
  root: string,
  input: SdkStageEntityPageInput,
): Promise<StagedChange> {
  const loaded = await loadNonDefaultProfile(root);
  if (!loaded) throw new StagingRequiresProfileError();
  return stageEntityPage(root, {
    entityType: input.entityType,
    slug: input.slug,
    body: input.body,
    profile: loaded.profile,
    existingStagedCount: input.existingStagedCount ?? 0,
  });
}
