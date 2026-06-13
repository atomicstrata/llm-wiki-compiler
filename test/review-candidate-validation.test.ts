/**
 * Tests for defensive candidate JSON validation at the IO boundary.
 *
 * Candidate files are durable and user-editable. This test suite verifies that
 * malformed, truncated, or partially-invalid candidate files are skipped with a
 * warning rather than crashing `review list`, `review show`, or `listCandidates`.
 * Valid candidates co-existing with malformed ones must still be returned.
 */

import { describe, it, expect, vi } from "vitest";
import { writeFile, mkdir } from "fs/promises";
import path from "path";
import {
  listCandidates,
  readCandidate,
  writeCandidate,
} from "../src/compiler/candidates.js";
import reviewListCommand from "../src/commands/review-list.js";
import reviewShowCommand from "../src/commands/review-show.js";
import { useTempRoot } from "./fixtures/temp-root.js";

const root = useTempRoot();

const CANDIDATES_DIR = ".llmwiki/candidates";

/** Write a raw JSON string directly into the candidates dir (bypassing validation). */
async function writeMalformedCandidate(dir: string, filename: string, content: string) {
  const candidatesPath = path.join(dir, CANDIDATES_DIR);
  await mkdir(candidatesPath, { recursive: true });
  await writeFile(path.join(candidatesPath, filename), content, "utf-8");
}

/** Minimal valid candidate draft for seeding alongside malformed files. */
function validDraft(slug: string) {
  return {
    title: slug,
    slug,
    summary: `Summary for ${slug}.`,
    sources: ["source.md"],
    body: "Body.",
  };
}

describe("candidate JSON validation (Issue C)", () => {
  it("skips truncated/unparseable JSON and still lists valid candidates", async () => {
    await writeMalformedCandidate(root.dir, "bad-truncated.json", '{"id":"bad-trunc","title":"T","slug":"bad-trunc","body":"B","sources":[');
    const valid = await writeCandidate(root.dir, validDraft("good-slug"));

    const candidates = await listCandidates(root.dir);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.id).toBe(valid.id);
  });

  it("skips a candidate missing required fields (id) without throwing", async () => {
    const noId = { title: "T", slug: "no-id", body: "B", sources: [] };
    await writeMalformedCandidate(root.dir, "no-id.json", JSON.stringify(noId));

    const candidates = await listCandidates(root.dir);
    expect(candidates).toHaveLength(0);
  });

  it("defaults generatedAt when it is a number (non-string)", async () => {
    const badDate = {
      id: "bad-date-cand",
      title: "T",
      slug: "bad-date",
      body: "B",
      sources: [],
      generatedAt: 12345,
      reviewMode: "forced",
      heldReasons: [{ code: "manual-review-requested" }],
    };
    await writeMalformedCandidate(root.dir, "bad-date-cand.json", JSON.stringify(badDate));

    const candidate = await readCandidate(root.dir, "bad-date-cand");
    expect(candidate).not.toBeNull();
    expect(typeof candidate?.generatedAt).toBe("string");
  });

  it("defaults reviewMode when value is not a valid ReviewMode", async () => {
    const bogusMode = {
      id: "bogus-mode-cand",
      title: "T",
      slug: "bogus-mode",
      body: "B",
      sources: [],
      generatedAt: "2026-01-01T00:00:00.000Z",
      reviewMode: "bogus",
      heldReasons: [{ code: "manual-review-requested" }],
    };
    await writeMalformedCandidate(root.dir, "bogus-mode-cand.json", JSON.stringify(bogusMode));

    const candidate = await readCandidate(root.dir, "bogus-mode-cand");
    expect(candidate?.reviewMode).toBe("forced");
  });

  it("drops unknown heldReasons entries and defaults to manual-review-requested when missing", async () => {
    const noReasons = {
      id: "no-reasons-cand",
      title: "T",
      slug: "no-reasons",
      body: "B",
      sources: [],
      generatedAt: "2026-01-01T00:00:00.000Z",
      reviewMode: "forced",
    };
    await writeMalformedCandidate(root.dir, "no-reasons-cand.json", JSON.stringify(noReasons));

    const candidate = await readCandidate(root.dir, "no-reasons-cand");
    expect(candidate?.heldReasons).toEqual([{ code: "manual-review-requested" }]);
  });

  it("drops heldReasons entries with unknown codes", async () => {
    const unknownCode = {
      id: "unk-code-cand",
      title: "T",
      slug: "unk-code",
      body: "B",
      sources: [],
      generatedAt: "2026-01-01T00:00:00.000Z",
      reviewMode: "forced",
      heldReasons: [
        { code: "unknown-code" },
        { code: "low-confidence" },
        { notACode: true },
      ],
    };
    await writeMalformedCandidate(root.dir, "unk-code-cand.json", JSON.stringify(unknownCode));

    const candidate = await readCandidate(root.dir, "unk-code-cand");
    expect(candidate?.heldReasons.map((r) => r.code)).toEqual(["low-confidence"]);
  });

  it("review list does not throw when malformed files are present", async () => {
    await writeMalformedCandidate(root.dir, "crash-bait.json", "not-json-at-all!!!");
    await writeCandidate(root.dir, validDraft("safe-slug"));

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(reviewListCommand()).resolves.not.toThrow();
    const out = logSpy.mock.calls.map((a) => a.join(" ")).join("\n");
    expect(out).toContain("safe-slug");
  });

  it("review show does not throw for a valid candidate even when malformed files exist", async () => {
    await writeMalformedCandidate(root.dir, "another-bad.json", '{"broken":}');
    const good = await writeCandidate(root.dir, validDraft("show-safe-slug"));

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(reviewShowCommand(good.id)).resolves.not.toThrow();
    const out = logSpy.mock.calls.map((a) => a.join(" ")).join("\n");
    expect(out).toContain("show-safe-slug");
  });

  it("heldReasons defaults to manual-review-requested when array is empty after filtering", async () => {
    const allBadReasons = {
      id: "all-bad-reasons",
      title: "T",
      slug: "all-bad",
      body: "B",
      sources: [],
      generatedAt: "2026-01-01T00:00:00.000Z",
      reviewMode: "forced",
      heldReasons: [{ code: "totally-invalid" }, { notCode: "missing" }],
    };
    await writeMalformedCandidate(root.dir, "all-bad-reasons.json", JSON.stringify(allBadReasons));

    const candidate = await readCandidate(root.dir, "all-bad-reasons");
    expect(candidate?.heldReasons).toEqual([{ code: "manual-review-requested" }]);
  });
});
