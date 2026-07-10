/**
 * @file src/trust/page-apply.ts
 * @description The shared per-page write primitive: confine the target path,
 * enforce create-collision + the mandatory page floor, record the pre-state in
 * the open journal batch, and write via the injectable primitive. Used by the
 * executor's page batch AND the lifecycle handler, so a lifecycle page write
 * inherits the SAME floor + journal discipline as a compile page write — without
 * re-entering the executor dispatcher.
 *
 * This module owns the PAGE concerns the executor used to inline: deriving the
 * wiki-relative path from the union target (re-asserting the identity floor as
 * defense-in-depth), re-probing a `create` collision under the lock, and
 * re-asserting the mandatory trust floor (S5) at the byte-writing boundary. The
 * executor imports these so it depends on page-apply — NOT the reverse — which
 * keeps the lifecycle handler free to import this primitive without an
 * executor↔lifecycle-apply import cycle.
 */

import path from "path";
import { lstat } from "fs/promises";
import { atomicWrite } from "../utils/markdown.js";
import { confineUnderRoot } from "../utils/path-confine.js";
import { readConfinedLeaf } from "../utils/confined-read.js";
import { JOURNAL_PRESTATE_MAX_BYTES } from "../utils/constants.js";
import { recordPreState, type JournalBatch } from "./journal.js";
import { parseEntityId, isSafeFilenameComponent } from "../profile/identity.js";
import {
  checkResourceLimit,
  checkFrontmatter,
  resourceCapForOrigin,
  type PageWriteContext,
} from "./checks.js";
import { composeTrustDecision } from "./decision.js";
import type { PagePlannedMutation, EntityRef, RawPageRef } from "./planner.js";

/** Decisions under which the executor is cleared to write bytes to disk. */
const APPLY_ALLOWED_DECISIONS = new Set(["allow", "allow-with-warning"]);

/** A single page write. Injectable so tests can fault-inject a failure. */
export type WriteOne = (filePath: string, content: string) => Promise<void>;

/**
 * Thrown when a `create` target — free at plan time — has appeared on disk by
 * the time the batch runs under the lock. Aborting before any write closes the
 * plan→apply TOCTOU so a create never clobbers a concurrently-created file.
 * Callers match on the typed `create-collision:` message prefix.
 */
class CreateCollisionError extends Error {
  constructor(targetPath: string) {
    super(`create-collision: target already exists, refusing to overwrite: ${targetPath}`);
    this.name = "CreateCollisionError";
  }
}

/**
 * Thrown when a mutation's target identity is not slug-safe. The planner's
 * `checkIdentitySafe` guard only protects the planner path; a hand-built
 * {@link PagePlannedMutation} bypasses it, so the executor re-asserts the
 * identity before deriving a path. Callers match on the typed
 * `invalid-identity:` prefix.
 */
class InvalidIdentityError extends Error {
  constructor(message: string) {
    super(`invalid-identity: ${message}`);
    this.name = "InvalidIdentityError";
  }
}

/**
 * Thrown when a mutation fails the mandatory trust floor re-asserted at apply
 * time (S5): an oversized body, malformed frontmatter, or any block-composing
 * floor result. Refusing here — at the byte-writing boundary — means a
 * hand-built mutation that never passed the planner cannot reach disk. Callers
 * match on the typed `mutation-floor:` message prefix.
 */
class MutationFloorError extends Error {
  constructor(reason: string) {
    super(`mutation-floor: refused before write: ${reason}`);
    this.name = "MutationFloorError";
  }
}

/** True when something exists at `abs` (regular file, dir, or symlink). */
async function targetExists(abs: string): Promise<boolean> {
  try {
    await lstat(abs);
    return true;
  } catch {
    return false;
  }
}

/**
 * The wiki-relative page path for a DEFAULT page's {@link RawPageRef} target.
 *
 * Defense-in-depth: the executor does not trust the caller, so it RE-ASSERTS the
 * {@link isSafeFilenameComponent} floor on both the directory and the raw slug —
 * a hand-built mutation carrying a `..`/separator slug is rejected with a typed
 * {@link InvalidIdentityError} BEFORE `path.join` could collapse it into a wrong
 * in-root location (the planner's `checkDefaultIdentitySafe` guard is not on this
 * path).
 */
function rawPageRelPath(target: RawPageRef): string {
  if (!isSafeFilenameComponent(target.directory) || !isSafeFilenameComponent(target.slug)) {
    throw new InvalidIdentityError(`directory/slug is not a safe filename component: ${target.directory}/${target.slug}`);
  }
  return path.join("wiki", target.directory, `${target.slug}.md`);
}

/**
 * The wiki-relative page path for a PROFILE entity's {@link EntityRef} target.
 *
 * Defense-in-depth: the entityType/slug are re-validated by re-parsing the
 * branded `target.id` (which throws on a non-slug-safe slug half), so a
 * hand-built mutation carrying a `..` slug is rejected with a typed
 * {@link InvalidIdentityError} BEFORE `path.join` could collapse it into a wrong
 * in-root location — the planner's `checkIdentitySafe` guard is not on this path.
 */
function entityPageRelPath(target: EntityRef): string {
  let entityType: string;
  let slug: string;
  try {
    ({ entityType, slug } = parseEntityId(target.id));
  } catch (err) {
    throw new InvalidIdentityError((err as Error).message);
  }
  return path.join("wiki", entityType, `${slug}.md`);
}

/**
 * The wiki-relative page path for a page mutation's target, discriminating the
 * union: a DEFAULT page ({@link RawPageRef}, no `id`) takes the raw-component
 * path; a PROFILE entity ({@link EntityRef}) takes the typed-id path. Both
 * re-assert their identity floor as defense-in-depth.
 */
function pageRelPath(mutation: PagePlannedMutation): string {
  const target = mutation.target;
  if ("id" in target) return entityPageRelPath(target);
  return rawPageRelPath(target);
}

/**
 * The effective resource cap for one mutation at apply time.
 *
 * `create` always gets the absolute origin cap — a new page is never exempt. An
 * `update` gates on NET GROWTH instead of absolute size: the content-size floor
 * is sized for NEW content, but an update that adds none (e.g. a lifecycle
 * transition flipping one frontmatter field on an already-large page) must not be
 * floor-blocked. So an update's effective cap is `max(originCap, existingChars)`
 * — a normal-sized page (existing ≤ cap) is still capped at the origin cap
 * unchanged, while an already-over-cap page may be rewritten as long as the new
 * body does NOT GROW beyond what is already on disk. A growing rewrite is still
 * blocked. `abs` exists for an update (the target was probed), so its current
 * character length is read directly; a missing/unreadable file yields 0 (no
 * exemption), keeping the origin cap.
 */
async function effectiveMaxChars(root: string, mutation: PagePlannedMutation, abs: string): Promise<number> {
  const originCap = resourceCapForOrigin(mutation.provenance.origin);
  if (mutation.operation !== "update") return originCap;
  // Root-anchored, no-follow, capped read (mirrors recordPreState one hop later):
  // a symlinked leaf, a symlinked PARENT dir escaping root, or a non-regular page
  // yields `unavailable` here — fall through to 0 (origin cap) rather than reading
  // through the symlink; recordPreState then refuses the mutation. `expectedDir`
  // is the LEXICAL in-root parent from `pageRelPath` so it is NOT realpath'd (which
  // would follow the very symlink we must reject).
  const expectedDir = path.join(path.resolve(root), path.dirname(pageRelPath(mutation)));
  const existing = await readConfinedLeaf(root, abs, expectedDir, JOURNAL_PRESTATE_MAX_BYTES);
  const existingChars = existing.kind === "ok" ? existing.body.length : 0;
  return Math.max(originCap, existingChars);
}

/**
 * Re-assert the mandatory trust floor for one mutation at apply time (S5),
 * against a context whose `allowOverwrite` mirrors the operation (`update`
 * overwrites; `create` does not). Runs the floor checks not already enforced on
 * this path — resource-limit and frontmatter — and composes them; a non-allow
 * decision throws {@link MutationFloorError} so nothing is written.
 *
 * The resource cap is the {@link effectiveMaxChars} for the operation: `create`
 * keeps the absolute origin cap, while an `update` gates on net growth so a
 * no-content-added update of an already-large page is admitted (see that helper).
 */
async function assertFloorAtApply(root: string, mutation: PagePlannedMutation, abs: string): Promise<void> {
  const ctx: PageWriteContext = {
    root,
    targetPath: abs,
    body: mutation.body,
    allowOverwrite: mutation.operation === "update",
    // SAME origin→cap mapping the planner used, so a compile page allowed at plan
    // time is not rejected here by a smaller (single-source) cap, and a non-compile
    // page never sneaks past the single-source floor at apply time. For an update,
    // raised to the on-disk length so a no-growth rewrite of an over-cap page is
    // not blocked by a floor sized for NEW content.
    maxBodyChars: await effectiveMaxChars(root, mutation, abs),
  };
  const checks = await Promise.all([checkResourceLimit(ctx), checkFrontmatter(ctx)]);
  const decision = composeTrustDecision(checks, { reviewRouted: false });
  if (!APPLY_ALLOWED_DECISIONS.has(decision)) {
    const reason = checks.find((c) => c.verdict === "block")?.message ?? decision;
    throw new MutationFloorError(reason);
  }
}

/**
 * Apply ONE page mutation under an already-open journal batch: confine the
 * target, re-probe a `create` collision under the lock, re-assert the trust
 * floor (S5), record the target's pre-state, then write it.
 *
 * A `create` target is RE-PROBED under the lock (the planner's collision check
 * runs before the lock): if it now exists, abort with {@link CreateCollisionError}
 * BEFORE any write lands, so a create never overwrites a file that appeared
 * after planning. `update` operations may legitimately overwrite. Throws on a
 * collision, floor violation, or failing write, leaving the journal uncommitted
 * for replay.
 *
 * @param root - Absolute project root the write must stay confined to.
 * @param mutation - The approved page mutation to apply.
 * @param batch - The open journal batch the pre-state is recorded into.
 * @param writeOne - Per-target write primitive (defaults to {@link atomicWrite}).
 */
export async function applyPageMutationLocked(
  root: string,
  mutation: PagePlannedMutation,
  batch: JournalBatch,
  writeOne: WriteOne = atomicWrite,
): Promise<void> {
  const abs = await confineUnderRoot(pageRelPath(mutation), root, { mustExist: false });
  if (mutation.operation === "create" && (await targetExists(abs))) {
    throw new CreateCollisionError(abs);
  }
  await assertFloorAtApply(root, mutation, abs);
  await recordPreState(batch, abs);
  await writeOne(abs, mutation.body);
}
