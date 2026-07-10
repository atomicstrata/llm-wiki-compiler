/**
 * @file src/trust/planner.ts
 * @description The WRITE PLANNER — the single seam through which every proposed
 * mutation passes (CLP Invariant 4). The planner does NOT touch disk: it runs
 * the mandatory trust checks, composes the {@link TrustDecision}, and emits a
 * declarative plan of {@link PlannedMutation}s for the executor to apply.
 *
 * Vocabulary is declared in full for the whole CLP mutation surface
 * (page / relation / artifact / lifecycle-transition / workflow-gate /
 * workflow-state). This module's {@link planPageMutation} plans PAGE mutations;
 * `relation`, `lifecycle-transition`, and `artifact` are real executor kinds
 * (constructed as intents and dispatched through the seam — artifact planning
 * lives in `src/artifacts/plan.ts`, dispatched by `applyArtifactLocked`). The
 * executor still rejects `workflow-*` as `not-implemented`.
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
import { lstat } from "fs/promises";
import { confineUnderRoot } from "../utils/path-confine.js";
import { runMandatoryPageChecks, resourceCapForOrigin, type PageWriteContext } from "./checks.js";
import { composeTrustDecision, type TrustDecision, type TrustCheckResult } from "./decision.js";
import { entityId, isSlugSafe, isSafeFilenameComponent } from "../profile/identity.js";
import type { EntityId } from "../profile/types.js";
import type { AppendRelationInput } from "../relations/store.js";

/** Every CLP store a mutation can target. The executor handles `page`, `relation`,
 * `lifecycle-transition`, and `artifact` kinds; `workflow-*` is not-implemented. */
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

/**
 * Reference to a DEFAULT wiki page: its directory and raw slug stem, with NO
 * typed identity. Default pages keep their Unicode `slugify` slugs (e.g.
 * `café-society`) and, per the Phase-1 invariant, NEVER become EntityIds — so
 * they carry a raw stem here rather than a branded {@link EntityId}.
 */
export interface RawPageRef {
  directory: string;
  slug: string;
}

/**
 * The store-specific target a mutation acts on. PROFILE entity pages use
 * {@link EntityRef} (typed identity); DEFAULT pages use {@link RawPageRef} (raw
 * stem, no typed identity).
 */
export type MutationTarget = EntityRef | RawPageRef;

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
 * One planned, approved PAGE mutation. `target` is a union over page stores
 * ({@link EntityRef} | {@link RawPageRef}) and the mutation carries the `body`
 * bytes to write. `proposedHash` / `preconditionHash` are reserved for
 * optimistic-concurrency enforcement in later tasks.
 */
export interface PagePlannedMutation {
  kind: "page";
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

/**
 * One planned `relation` mutation — INTENT ONLY (no page body). The persisted
 * {@link RelationRef} flows back through the executor's apply RESULT, not the
 * plan. Carries the validated {@link AppendRelationInput} the relation store
 * appends.
 */
export interface RelationPlannedMutation {
  kind: "relation";
  operation: "create";
  input: AppendRelationInput;
}

/**
 * One planned `lifecycle-transition` mutation — INTENT ONLY (no page body). It
 * names the entity (`entityType`/`slug`) and the `toState` to move it to, with
 * optional `evidence` recorded on the transition.
 */
export interface LifecycleTransitionPlannedMutation {
  kind: "lifecycle-transition";
  entityType: string;
  slug: string;
  toState: string;
  evidence?: Record<string, unknown>;
}

/** Provenance origins an artifact write may carry: the direct #9A CLI/SDK surfaces
 * plus the workflow-produced surfaces (a plain workflow submit vs an MCP-triggered
 * workflow action, attributed distinctly and never spoofable to cli/sdk — F2). */
export type ArtifactOrigin = "cli" | "sdk" | "workflow" | "workflow-mcp";

/** Intent to write a typed artifact's bytes. The executor re-validates under lock. */
export interface ArtifactPlannedMutation {
  kind: "artifact";
  artifactType: string;
  slug: string;
  body: string;
  /** Provenance recorded in the audit event; set by the calling surface (F2). */
  origin: ArtifactOrigin;
}

/**
 * One planned, approved mutation — a discriminated union over stores. A `page`
 * mutation carries a body; `relation`/`lifecycle-transition` mutations carry
 * intent only (no body), routed through the same planner→executor seam.
 */
export type PlannedMutation =
  | PagePlannedMutation
  | RelationPlannedMutation
  | LifecycleTransitionPlannedMutation
  | ArtifactPlannedMutation;

/**
 * The discriminated target of a page mutation. `entity` pages carry a typed
 * identity (a branded {@link EntityId} is minted on allow) under the slug-safe
 * grammar; `raw` default pages keep their Unicode stem (no id) under the
 * Unicode-tolerant {@link isSafeFilenameComponent} floor. The discriminant
 * selects BOTH the identity floor and the built {@link MutationTarget} shape.
 */
export type PageMutationTarget =
  | { kind: "entity"; entityType: string; slug: string }
  | { kind: "raw"; directory: string; slug: string };

/** Inputs to {@link planPageMutation}. */
export interface PlanPageInput {
  /** Absolute project root the write must stay confined to. */
  root: string;
  /** The discriminated target the mutation acts on (typed entity OR raw page). */
  target: PageMutationTarget;
  /** Full markdown body (frontmatter + prose). */
  body: string;
  /** Origin surface/actor of the proposal. */
  origin: string;
  /** Whether the surface stages risky writes for human review. */
  reviewRouted: boolean;
  /**
   * Whether an existing target is an intended overwrite (`update`) rather than a
   * collision. A legitimate upserting caller (review-approve, compile recompile)
   * passes `true`; a strict create-only caller passes `false` (the default).
   */
  allowOverwrite?: boolean;
}

/** The planner's output: the plan, the composed decision, and the raw checks. */
export interface PlanResult {
  planned: PagePlannedMutation[];
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

/** True when a confinable target already exists on disk under `root`. */
async function targetAlreadyExists(root: string, targetPath: string): Promise<boolean> {
  let abs: string;
  try {
    abs = await confineUnderRoot(targetPath, root, { mustExist: false });
  } catch {
    return false;
  }
  try {
    await lstat(abs);
    return true;
  } catch {
    return false;
  }
}

/**
 * Guard a DEFAULT page's raw identity: a `directory`/`slug` that is not a safe
 * single filename component (path separator, dot-only, leading-dot, NUL, empty)
 * yields a `block`. Like {@link checkIdentitySafe} this runs ahead of the
 * mandatory file checks and composes via the SAME decision path — never a thrown
 * exception — but it uses the Unicode-tolerant {@link isSafeFilenameComponent}
 * floor (NOT the slug-safe grammar), so a non-ASCII default slug is allowed.
 */
function checkDefaultIdentitySafe(directory: string, slug: string): TrustCheckResult {
  const code = "invalid-identity";
  if (isSafeFilenameComponent(directory) && isSafeFilenameComponent(slug)) {
    return { code, verdict: "pass", message: "directory and slug are safe filename components" };
  }
  return { code, verdict: "block", message: `directory/slug is not a safe filename component: ${directory}/${slug}` };
}

/** The shared inputs to {@link planPageWith}, independent of target identity. */
interface PageFloorInput {
  root: string;
  targetPath: string;
  body: string;
  origin: string;
  reviewRouted: boolean;
  allowOverwrite?: boolean;
}

/**
 * The shared floor→compose→build core for BOTH the typed ({@link EntityRef}) and
 * raw ({@link RawPageRef}) page paths. Prepends the caller's identity-check
 * result to the mandatory floor, composes the decision, and — only on a
 * live-write decision — invokes `buildTarget` to mint the store-specific target.
 * Factored out so the two planners never duplicate the floor/compose/existence
 * logic (only the identity grammar and target shape differ).
 */
async function planPageWith(
  input: PageFloorInput,
  identityCheck: TrustCheckResult,
  buildTarget: () => MutationTarget,
): Promise<PlanResult> {
  const ctx: PageWriteContext = {
    root: input.root,
    targetPath: input.targetPath,
    body: input.body,
    allowOverwrite: input.allowOverwrite ?? false,
    // The resource-limit cap is derived from the write's origin: compile-merged
    // pages get the larger GENERATED_PAGE_MAX_CHARS, all others MAX_SOURCE_CHARS.
    maxBodyChars: resourceCapForOrigin(input.origin),
  };
  const checks = [identityCheck, ...(await runMandatoryPageChecks(ctx))];
  const decision = composeTrustDecision(checks, { reviewRouted: input.reviewRouted });
  if (!LIVE_WRITE_DECISIONS.has(decision)) {
    return { planned: [], decision, checks };
  }
  const exists = await targetAlreadyExists(input.root, input.targetPath);
  const mutation: PagePlannedMutation = {
    kind: "page",
    operation: exists ? "update" : "create",
    target: buildTarget(),
    body: input.body,
    provenance: { origin: input.origin, decision, reviewRouted: input.reviewRouted },
  };
  return { planned: [mutation], decision, checks };
}

/**
 * Plan a single page mutation, dispatching on the target discriminant.
 *
 * For an `entity` target the typed path is taken: the slug-safe identity floor
 * ({@link checkIdentitySafe}) guards the write and a branded {@link EntityId} is
 * minted only once the identity is known valid. For a `raw` target the default
 * path is taken: the Unicode-tolerant {@link checkDefaultIdentitySafe} floor
 * guards the write and a {@link RawPageRef} (no id) is built. Both paths share
 * the same mandatory floor + decision composition via {@link planPageWith}, and
 * both emit either one live-write mutation (on allow/allow-with-warning) or none
 * (on any block-derived decision — never a thrown exception).
 *
 * @param input - The proposed page mutation with its discriminated target.
 * @returns The plan, composed decision, and per-check results.
 */
export async function planPageMutation(input: PlanPageInput): Promise<PlanResult> {
  const { target } = input;
  if (target.kind === "entity") {
    const targetPath = pageTargetPath(target.entityType, target.slug);
    return planPageWith(
      { ...input, targetPath },
      checkIdentitySafe(target.entityType, target.slug),
      () => ({ entityType: target.entityType, slug: target.slug, id: entityId(target.entityType, target.slug) }),
    );
  }
  const targetPath = pageTargetPath(target.directory, target.slug);
  return planPageWith(
    { ...input, targetPath },
    checkDefaultIdentitySafe(target.directory, target.slug),
    () => ({ directory: target.directory, slug: target.slug }),
  );
}
