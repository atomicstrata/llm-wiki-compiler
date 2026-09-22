/**
 * @file test/operation-bundles/operation-binding-grammar.test.ts
 * @description Drift guard: the on-disk operation-binding grammar in
 * src/utils/operation-binding.ts mirrors the minted identifier grammar in
 * src/operation-bundles/ids.ts. If a future ids.ts change alters the shape of a
 * live minted id, this fails rather than silently drifting the mirror.
 */

import { describe, it, expect } from "vitest";
import { isOperationBinding } from "../../src/utils/operation-binding.js";
import { mintBundleId, mintOperationRunId, mutationId } from "../../src/operation-bundles/ids.js";

describe("operation binding grammar mirror", () => {
  it("accepts a binding built from live minted identities", () => {
    const bundleId = mintBundleId();
    const binding = { bundleId, runId: mintOperationRunId(), mutationId: mutationId(bundleId, 0) };
    expect(isOperationBinding(binding)).toBe(true);
  });

  it("rejects a run id carrying the wrong prefix", () => {
    const bundleId = mintBundleId();
    const binding = { bundleId, runId: bundleId, mutationId: mutationId(bundleId, 0) };
    expect(isOperationBinding(binding)).toBe(false);
  });
});
