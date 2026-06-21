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
import { lstat } from "fs/promises";
import { confineUnderRoot } from "../utils/path-confine.js";
import { runMandatoryPageChecks, type PageWriteContext } from "./checks.js";
import { composeTrustDecision, type TrustDecision, type TrustCheckResult } from "./decision.js";
import { entityId, isSlugSafe, isSafeFilenameComponent } from "../profile/identity.js";
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
  /**
   * Whether an existing target is an intended overwrite (`update`) rather than a
   * collision. A legitimate upserting caller (review-approve, compile recompile)
   * passes `true`; a strict create-only caller passes `false` (the default).
   */
  allowOverwrite?: boolean;
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
  };
  const checks = [identityCheck, ...(await runMandatoryPageChecks(ctx))];
  const decision = composeTrustDecision(checks, { reviewRouted: input.reviewRouted });
  if (!LIVE_WRITE_DECISIONS.has(decision)) {
    return { planned: [], decision, checks };
  }
  const exists = await targetAlreadyExists(input.root, input.targetPath);
  const mutation: PlannedMutation = {
    kind: "page",
    operation: exists ? "update" : "create",
    target: buildTarget(),
    body: input.body,
    provenance: { origin: input.origin, decision, reviewRouted: input.reviewRouted },
  };
  return { planned: [mutation], decision, checks };
}

/**
 * Plan a single PROFILE-entity page mutation: derive the target, run the
 * mandatory checks, compose the decision, and emit either one live-write
 * mutation (on allow/allow-with-warning) or none (on any block-derived
 * decision). The target is a typed {@link EntityRef} whose {@link EntityId} is
 * minted only once the identity is known slug-safe.
 *
 * @param input - The proposed page mutation.
 * @returns The plan, composed decision, and per-check results.
 */
export async function planPageMutation(input: PlanPageInput): Promise<PlanResult> {
  const targetPath = pageTargetPath(input.entityType, input.slug);
  return planPageWith(
    { ...input, targetPath },
    checkIdentitySafe(input.entityType, input.slug),
    () => ({ entityType: input.entityType, slug: input.slug, id: entityId(input.entityType, input.slug) }),
  );
}

/** Inputs to {@link planDefaultPageMutation}. */
export interface PlanDefaultPageInput {
  /** Absolute project root the write must stay confined to. */
  root: string;
  /** The wiki subdirectory the page lives in (a raw filename component). */
  directory: string;
  /** The raw Unicode slug stem (a raw filename component; may be invalid). */
  slug: string;
  /** Full markdown body (frontmatter + prose). */
  body: string;
  /** Origin surface/actor of the proposal. */
  origin: string;
  /** Whether the surface stages risky writes for human review. */
  reviewRouted: boolean;
  /** Whether an existing target is an intended overwrite (`update`). */
  allowOverwrite?: boolean;
}

/**
 * Plan a single DEFAULT page mutation. Unlike {@link planPageMutation} this does
 * NOT mint an EntityId: default pages keep their raw Unicode slug and target a
 * {@link RawPageRef}. The identity floor is {@link isSafeFilenameComponent}
 * (via {@link checkDefaultIdentitySafe}), the path is `wiki/<directory>/<slug>.md`,
 * and the SAME mandatory floor + decision composition runs through
 * {@link planPageWith}.
 *
 * @param input - The proposed default page mutation.
 * @returns The plan, composed decision, and per-check results.
 */
export async function planDefaultPageMutation(input: PlanDefaultPageInput): Promise<PlanResult> {
  const targetPath = pageTargetPath(input.directory, input.slug);
  return planPageWith(
    { ...input, targetPath },
    checkDefaultIdentitySafe(input.directory, input.slug),
    () => ({ directory: input.directory, slug: input.slug }),
  );
}
