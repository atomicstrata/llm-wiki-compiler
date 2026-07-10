/**
 * @file test/pending-embeddings-priority-drain.test.ts
 * @description Regression coverage (with teeth) for the priority-aware pending
 * marker: the CURRENT compile's just-changed ids must survive the marker caps even
 * when the prior backlog is already FULL.
 *
 * The bug (HIGH): when the prior marker is at the count/byte cap, a merge that
 * appends fresh ids LAST lands them at the tail — exactly where the count + byte
 * caps drop. So the current compile's just-failed changes (the work the write-ahead
 * marker exists to make durable) are the FIRST shed; if the next refresh crashes
 * they have NO durable retry record. This drives the real drain
 * ({@link refreshEmbeddingsDrainingPending}) at DISK level with a FAILING core and
 * asserts the fresh ids are still in the on-disk marker afterwards.
 */

import { describe, it, beforeEach, afterEach, expect, vi } from "vitest";
import { writePendingEmbeddings, loadPendingEmbeddings } from "../src/utils/pending-embeddings.js";
import { refreshEmbeddingsDrainingPending } from "../src/utils/embeddings-refresh.js";
import { MAX_PENDING_EMBEDDING_IDS } from "../src/utils/constants.js";
import * as embeddings from "../src/utils/embeddings.js";
import * as output from "../src/utils/output.js";
import type { PageId } from "../src/utils/page-id.js";
import { makeRootWithOutside, cleanupRootWithOutside } from "./trust/fixture.js";

let root = "";
let outsideDir = "";

beforeEach(async () => {
  ({ root, outsideDir } = await makeRootWithOutside("pending-embed-priority-"));
  vi.spyOn(output, "status").mockImplementation(() => {});
  vi.spyOn(output, "verbose").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupRootWithOutside({ root, outsideDir });
});

const FRESH_A = "concepts/current-critical-a";
const FRESH_B = "concepts/current-critical-b";

/** Fill the prior marker to the COUNT cap with long backlog ids (oldest first). */
async function plantFullBacklog(): Promise<void> {
  const backlog = Array.from({ length: MAX_PENDING_EMBEDDING_IDS }, (_, i) => ({
    pageId: `concepts/${"backlog".repeat(8)}${i}`,
    attempts: 0,
  }));
  await writePendingEmbeddings(root, backlog);
}

describe("priority drain — fresh ids survive a full backlog + failed refresh", () => {
  it("keeps the 2 just-changed ids in the durable marker after a FAILING refresh", async () => {
    await plantFullBacklog();
    vi.spyOn(embeddings, "updateEmbeddingsLockedCore").mockRejectedValue(new Error("missing API key"));

    await refreshEmbeddingsDrainingPending(root, [FRESH_A, FRESH_B] as PageId[]);

    // The write-ahead record (and the post-failure settle) must have RETAINED the
    // fresh ids at the head of the marker, shedding the OLDEST backlog instead.
    const ids = (await loadPendingEmbeddings(root)).map((e) => e.pageId);
    expect(ids).toContain(FRESH_A);
    expect(ids).toContain(FRESH_B);
  });
});
