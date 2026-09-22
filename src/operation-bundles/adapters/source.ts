/**
 * @file src/operation-bundles/adapters/source.ts
 * @description The retained-source store adapter — a thin call over the founding
 * content-addressed source store. The target is derived from a content-address
 * digest and can never name a path; apply reads the immutable bundle payload and
 * publishes it create-only; unavailable never falls through to a create.
 */

import { MAX_RETAINED_SOURCE_BYTES } from "../constants.js";
import { readDurableOperationLeafBuffer } from "../durable-leaf.js";
import { operationPaths } from "../paths.js";
import { writeRetainedSourceCreateOnly } from "../source-store.js";
import { defineOperationStoreAdapter, type AdapterContext, type OperationObservation, type OperationStoreAdapter } from "../adapter-types.js";
import type { SourceRetainMutation } from "../types.js";
import { digestBytes, readBundlePayload, type PayloadRead } from "./shared.js";

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Read the immutable payload bound to this source mutation. */
function readPayload(ctx: AdapterContext<SourceRetainMutation>): Promise<PayloadRead> {
  return readBundlePayload(ctx.root, ctx.manifest.workspaceId, ctx.manifest.bundleId, ctx.mutation.payloadRef);
}

/** Observe the retained source blob by its content-address digest. */
async function observeSource(ctx: AdapterContext<SourceRetainMutation>): Promise<OperationObservation> {
  const digest = ctx.mutation.target.digest;
  if (!SHA256_HEX.test(digest)) return { outcome: "conflict", detail: "retained source target is not a content-address digest" };
  const paths = operationPaths(ctx.root, ctx.manifest.workspaceId);
  let read: Awaited<ReturnType<typeof readDurableOperationLeafBuffer>>;
  try { read = await readDurableOperationLeafBuffer(ctx.root, paths.sourceFile(digest), paths.sourcesRoot, MAX_RETAINED_SOURCE_BYTES); }
  catch { return { outcome: "unavailable", detail: "retained source path is invalid" }; }
  if (read.kind === "absent") return { outcome: "not-applied" };
  if (read.kind !== "ok") return { outcome: "unavailable", detail: "retained source is unreadable" };
  const actual = digestBytes(read.body);
  // Retained sources are content-addressed with no per-mutation binding, so
  // presence cannot prove this run produced it (unbound).
  return actual === ctx.mutation.postcondition.digest
    ? { outcome: "applied", postStateDigest: actual, boundToMutation: false }
    : { outcome: "conflict", detail: "retained source digest mismatch" };
}

export const sourceAdapter: OperationStoreAdapter = defineOperationStoreAdapter<"source-retain">({
  kind: "source-retain",

  async preflight(ctx) {
    if (!SHA256_HEX.test(ctx.mutation.target.digest)) {
      return { status: "park", code: "bundle-precondition-conflict", detail: "retained source target is not a content-address digest" };
    }
    const payload = await readPayload(ctx);
    if (payload.kind !== "ok") return { status: "unavailable", detail: "retained source payload is unreadable" };
    if (digestBytes(payload.bytes) !== ctx.mutation.postcondition.digest) {
      return { status: "park", code: "bundle-precondition-conflict", detail: "retained source payload digest mismatch" };
    }
    return { status: "ready" };
  },

  observe: observeSource,

  async apply(ctx) {
    const payload = await readPayload(ctx);
    if (payload.kind !== "ok") return { status: "unavailable", detail: "retained source payload is unreadable" };
    try {
      const result = await writeRetainedSourceCreateOnly(ctx.root, { workspaceId: ctx.manifest.workspaceId, digest: ctx.mutation.target.digest }, payload.bytes);
      return result === "same"
        ? { status: "skipped-idempotent", postStateDigest: ctx.mutation.postcondition.digest, boundToMutation: false }
        : { status: "applied", postStateDigest: ctx.mutation.postcondition.digest };
    } catch (error) {
      const message = error instanceof Error ? error.message : "retained source write failed";
      return { status: message.includes("unavailable") ? "unavailable" : "conflict", detail: message };
    }
  },

  async verify(ctx) {
    const observation = await observeSource(ctx);
    if (observation.outcome === "applied") return { status: "verified", postStateDigest: ctx.mutation.postcondition.digest };
    if (observation.outcome === "unavailable") return { status: "unavailable", detail: observation.detail ?? "retained source unreadable" };
    return { status: "mismatch", detail: observation.detail ?? "retained source postcondition not met" };
  },
});
