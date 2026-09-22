/**
 * @file src/operation-bundles/adapters/page.ts
 * @description The page store adapter. It never writes `wiki/` directly and never
 * creates a candidate: apply reads the immutable bundle payload, re-plans through
 * the current trust planner, requires a live-write decision whose operation
 * matches the manifest, and lands bytes through the existing
 * `applyApprovedMutationsLocked` page authority, then re-reads and digests the
 * page to prove the postcondition.
 */

import { applyApprovedMutationsLocked } from "../../trust/executor.js";
import type { TrustDecision } from "../../trust/decision.js";
import { planPageMutation, type PageMutationTarget } from "../../trust/planner.js";
import { defineOperationStoreAdapter, type OperationStoreAdapter } from "../adapter-types.js";
import type { AdapterContext } from "../adapter-types.js";
import type { PageOperationMutation } from "../types.js";
import { digestBytes, readBundlePayload, readPageDigest, type PayloadRead } from "./shared.js";

/** Decisions that clear a page mutation to land bytes. */
const PAGE_LIVE_WRITE_DECISIONS: ReadonlySet<TrustDecision> = new Set(["allow", "allow-with-warning"]);

/**
 * True for the operations that act on an EXISTING page — update and delete —
 * which must be cleared past the "page already exists" block. The precondition
 * digest (checked at observe and by the manifest) is the real guard against a
 * stale or blind write; without delete here, an authored delete of any real
 * page was blocked before its precondition was ever consulted.
 */
function actsOnExistingPage(operation: "create" | "update" | "delete"): boolean {
  return operation === "update" || operation === "delete";
}

/** Build the planner's discriminated target from the manifest mutation target. */
function planTarget(mutation: PageOperationMutation): PageMutationTarget {
  return mutation.target.kind === "entity"
    ? { kind: "entity", entityType: mutation.target.entityType, slug: mutation.target.slug }
    : { kind: "raw", directory: mutation.target.directory, slug: mutation.target.slug };
}

/** Read the immutable payload bound to this page mutation. */
function readPayload(ctx: AdapterContext<PageOperationMutation>): Promise<PayloadRead> {
  return readBundlePayload(ctx.root, ctx.manifest.workspaceId, ctx.manifest.bundleId, ctx.mutation.payloadRef);
}

/**
 * A delete declares absence as its postcondition, so "satisfied" means the page
 * is GONE. Every digest comparison below is guarded by this: comparing against
 * a postcondition that declares no digest is meaningless, and treating absence
 * as a mismatch would make every successful delete look failed.
 */
function expectsAbsence(mutation: PageOperationMutation): boolean {
  return "kind" in mutation.postcondition && mutation.postcondition.kind === "absent";
}

/** The digest a non-delete mutation must reach; absent for a delete. */
function expectedDigest(mutation: PageOperationMutation): string | undefined {
  return "digest" in mutation.postcondition ? mutation.postcondition.digest : undefined;
}

export const pageAdapter: OperationStoreAdapter = defineOperationStoreAdapter<"page">({
  kind: "page",

  async preflight(ctx) {
    const payload = await readPayload(ctx);
    if (payload.kind === "unavailable") return { status: "unavailable", detail: "page payload is unreadable" };
    if (payload.kind === "absent") return { status: "unavailable", detail: "page payload is missing" };
    // A delete's payload is inert — nothing is written from it — so it is not
    // held to a postcondition digest the mutation does not declare.
    if (!expectsAbsence(ctx.mutation) && digestBytes(payload.bytes) !== expectedDigest(ctx.mutation)) {
      return { status: "park", code: "bundle-precondition-conflict", detail: "page payload digest mismatch" };
    }
    return { status: "ready" };
  },

  async observe(ctx) {
    const current = await readPageDigest(ctx.root, ctx.mutation);
    if (current.kind === "unavailable") return { outcome: "unavailable", detail: "page is unreadable" };
    if (current.kind === "absent") {
      // For a delete an absent page is the goal state ALREADY REACHED — not a
      // conflict, and not work still outstanding. It is unbound because nothing
      // proves THIS run removed it.
      if (expectsAbsence(ctx.mutation)) {
        return { outcome: "applied", boundToMutation: false };
      }
      return ctx.mutation.precondition.kind === "absent"
        ? { outcome: "not-applied" }
        : { outcome: "conflict", detail: "expected existing page is absent" };
    }
    // Present. For a delete the work is outstanding, and whether it may proceed
    // is the PRECONDITION's business, checked below.
    if (!expectsAbsence(ctx.mutation) && current.digest === expectedDigest(ctx.mutation)) {
      // A page write carries no per-mutation binding, so a content match cannot
      // prove this run produced it (unbound).
      return { outcome: "applied", postStateDigest: current.digest, boundToMutation: false };
    }
    if (ctx.mutation.precondition.kind === "digest" && current.digest === ctx.mutation.precondition.digest) {
      return { outcome: "not-applied" };
    }
    return { outcome: "conflict", detail: "page digest matches neither precondition nor postcondition" };
  },

  async apply(ctx) {
    const payload = await readPayload(ctx);
    if (payload.kind !== "ok") return { status: "unavailable", detail: "page payload is unreadable" };
    const plan = await planPageMutation({
      root: ctx.root, target: planTarget(ctx.mutation), body: payload.bytes.toString("utf8"),
      origin: "operation", reviewRouted: false, allowOverwrite: actsOnExistingPage(ctx.mutation.operation),
      deleting: ctx.mutation.operation === "delete",
    });
    if (!PAGE_LIVE_WRITE_DECISIONS.has(plan.decision) || plan.planned.length === 0) {
      return { status: "conflict", detail: `page not cleared for live write (${plan.decision})` };
    }
    if (plan.planned[0]!.operation !== ctx.mutation.operation) {
      return { status: "conflict", detail: "planned operation does not match the manifest" };
    }
    await applyApprovedMutationsLocked(ctx.root, plan.planned);
    const after = await readPageDigest(ctx.root, ctx.mutation);
    if (expectsAbsence(ctx.mutation)) {
      return after.kind === "absent"
        ? { status: "applied-absent" }
        : { status: "conflict", detail: "page still present after delete" };
    }
    if (after.kind !== "ok") return { status: "unavailable", detail: "page could not be re-read after apply" };
    if (after.digest !== expectedDigest(ctx.mutation)) {
      return { status: "conflict", detail: "post-apply page digest mismatch" };
    }
    return { status: "applied", postStateDigest: after.digest };
  },

  async verify(ctx) {
    const after = await readPageDigest(ctx.root, ctx.mutation);
    if (after.kind === "unavailable") return { status: "unavailable", detail: "page is unreadable" };
    if (expectsAbsence(ctx.mutation)) {
      return after.kind === "absent"
        ? { status: "verified-absent" }
        : { status: "mismatch", detail: "page still present after delete" };
    }
    if (after.kind === "absent" || after.digest !== expectedDigest(ctx.mutation)) {
      return { status: "mismatch", detail: "page postcondition digest not met" };
    }
    return { status: "verified", postStateDigest: after.digest };
  },
});
