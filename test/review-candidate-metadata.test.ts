/**
 * Tests for policy-aware review candidate metadata.
 *
 * Candidate records now explain why they exist: either forced by `--review` or
 * held by project policy. These tests keep the persistence and display surface
 * pinned without expanding the already-full review.test.ts file.
 */

import { describe, it, expect, vi } from "vitest";
import { writeCandidate, readCandidate } from "../src/compiler/candidates.js";
import type { CandidateDraft } from "../src/compiler/candidates.js";
import reviewListCommand from "../src/commands/review-list.js";
import reviewShowCommand from "../src/commands/review-show.js";
import { useTempRoot } from "./fixtures/temp-root.js";

const root = useTempRoot();

const BODY = [
  "---",
  "title: Policy Held",
  "summary: Held by policy.",
  "sources: []",
  'createdAt: "2026-01-01T00:00:00.000Z"',
  'updatedAt: "2026-01-01T00:00:00.000Z"',
  "---",
  "",
  "Body.",
].join("\n");

function collectLogOutput(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map((args) => args.join(" ")).join("\n");
}

/**
 * Write a candidate from `draft`, then run `review list` + `review show <id>`
 * with console captured, returning the combined stdout. Shared by the display
 * tests so the seed → spy → render → collect boilerplate lives in one place.
 */
async function renderListAndShow(rootDir: string, draft: CandidateDraft): Promise<string> {
  const candidate = await writeCandidate(rootDir, draft);
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  await reviewListCommand();
  await reviewShowCommand(candidate.id);
  return collectLogOutput(logSpy);
}

/** A `policy`-held candidate draft body shared by the metadata + display tests. */
function policyDraft(): CandidateDraft {
  return {
    title: "Policy Held",
    slug: "policy-held",
    summary: "Held by policy.",
    sources: [],
    body: BODY,
    reviewMode: "policy",
    heldReasons: [{ code: "low-confidence", detail: "confidence 0.2 < 0.5" }],
    confidence: 0.2,
    contradicted: false,
  };
}

describe("review candidate metadata", () => {
  it("defaults writeCandidate metadata to forced manual review", async () => {
    const candidate = await writeCandidate(root.dir, {
      title: "Policy Held",
      slug: "policy-held",
      summary: "Held by policy.",
      sources: [],
      body: BODY,
    });
    const loaded = await readCandidate(root.dir, candidate.id);
    expect(loaded?.reviewMode).toBe("forced");
    expect(loaded?.heldReasons.map((r) => r.code)).toEqual(["manual-review-requested"]);
  });

  it("round-trips policy metadata and displays it in list/show", async () => {
    const output = await renderListAndShow(root.dir, policyDraft());
    expect(output).toContain("policy: low-confidence");
    expect(output).toContain("confidence 0.2 < 0.5");
    expect(output).toContain("confidence: 0.2");
    expect(output).toContain("contradicted: false");
  });

  it("surfaces the typed target in list/show for a typed candidate (FIX #4)", async () => {
    const output = await renderListAndShow(root.dir, {
      title: "Transformer",
      slug: "transformer",
      summary: "A paper.",
      sources: [],
      body: BODY,
      targetEntityType: "papers",
    });
    expect(output).toContain("→ papers/transformer");
    expect(output).toContain("Target:    wiki/papers/transformer.md");
  });

  it("default candidate list/show output omits the typed target line (FIX #4)", async () => {
    const output = await renderListAndShow(root.dir, {
      title: "Default Concept",
      slug: "default-concept",
      summary: "A concept.",
      sources: [],
      body: BODY,
    });
    expect(output).not.toContain("Target:");
    expect(output).toContain("→ default-concept ");
  });
});

