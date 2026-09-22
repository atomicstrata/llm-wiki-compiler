/**
 * @file src/operation-bundles/stage-intent.ts
 * @description Synchronous validation and conservative capacity derivation for
 * immutable staging intent. It binds payload bytes and projection maxima
 * without rendering projections or introducing an executable schema system.
 */

import { createHash } from "node:crypto";
import { MAX_PROJECTION_BYTES } from "./constants.js";
import { manifestPayloadClaims } from "./manifest-store.js";
import type { OperationBound, OperationBundleManifest, OperationMutation } from "./types.js";

/** Verify exact map coverage, content addresses, and all declared byte counts. */
function assertPayloads(
  manifest: OperationBundleManifest,
  payloads: ReadonlyMap<string, Buffer>,
): void {
  const claims = manifestPayloadClaims(manifest);
  if (claims.size !== payloads.size || [...claims.keys()].some((digest) => !payloads.has(digest))) {
    throw new Error("operation payload map does not exactly cover manifest payloads");
  }
  for (const [digest, declaredBytes] of claims) {
    const bytes = payloads.get(digest)!;
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== digest) throw new Error("operation payload digest mismatch");
    if (declaredBytes.some((count) => count !== bytes.byteLength)) {
      throw new Error("operation payload byte count mismatch");
    }
  }
  assertPagePayloadBinding(manifest);
}

/**
 * Every page mutation that WRITES must bind its payload to its postcondition.
 *
 * A DELETE declares absence and writes nothing, so binding its inert payload to
 * a digest it does not declare would refuse every delete. The binding still
 * holds for every mutation that does produce bytes.
 */
function assertPagePayloadBinding(manifest: { mutations: readonly OperationMutation[] }): void {
  for (const mutation of manifest.mutations) {
    if (mutation.kind !== "page" || "kind" in mutation.postcondition) continue;
    if (mutation.postcondition.digest !== `sha256:${mutation.payloadRef}`) {
      throw new Error("page payload does not match its postcondition digest");
    }
  }
}

/** Select only names reserved for deterministic per-projection byte maxima. */
function projectionBounds(bounds: readonly OperationBound[]): readonly OperationBound[] {
  return bounds.filter((bound) =>
    bound.name.startsWith("projection-") && bound.name.endsWith("-bytes"));
}

/** Require exactly one bounded byte maximum for every projection mutation. */
export function projectionCapacity(manifest: OperationBundleManifest): {
  largest: number; total: number;
} {
  const expected = manifest.mutations.filter((mutation) => mutation.kind === "projection")
    .map((mutation) => `projection-${mutation.index}-bytes`);
  const declared = projectionBounds(manifest.bounds);
  if (declared.length !== expected.length || expected.some((name) =>
    !declared.some((bound) => bound.name === name))) {
    throw new Error("projection bounds must exactly match projection mutation indexes");
  }
  if (declared.some((bound) => bound.unit !== "bytes" || bound.maximum > MAX_PROJECTION_BYTES)) {
    throw new Error("projection byte bound exceeds the individual projection cap");
  }
  const maxima = declared.map((bound) => bound.maximum);
  return { largest: Math.max(0, ...maxima), total: maxima.reduce((sum, value) => sum + value, 0) };
}

/** Validate every immutable intent relationship before the first filesystem await. */
export function assertStageIntent(
  manifest: OperationBundleManifest,
  payloads: ReadonlyMap<string, Buffer>,
): void {
  assertPayloads(manifest, payloads);
  projectionCapacity(manifest);
}
