/**
 * @file test/review-approve-drains-pending.test.ts
 * @description `review approve` must DRAIN the durable pending-embeddings marker,
 * not just refresh the approved id.
 *
 * A project run purely as `compile --review` + `review approve` would otherwise
 * accumulate pending page-ids that the approve flow never retried — review-approve
 * used to call the embeddings core with ONLY the approved id and never load/settle
 * the marker, so the accumulated ids stayed pending and embeddings stale forever.
 *
 * This plants a pre-existing pending marker (ids A,B), approves an unrelated
 * candidate, and asserts the shared drain refreshed A,B AND the approved id and
 * emptied the marker once the (mocked) core succeeds for all of them.
 */

import { describe, it, expect, vi } from "vitest";
import { writeCandidate } from "../src/compiler/candidates.js";
import reviewApproveCommand from "../src/commands/review-approve.js";
import {
  writePendingEmbeddings,
  loadPendingEmbeddings,
} from "../src/utils/pending-embeddings.js";
import * as embeddings from "../src/utils/embeddings.js";
import { useTempRoot } from "./fixtures/temp-root.js";

const ctx = useTempRoot();

const PENDING_A = "concepts/alpha";
const PENDING_B = "concepts/beta";
const APPROVED_ID = "concepts/gamma";

/** A frontmatter+body page string that passes validateWikiPage for `slug`. */
function validBody(slug: string): string {
  return [
    "---", `title: ${slug}`, 'summary: "A summary"', "sources:", '  - "source.md"',
    'createdAt: "2026-01-01T00:00:00.000Z"', 'updatedAt: "2026-01-01T00:00:00.000Z"',
    "tags: []", "aliases: []", "---", "", `Body for ${slug}.`, "",
  ].join("\n");
}

describe("review approve drains the pending-embeddings marker", () => {
  it("refreshes the prior-pending ids (A,B) plus the approved id and clears the marker", async () => {
    // Pre-existing pending marker from a prior review-only run: A and B are stale.
    await writePendingEmbeddings(ctx.dir, [
      { pageId: PENDING_A, attempts: 0 },
      { pageId: PENDING_B, attempts: 0 },
    ]);
    const candidate = await writeCandidate(ctx.dir, {
      title: "gamma", slug: "gamma", summary: "A summary",
      sources: ["source.md"], body: validBody("gamma"),
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    // Core succeeds for every id it is asked to embed (it always is eligible+embedded).
    const okSpy = vi
      .spyOn(embeddings, "updateEmbeddingsLockedCore")
      .mockImplementation(async (_root, ids) => ({ embedded: ids, eligible: ids }));

    await reviewApproveCommand(candidate.id);

    const refreshed = okSpy.mock.calls.flatMap((c) => c[1] as string[]);
    expect(refreshed).toEqual(expect.arrayContaining([PENDING_A, PENDING_B, APPROVED_ID]));
    expect(await loadPendingEmbeddings(ctx.dir)).toEqual([]); // marker drained empty
  });
});
