/**
 * @file src/trust/planner.ts
 * @description The WRITE PLANNER — the single seam through which every proposed
 * mutation passes (CLP Invariant 4). The planner does NOT touch disk: it runs
 * the mandatory trust checks, composes the {@link TrustDecision}, and emits a
 * declarative plan of {@link PlannedMutation}s for the executor to apply.
 *
 * Vocabulary is declared in full for the whole CLP mutation surface
 * (page / relation / artifact / lifecycle-transition / workflow-gate /
 * workflow-state), but Phase 2 Task 5 plans only PAGE mutations; the executor
 * rejects every other kind as `not-implemented`.
 *
 * Decision→plan mapping (per the Trust Guard spec):
 * - `allow` / `allow-with-warning` ⇒ exactly ONE live-write mutation (a `create`
 *   for a free target, an `update` for an existing one).
 * - `deny` / `stage-for-review` / `quarantine` ⇒ NO live-write mutation
 *   (`planned: []`); the returned decision carries the routing, so nothing is
 *   ever applied behind a block.
 *
 * The target path is derived lexically as `wiki/<entityType>/<slug>.md` so the
 * mandatory path-confinement check can run BEFORE any slug-safe id is minted —
 * an escaping slug is rejected by the decision, never by an exception.
 */

import path from "path";
import { runMandatoryPageChecks, type PageWriteContext } from "./checks.js";
import { composeTrustDecision, type TrustDecision, type TrustCheckResult } from "./decision.js";
import { entityId, isSlugSafe } from "../profile/identity.js";
import type { EntityId } from "../profile/types.js";

/** Every CLP store a mutation can target. Task 5 executes `page` only. */
export type MutationKind =
  | "page"
  | "relation"
  | "artifact"
  | "lifecycle-transition"
  | "workflow-gate"
  | "workflow-state";

/** The shape of a mutation against its store. */
export type MutationOperation = "create" | "update" | "delete" | "transition";

/** Reference to a profile entity page: type + slug, plus its branded id. */
export interface EntityRef {
  entityType: string;
  slug: string;
  id: EntityId;
}

/** The store-specific target a mutation acts on. Page mutations use EntityRef. */
export type MutationTarget = EntityRef;

/** Where a proposed mutation came from and how it was vetted. */
export interface MutationProvenance {
  /** The origin surface/actor that proposed the mutation (e.g. `"agent"`). */
  origin: string;
  /** The composed decision the planner reached for this mutation. */
  decision: TrustDecision;
  /** Whether the proposing surface routes risky writes for human review. */
  reviewRouted: boolean;
}

/**
 * One planned, approved mutation. `target` is a union over stores; `page` uses
 * {@link EntityRef}. `proposedHash` / `preconditionHash` are reserved for
 * optimistic-concurrency enforcement in later tasks.
 */
export interface PlannedMutation {
  kind: MutationKind;
  operation: MutationOperation;
  target: MutationTarget;
  /** The body bytes to write for a page mutation. */
  body: string;
  /** Hash of the proposed content (reserved; not enforced in Task 5). */
  proposedHash?: string;
  /** Expected hash of the current target (reserved; not enforced in Task 5). */
  preconditionHash?: string;
  provenance: MutationProvenance;
}

/** Inputs to {@link planPageMutation}. */
export interface PlanPageInput {
  /** Absolute project root the write must stay confined to. */
  root: string;
  /** Profile entity type (the wiki subdirectory). */
  entityType: string;
  /** Page slug (the filename stem); may be invalid — checks decide. */
  slug: string;
  /** Full markdown body (frontmatter + prose). */
  body: string;
  /** Origin surface/actor of the proposal. */
  origin: string;
  /** Whether the surface stages risky writes for human review. */
  reviewRouted: boolean;
}

/** The planner's output: the plan, the composed decision, and the raw checks. */
export interface PlanResult {
  planned: PlannedMutation[];
  decision: TrustDecision;
  checks: TrustCheckResult[];
}

/**
 * The wiki-relative page path for an entity: `wiki/<type>/<slug>.md`.
 *
 * Joined with raw separators (NOT `path.join`) so a traversal-bearing slug like
 * `../escape` is preserved verbatim for the mandatory path-confinement check to
 * reject — `path.join` would silently normalize `..` away and hide the escape.
 */
function pageTargetPath(entityType: string, slug: string): string {
  return ["wiki", entityType, `${slug}.md`].join(path.sep);
}

/** Decisions that earn a live-write mutation. */
const LIVE_WRITE_DECISIONS: ReadonlySet<TrustDecision> = new Set(["allow", "allow-with-warning"]);

/**
 * Guard the identity itself: a non-slug-safe `entityType`/`slug` (e.g. one
 * carrying path traversal like `../escape`) yields a `block`. This runs ahead of
 * the mandatory file checks so a malformed identity is rejected via the SAME
 * decision composition — never as a thrown {@link entityId} exception — and the
 * `create` target's {@link EntityId} can only be minted once it is known valid.
 */
function checkIdentitySafe(entityType: string, slug: string): TrustCheckResult {
  const code = "invalid-identity";
  if (isSlugSafe(entityType) && isSlugSafe(slug)) {
    return { code, verdict: "pass", message: "entity type and slug are slug-safe" };
  }
  return { code, verdict: "block", message: `entity type/slug is not slug-safe: ${entityType}/${slug}` };
}

/**
 * Build the single live-write mutation for an approved page. Chooses `create`
 * for a free target and `update` when the target already exists on disk.
 */
async function buildPageMutation(input: PlanPageInput, decision: TrustDecision): Promise<PlannedMutation> {
  const id = entityId(input.entityType, input.slug);
  const target: EntityRef = { entityType: input.entityType, slug: input.slug, id };
  return {
    kind: "page",
    operation: "create",
    target,
    body: input.body,
    provenance: { origin: input.origin, decision, reviewRouted: input.reviewRouted },
  };
}

/**
 * Plan a single page mutation: derive the target, run the mandatory checks,
 * compose the decision, and emit either one live-write mutation (on
 * allow/allow-with-warning) or none (on any block-derived decision).
 *
 * @param input - The proposed page mutation.
 * @returns The plan, composed decision, and per-check results.
 */
export async function planPageMutation(input: PlanPageInput): Promise<PlanResult> {
  const targetPath = pageTargetPath(input.entityType, input.slug);
  const ctx: PageWriteContext = { root: input.root, targetPath, body: input.body };
  const checks = [
    checkIdentitySafe(input.entityType, input.slug),
    ...(await runMandatoryPageChecks(ctx)),
  ];
  const decision = composeTrustDecision(checks, { reviewRouted: input.reviewRouted });

  if (!LIVE_WRITE_DECISIONS.has(decision)) {
    return { planned: [], decision, checks };
  }
  return { planned: [await buildPageMutation(input, decision)], decision, checks };
}
