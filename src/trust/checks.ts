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
 * - resource-limit → the per-file content cap {@link MAX_SOURCE_CHARS}, decided
 *   on raw character length BEFORE any parsing so an oversized body never gets
 *   heavy processing;
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
import { MAX_SOURCE_CHARS } from "../utils/constants.js";
import type { TrustCheckResult } from "./decision.js";

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
 * Block a body whose character length exceeds the per-file content cap
 * ({@link MAX_SOURCE_CHARS}). This matches the ingest character bound exactly:
 * `src/commands/ingest.ts` gates on `content.length <= MAX_SOURCE_CHARS` (the
 * same UTF-16 code-unit length used here), so the trust floor and ingest agree.
 * The decision is made on `length` alone — no parsing — so an oversized payload
 * is rejected before any heavy processing runs.
 */
export const checkResourceLimit: MandatoryPageCheck = async (ctx) => {
  const code = "resource-limit";
  const chars = ctx.body.length;
  if (chars > MAX_SOURCE_CHARS) {
    return { code, verdict: "block", message: `body ${chars} chars exceeds cap of ${MAX_SOURCE_CHARS}` };
  }
  return pass(code, `body within the ${MAX_SOURCE_CHARS}-char cap`);
};

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
