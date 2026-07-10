/**
 * @file test/okf-refresh-drains-pending.test.ts
 * @description An OKF import refresh must DRAIN the durable pending-embeddings
 * marker, not just refresh the imported ids.
 *
 * `refreshAfterImport` is the THIRD embedding-refresh surface (alongside compile
 * and `review approve`). Before routing it through the shared drain it called the
 * embeddings core with ONLY the imported ids and never loaded/settled the marker
 * — so a workflow of OKF imports + refresh that never ran a plain compile would
 * leak the pending compile-embedding ids forever, leaving them stale.
 *
 * This plants a pre-existing pending marker (ids A,B), runs `refreshAfterImport`
 * for an unrelated imported id, and asserts the shared drain refreshed A,B AND
 * the imported id and emptied the marker once the (mocked) core succeeds for all.
 * Mirrors `review-approve-drains-pending.test.ts`.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { refreshAfterImport } from "../src/import/okf-refresh.js";
import {
  writePendingEmbeddings,
  loadPendingEmbeddings,
} from "../src/utils/pending-embeddings.js";
import * as embeddings from "../src/utils/embeddings.js";
import { makeTrustRoot, cleanupTrustRoot } from "./trust/fixture.js";

const PENDING_A = "concepts/alpha";
const PENDING_B = "concepts/beta";
const IMPORTED_ID = "concepts/gamma";

let root = "";
afterEach(async () => {
  vi.restoreAllMocks();
  if (root) await cleanupTrustRoot(root);
});

describe("OKF refresh drains the pending-embeddings marker", () => {
  it("refreshes the prior-pending ids (A,B) plus the imported id and clears the marker", async () => {
    root = await makeTrustRoot("okf-drain-");
    // Pre-existing pending marker from prior compiles the user never drained.
    await writePendingEmbeddings(root, [
      { pageId: PENDING_A, attempts: 0 },
      { pageId: PENDING_B, attempts: 0 },
    ]);
    vi.spyOn(console, "log").mockImplementation(() => {});
    // Core succeeds for every id it is asked to embed (always eligible+embedded).
    const okSpy = vi
      .spyOn(embeddings, "updateEmbeddingsLockedCore")
      .mockImplementation(async (_root, ids) => ({ embedded: ids, eligible: ids }));

    await refreshAfterImport(root, [IMPORTED_ID]);

    const refreshed = okSpy.mock.calls.flatMap((c) => c[1] as string[]);
    expect(refreshed).toEqual(expect.arrayContaining([PENDING_A, PENDING_B, IMPORTED_ID]));
    expect(await loadPendingEmbeddings(root)).toEqual([]); // marker drained empty
  });
});
