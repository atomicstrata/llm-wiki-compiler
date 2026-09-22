/**
 * @file test/candidate-scan-cap-final9.test.ts
 * @description Decision 19 regressions enforce the 64 MiB aggregate authority
 * budget across every parsed strict-scan record, including records the selector
 * later classifies as unrelated.
 */

import { stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_CANDIDATE_MUTATION_SCAN_BYTES,
  selectCandidateEntriesForMutationWithTotal,
  type CandidateMutationSelectionHooks,
} from "../src/compiler/candidate-selection.js";
import { plantConnectorCandidate } from "./connectors/final6-fixtures.js";
import { useTempRoot } from "./fixtures/temp-root.js";

const root = useTempRoot();
const MATCHING_KEY = "a".repeat(64);
const UNRELATED_KEY = "b".repeat(64);

type ByteLimitHooks = CandidateMutationSelectionHooks & {
  maxMutationBytesForTest: number;
};

/** Select only records carrying the matching connector key. */
function isMatching(candidate: { connectorProvenance?: { idempotencyKey: string } }): boolean {
  return candidate.connectorProvenance?.idempotencyKey === MATCHING_KEY;
}

describe("Final9 aggregate candidate mutation scan cap", () => {
  it("exports the exact named 64 MiB launch cap", async () => {
    expect(MAX_CANDIDATE_MUTATION_SCAN_BYTES).toBe(64 * 1024 * 1024);
  });

  it("admits an aggregate exactly at the configured test seam", async () => {
    await plantConnectorCandidate(root.dir, "matching", { idempotencyKey: MATCHING_KEY });
    const file = path.join(root.dir, ".llmwiki", "candidates", "matching.json");
    const hooks = { maxMutationBytesForTest: (await stat(file)).size } as ByteLimitHooks;

    const result = await selectCandidateEntriesForMutationWithTotal(
      root.dir, isMatching, undefined, hooks,
    );

    expect(result.entries.map(({ fileId }) => fileId)).toEqual(["matching"]);
  });

  it("counts unrelated bytes before selection and refuses cap plus one", async () => {
    await plantConnectorCandidate(root.dir, "unrelated", { idempotencyKey: UNRELATED_KEY });
    await plantConnectorCandidate(root.dir, "matching", { idempotencyKey: MATCHING_KEY });
    const candidates = path.join(root.dir, ".llmwiki", "candidates");
    const firstBytes = (await stat(path.join(candidates, "matching.json"))).size;
    const hooks = { maxMutationBytesForTest: firstBytes } as ByteLimitHooks;

    const selecting = selectCandidateEntriesForMutationWithTotal(
      root.dir, isMatching, undefined, hooks,
    );

    await expect(selecting).rejects.toMatchObject({
      name: "CandidateMutationScanCapacityError",
      message: "candidate mutation scan byte capacity exhausted",
    });
  });

  it("rejects a non-finite test ceiling instead of widening production authority", async () => {
    await plantConnectorCandidate(root.dir, "matching", { idempotencyKey: MATCHING_KEY });

    const selecting = selectCandidateEntriesForMutationWithTotal(
      root.dir, isMatching, undefined, { maxMutationBytesForTest: Number.POSITIVE_INFINITY },
    );

    await expect(selecting).rejects.toMatchObject({
      name: "CandidateMutationScanCapacityError",
      message: "candidate mutation scan byte capacity exhausted",
    });
  });
});
