/**
 * Bounded-read contract for the `/api/reviews` candidate loader.
 *
 * `#/reviews` re-reads disk on every visit, and `heldReasons: "all"` is a real
 * policy code meaning "hold every page" — so a 5,000-page corpus compiled under
 * it puts 5,000 candidate files behind one request. `listCandidates` reads and
 * JSON-parses every one of them, which is the cost `listCandidatePage` exists
 * to remove.
 *
 * Capping the RESPONSE alone would not remove it: the files would still be read
 * and parsed before being sliced away. So these tests assert on the read path
 * itself: the disk read primitive is spied on, and only the served slice may
 * reach it. The tolerant candidate read goes through the local record-directory
 * binding, whose disk leaf reads with `readFile` from `node:fs/promises`
 * (`src/storage/disk-local-record-dirs.ts`), so that is the call counted. The
 * real implementation stays beneath the spy; nothing is stubbed.
 * They also pin the ordering guarantee the bounded loader actually provides
 * (ascending candidate file id, NOT `generatedAt`) so it cannot drift back into
 * an undocumented promise.
 */

import { describe, expect, it, vi, type Mock } from "bun:test";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { CANDIDATES_DIR } from "../src/utils/constants.js";

// Snapshot real modules before mock.module replaces them for this file.
const realFsPromises = { ...(await import("node:fs/promises")) };

vi.mock("node:fs/promises", async () => {
  const actual = realFsPromises as typeof import("node:fs/promises");
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

import { readFile } from "node:fs/promises";
import { listCandidatePage, writeFreshCandidate } from "../src/compiler/candidates.js";

/** Candidate files read from disk since the counter was last reset. */
function candidateReadCount(): number {
  return (readFile as unknown as Mock<typeof readFile>)
    .mock.calls.filter(([file]) => typeof file === "string" && file.includes(CANDIDATES_DIR)).length;
}

/**
 * Seed `count` pending candidates and reset the read counter, so a test counts
 * only the reads its own call made. `writeFreshCandidate` rather than
 * `writeCandidate`: the latter scans the whole queue per write to canonicalize
 * duplicates, which is O(n²) over a queue this size and would drown the very
 * reads under test. Every slug here is distinct, so there is nothing to dedup.
 */
async function seedQueue(count: number): Promise<string> {
  const root = await makeTempRoot("reviews-bounds");
  for (let i = 0; i < count; i++) {
    const slug = `candidate-${String(i).padStart(3, "0")}`;
    await writeFreshCandidate(root, {
      title: `Candidate ${i}`,
      slug,
      summary: `Summary ${i}`,
      sources: ["karpathy.md"],
      body: `---\ntitle: Candidate ${i}\n---\n\nBody ${i}.`,
    });
  }
  (readFile as unknown as Mock<typeof readFile>).mockClear();
  return root;
}

describe("listCandidatePage — bounded disk I/O", () => {
  it("reads only the served slice, not the whole queue", async () => {
    const root = await seedQueue(12);
    const page = await listCandidatePage(root, 5);
    expect(page.candidates).toHaveLength(5);
    expect(candidateReadCount()).toBe(5);
  });

  it("reports the true total without reading past the slice", async () => {
    const root = await seedQueue(12);
    const page = await listCandidatePage(root, 5);
    expect(page.total).toBe(12);
    expect(candidateReadCount()).toBe(5);
  });

  it("reads the whole queue only when the whole queue fits under the limit", async () => {
    const root = await seedQueue(4);
    const page = await listCandidatePage(root, 5);
    expect(page.candidates).toHaveLength(4);
    expect(page.total).toBe(4);
    expect(candidateReadCount()).toBe(4);
  });

  it("reads nothing when no candidates directory exists", async () => {
    const root = await makeTempRoot("reviews-bounds-empty");
    (readFile as unknown as Mock<typeof readFile>).mockClear();
    expect(await listCandidatePage(root, 5)).toEqual({ candidates: [], total: 0 });
    expect(candidateReadCount()).toBe(0);
  });
});

describe("listCandidatePage — ordering guarantee", () => {
  it("serves the first N by ascending candidate file id, the order it documents", async () => {
    const root = await seedQueue(12);
    const page = await listCandidatePage(root, 5);
    const slugs = page.candidates.map((candidate) => candidate.slug);
    expect(slugs).toEqual([
      "candidate-000",
      "candidate-001",
      "candidate-002",
      "candidate-003",
      "candidate-004",
    ]);
  });

  it("serves the same slice on every call, so a revisit is not a reshuffle", async () => {
    const root = await seedQueue(12);
    const first = await listCandidatePage(root, 5);
    const second = await listCandidatePage(root, 5);
    expect(second.candidates.map((c) => c.id)).toEqual(first.candidates.map((c) => c.id));
  });
});
