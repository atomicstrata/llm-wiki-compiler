/**
 * @file src/trust/checks.ts
 * @description The MANDATORY CORE CHECKS for a page mutation — the unconditional
 * trust floor that CLP Invariant 3 forbids any profile from disabling.
 *
 * A configurable profile may ADD checks (stricter policy, extra heuristics), but
 * it can NEVER remove or gate the four checks defined here. That guarantee is
 * structural, not a runtime flag: {@link runMandatoryPageChecks} takes ONLY a
 * {@link PageWriteContext}. There is no profile, predicate, or allow/deny-list
 * parameter through which a check could be skipped, so no caller — however
 * configured — can reach the write path with one of these checks unevaluated.
 *
 * Each check is a pure-ish `async (ctx) => TrustCheckResult` that reuses the
 * project's existing trust primitives rather than re-deriving them:
 * - path-confinement → {@link confineUnderRoot} (rejects targets and symlinked
 *   ancestors that escape the project root);
 * - collision/no-overwrite → existence probe under the confined path. A target
 *   that already exists blocks ONLY when the caller did not declare an explicit
 *   overwrite intent (`allowOverwrite:false`); an intended upsert
 *   (`allowOverwrite:true`) treats an existing target as a clean `update`, not a
 *   violation;
 * - resource-limit → a per-file content cap decided on raw character length
 *   BEFORE any parsing so an oversized body never gets heavy processing. The cap
 *   is origin-derived ({@link resourceCapForOrigin}): compile-MERGED concept pages
 *   get the larger {@link GENERATED_PAGE_MAX_CHARS}; every other origin keeps the
 *   single-source {@link MAX_SOURCE_CHARS};
 * - frontmatter-parse → {@link parseFrontmatterStatus} (rejects malformed YAML
 *   frontmatter).
 *
 * All blocks emit a STABLE `code` so downstream routing/telemetry can key on the
 * specific floor that was hit. None of these blocks request `quarantine` —
 * quarantine is reserved for untrusted-content isolation, a separate concern.
 */

import path from "path";
import { lstat } from "fs/promises";
import { confineUnderRoot } from "../utils/path-confine.js";
import { parseFrontmatterStatus } from "../utils/markdown.js";
import { MAX_SOURCE_CHARS, GENERATED_PAGE_MAX_CHARS } from "../utils/constants.js";
import type { TrustCheckResult } from "./decision.js";

/**
 * The origin string compile-generated page writes carry. The SINGLE SOURCE of
 * this literal: compile's write adapter tags its writes with this exact value and
 * {@link resourceCapForOrigin} keys the larger merged-page cap on it, so they must
 * never drift apart (a divergence would silently re-apply the single-source cap).
 */
export const COMPILE_ORIGIN = "compile";

/**
 * The applicable resource-limit cap for a page write, derived from its `origin`.
 *
 * Compile-generated pages are MERGED across many sources, so they get the larger
 * {@link GENERATED_PAGE_MAX_CHARS} guardrail (a legitimate merged concept must not
 * be amputated by the single-source bound). EVERY other origin keeps the
 * single-source {@link MAX_SOURCE_CHARS}. This single helper is the ONE place the
 * origin→cap mapping lives, so the plan-time floor and the executor's apply-time
 * re-assertion can never drift to different caps.
 *
 * @param origin - The proposing surface/actor (`"compile"`, `"agent"`, …).
 * @returns The character cap that applies to a body of that origin.
 */
export function resourceCapForOrigin(origin: string): number {
  return origin === COMPILE_ORIGIN ? GENERATED_PAGE_MAX_CHARS : MAX_SOURCE_CHARS;
}

/**
 * The proposed page mutation a mandatory check inspects.
 *
 * `targetPath` is the intended `wiki/<dir>/<slug>.md`; it may be relative or
 * absolute and is normalized through {@link confineUnderRoot} against `root`.
 */
export interface PageWriteContext {
  /** Absolute project root the write must stay confined to. */
  root: string;
  /** Intended on-disk target for the page (relative or absolute). */
  targetPath: string;
  /** Full markdown content (frontmatter + body) to be written. */
  body: string;
  /**
   * Whether an existing target is an intended overwrite (`update`) rather than a
   * collision. `false` (or omitted) keeps the strict create-only semantics:
   * an existing target blocks. `true` lets a legitimate upsert (review-approve,
   * compile recompile) overwrite without tripping {@link checkTargetCollision}.
   */
  allowOverwrite?: boolean;
  /**
   * The applicable resource-limit cap for this body, in characters. Omitted ⇒
   * the single-source {@link MAX_SOURCE_CHARS} default. The planner derives this
   * from the write's `origin` (via {@link resourceCapForOrigin}) so compile-origin
   * MERGED concept pages get the larger {@link GENERATED_PAGE_MAX_CHARS} cap while
   * every other origin stays at the single-source bound. The executor's apply-time
   * re-assertion derives it from the SAME origin so the two caps never drift.
   */
  maxBodyChars?: number;
}

/** A single mandatory check over a page mutation. */
export type MandatoryPageCheck = (ctx: PageWriteContext) => Promise<TrustCheckResult>;

/** Helper: build a passing result for a named check. */
function pass(code: string, message: string): TrustCheckResult {
  return { code, verdict: "pass", message };
}

/**
 * Reject any target that escapes the project root, including via a symlinked
 * ancestor. Delegates to {@link confineUnderRoot} (with `mustExist:false`, since
 * the page file itself may not exist yet) and treats a throw as the escape.
 */
export const checkPathConfinement: MandatoryPageCheck = async (ctx) => {
  const code = "path-escape";
  try {
    await confineUnderRoot(ctx.targetPath, ctx.root, { mustExist: false });
    return pass(code, "target path stays within the project root");
  } catch {
    return { code, verdict: "block", message: `target path escapes the project root: ${ctx.targetPath}` };
  }
};

/**
 * Block when the confined target already exists AND the caller declared no
 * overwrite intent (`allowOverwrite` falsy): a strict create never silently
 * overwrites. When `allowOverwrite` is true, an existing target is an intended
 * `update` and passes. A free target passes either way. A target whose own path
 * escapes root is blocked here (a non-confinable target is not a safe write
 * destination).
 */
export const checkTargetCollision: MandatoryPageCheck = async (ctx) => {
  const code = "target-exists";
  let abs: string;
  try {
    abs = await confineUnderRoot(ctx.targetPath, ctx.root, { mustExist: false });
  } catch {
    return { code, verdict: "block", message: `target path escapes the project root: ${ctx.targetPath}` };
  }
  try {
    await lstat(abs);
  } catch {
    return pass(code, "target path is free");
  }
  if (ctx.allowOverwrite) return pass(code, `target exists; intended overwrite (update): ${path.basename(abs)}`);
  return { code, verdict: "block", message: `target already exists (create-only): ${path.basename(abs)}` };
};

/**
 * Block a body whose character length exceeds its applicable content cap.
 *
 * The cap is `ctx.maxBodyChars` when the caller supplied one (the planner sets it
 * from the write's origin — compile-merged pages get the larger
 * {@link GENERATED_PAGE_MAX_CHARS}), else the single-source {@link MAX_SOURCE_CHARS}
 * default. For the default cap this matches the ingest character bound exactly:
 * `src/commands/ingest.ts` gates on `content.length <= MAX_SOURCE_CHARS` (the same
 * UTF-16 code-unit length used here). The decision is made on `length` alone — no
 * parsing — so an oversized payload is rejected before any heavy processing runs.
 */
export const checkResourceLimit: MandatoryPageCheck = async (ctx) => {
  const code = "resource-limit";
  const cap = ctx.maxBodyChars ?? MAX_SOURCE_CHARS;
  const chars = ctx.body.length;
  if (chars > cap) {
    return { code, verdict: "block", message: `body ${chars} chars exceeds cap of ${cap}` };
  }
  return pass(code, `body within the ${cap}-char cap`);
};

/**
 * Thrown by {@link assertBodyWithinResourceLimit} when a body exceeds
 * {@link MAX_SOURCE_CHARS}. Lets pre-parse entry points (staging, promotion)
 * reject an oversized body with a TYPED error BEFORE any frontmatter parse —
 * mirroring the executor-side {@link checkResourceLimit} floor (same cap, same
 * message wording) so the two agree. The planner's floor stays as the executor
 * -side guarantee (defense in depth).
 */
export class ResourceLimitError extends Error {
  constructor(chars: number) {
    super(`body ${chars} chars exceeds cap of ${MAX_SOURCE_CHARS}`);
    this.name = "ResourceLimitError";
  }
}

/**
 * Reject a body whose character length exceeds {@link MAX_SOURCE_CHARS} BEFORE
 * any frontmatter parse. A pure `.length` compare — costs nothing — so a giant
 * all-frontmatter payload can never burn parse time before the cap rejects it.
 * A body within the cap is a no-op. Restores the "reject before parsing"
 * guarantee at the staging/promotion entry points.
 * @param body - The full markdown body to length-check.
 * @throws {ResourceLimitError} When `body.length` exceeds the cap.
 */
export function assertBodyWithinResourceLimit(body: string): void {
  if (body.length > MAX_SOURCE_CHARS) {
    throw new ResourceLimitError(body.length);
  }
}

/**
 * Block a body whose frontmatter block is present but malformed (invalid YAML
 * or a non-mapping scalar/array), reusing {@link parseFrontmatterStatus}. A body
 * with no frontmatter block or with clean frontmatter passes.
 */
export const checkFrontmatter: MandatoryPageCheck = async (ctx) => {
  const code = "frontmatter-invalid";
  const { malformedFrontmatter } = parseFrontmatterStatus(ctx.body);
  if (malformedFrontmatter) {
    return { code, verdict: "block", message: "frontmatter block is present but not valid YAML mapping" };
  }
  return pass(code, "frontmatter parses cleanly");
};

/**
 * The four Invariant-3 mandatory checks, in evaluation order. A profile may
 * append checks elsewhere, but this array is the floor — it is never filtered.
 */
export const mandatoryPageChecks: readonly MandatoryPageCheck[] = [
  checkPathConfinement,
  checkTargetCollision,
  checkResourceLimit,
  checkFrontmatter,
];

/**
 * Run EVERY mandatory check over the proposed page mutation and return one
 * result per check, in registration order.
 *
 * The signature is the enforcement of Invariant 3: it accepts only the
 * {@link PageWriteContext}. There is deliberately no profile/predicate/skip
 * parameter, so there is no value a caller could pass to remove a core check.
 *
 * @param ctx - The proposed page-write context.
 * @returns One {@link TrustCheckResult} per mandatory check.
 */
export async function runMandatoryPageChecks(ctx: PageWriteContext): Promise<TrustCheckResult[]> {
  return Promise.all(mandatoryPageChecks.map((check) => check(ctx)));
}
