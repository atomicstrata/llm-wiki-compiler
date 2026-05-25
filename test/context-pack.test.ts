/**
 * Unit tests for the Slice 1 lexical context-pack builder.
 *
 * Pins the v1 JSON field set, the lexical reason vocabulary
 * (`title-match` / `body-match` / `exact-slug` / `exact-title`), prompt
 * truncation, the `--omit-root` knob, the stable suggestedActions
 * prefix (recommended + otherActions from the shared engine), and the
 * empty-wiki behavior.
 *
 * Tests build a temp project root and seed wiki pages on disk; the
 * builder consumes the same viewer snapshot path that production uses.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { buildContextPack } from "../src/context/build.js";
import { estimateTokens, estimatePackTokens } from "../src/context/budget.js";
import { PROMPT_ECHO_MAX_LENGTH } from "../src/context/types.js";
import { retrieveSemanticChunks } from "../src/context/retrieval.js";
import type { SemanticChunkHit } from "../src/context/retrieval.js";
import { CONCEPTS_DIR, QUERIES_DIR } from "../src/utils/constants.js";

// Stub semantic retrieval at the module boundary so each test can drive
// build.ts deterministically without touching disk-resident embedding
// stores. The default `{ hits: [], warning: null }` keeps the legacy
// Slice 1 lexical-only behaviour byte-for-byte — every existing test
// runs as if the embedding store does not exist (which is true in the
// fresh temp roots these tests build).
vi.mock("../src/context/retrieval.js", () => ({
  retrieveSemanticChunks: vi.fn(async () => ({ hits: [], warning: null })),
}));
const mockedRetrieve = vi.mocked(retrieveSemanticChunks);

beforeEach(() => {
  mockedRetrieve.mockReset();
  mockedRetrieve.mockResolvedValue({ hits: [], warning: null });
});

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "context-pack-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

/** Write a markdown page with a deterministic title + body into `dir`. */
async function writePage(
  dir: string,
  slug: string,
  title: string,
  body: string = "",
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const content = `---\ntitle: ${title}\n---\n\n${body}\n`;
  await writeFile(path.join(dir, `${slug}.md`), content, "utf-8");
}

describe("buildContextPack — v1 JSON contract stability", () => {
  it("emits the full top-level field set even for an empty wiki", async () => {
    const pack = await buildContextPack({ root: tmpDir, prompt: "anything" });
    expect(Object.keys(pack)).toEqual([
      "version",
      "prompt",
      "budget",
      "project",
      "primary",
      "neighbors",
      "warnings",
      "gaps",
      "suggestedActions",
    ]);
    expect(pack.version).toBe(1);
  });

  it("gaps[].pageId is a required string in v1 (no project-wide gaps yet)", async () => {
    // Slice 1 produces no gaps, but the type system must already
    // forbid `null` so a future emitter doesn't accidentally ship a
    // null pageId before we bump `version`. This guard ensures the
    // type stays non-nullable; runtime gaps will start flowing in
    // Slice 3 (dangling links) and Slice 4 (page warnings).
    const pack = await buildContextPack({ root: tmpDir, prompt: "anything" });
    for (const gap of pack.gaps) {
      expect(typeof gap.pageId).toBe("string");
      expect(gap.pageId.length).toBeGreaterThan(0);
    }
  });

  it("populates later-slice fields as empty arrays so consumers don't see field-presence drift", async () => {
    const pack = await buildContextPack({ root: tmpDir, prompt: "anything" });
    expect(pack.primary).toEqual([]);
    expect(pack.neighbors).toEqual([]);
    expect(pack.gaps).toEqual([]);
  });

  it("emits null for absent lint cache (not omitted)", async () => {
    const pack = await buildContextPack({ root: tmpDir, prompt: "x" });
    expect(pack.project.lint).toBeNull();
  });
});

describe("buildContextPack — lexical ranking via searchPages.matchedIn", () => {
  it("tags title-match when the prompt matches a page title", async () => {
    await writePage(path.join(tmpDir, CONCEPTS_DIR), "alpha", "Alpha", "unrelated body");
    const pack = await buildContextPack({ root: tmpDir, prompt: "alpha" });
    expect(pack.primary.length).toBe(1);
    expect(pack.primary[0].reasons).toContain("title-match");
  });

  it("tags body-match when the prompt only appears in the body", async () => {
    await writePage(path.join(tmpDir, CONCEPTS_DIR), "intro", "Welcome", "deep body keyword here");
    const pack = await buildContextPack({ root: tmpDir, prompt: "keyword" });
    expect(pack.primary[0].reasons).toContain("body-match");
    expect(pack.primary[0].reasons).not.toContain("title-match");
  });

  it("tags exact-slug when prompt matches a page's slug verbatim", async () => {
    await writePage(path.join(tmpDir, CONCEPTS_DIR), "retrieval", "Some Other Title");
    const pack = await buildContextPack({ root: tmpDir, prompt: "retrieval" });
    expect(pack.primary[0].reasons).toContain("exact-slug");
  });

  it("tags exact-title when prompt matches a page title verbatim (case-insensitive)", async () => {
    await writePage(path.join(tmpDir, CONCEPTS_DIR), "x", "BM25");
    const pack = await buildContextPack({ root: tmpDir, prompt: "bm25" });
    expect(pack.primary[0].reasons).toContain("exact-title");
  });

  it("scores exact-title above body-match-only and respects the stable tie sort", async () => {
    await writePage(path.join(tmpDir, CONCEPTS_DIR), "a", "Match", "body");
    await writePage(path.join(tmpDir, CONCEPTS_DIR), "b", "Other", "the word Match appears here");
    const pack = await buildContextPack({ root: tmpDir, prompt: "Match" });
    expect(pack.primary[0].id).toBe("concepts/a");
    expect(pack.primary[1].id).toBe("concepts/b");
  });

  it("returns reasons sorted alphabetically so snapshot tests stay stable", async () => {
    await writePage(path.join(tmpDir, CONCEPTS_DIR), "bm25", "BM25", "BM25 reranking text");
    const pack = await buildContextPack({ root: tmpDir, prompt: "bm25" });
    const reasons = pack.primary[0].reasons;
    expect([...reasons].sort()).toEqual(reasons);
  });
});

describe("buildContextPack — empty wiki", () => {
  it("returns primary=[] and a non-empty suggestedActions prefix", async () => {
    const pack = await buildContextPack({ root: tmpDir, prompt: "anything" });
    expect(pack.primary).toEqual([]);
    expect(pack.suggestedActions.length).toBeGreaterThan(0);
    expect(pack.suggestedActions[0].command).toBe("llmwiki quickstart <source>");
  });
});

describe("buildContextPack — --omit-root", () => {
  it("emits project.root = null but keeps the field present", async () => {
    const pack = await buildContextPack({ root: tmpDir, prompt: "x", omitRoot: true });
    expect(Object.keys(pack.project)).toContain("root");
    expect(pack.project.root).toBeNull();
  });

  it("emits the absolute root by default", async () => {
    const pack = await buildContextPack({ root: tmpDir, prompt: "x" });
    expect(pack.project.root).toBe(tmpDir);
  });
});

describe("buildContextPack — prompt truncation", () => {
  it("truncates the echoed prompt at PROMPT_ECHO_MAX_LENGTH and emits truncated-prompt warning", async () => {
    const longPrompt = "a".repeat(PROMPT_ECHO_MAX_LENGTH + 50);
    const pack = await buildContextPack({ root: tmpDir, prompt: longPrompt });
    expect(pack.prompt.length).toBe(PROMPT_ECHO_MAX_LENGTH);
    expect(pack.warnings.map((w) => w.code)).toContain("truncated-prompt");
  });

  it("does not warn or truncate when the prompt is exactly at the cap", async () => {
    const exact = "b".repeat(PROMPT_ECHO_MAX_LENGTH);
    const pack = await buildContextPack({ root: tmpDir, prompt: exact });
    expect(pack.prompt.length).toBe(PROMPT_ECHO_MAX_LENGTH);
    expect(pack.warnings.some((w) => w.code === "truncated-prompt")).toBe(false);
  });

  it("ranks against the original prompt — title token still matches when the prompt overflows the echo cap", async () => {
    // Pin the contract that truncation is display-only: a prompt whose
    // tokens all match a page title but whose total length exceeds the
    // echo cap must still surface the page in `primary[]`. If the
    // orchestrator handed the truncated form to `rankPages` (the bug),
    // ranking would still see the same tokens here because
    // `searchPages` caps at 200 chars internally; the regression
    // surface for that bug is Slice 2's semantic retrieval. This test
    // proves the lexical pipeline keeps working in the presence of
    // echo-cap truncation, and the test comment documents that the
    // truncated-vs-original distinction is unobservable through
    // Slice 1's signals (`searchPages` 200-char cap + whole-prompt
    // exact-match) — Slice 2 will start producing different scores.
    await writePage(path.join(tmpDir, CONCEPTS_DIR), "alpha", "Alpha", "body");
    const overflowingPrompt = "alpha ".repeat(200);
    expect(overflowingPrompt.length).toBeGreaterThan(PROMPT_ECHO_MAX_LENGTH);
    const pack = await buildContextPack({ root: tmpDir, prompt: overflowingPrompt });
    expect(pack.prompt.length).toBe(PROMPT_ECHO_MAX_LENGTH);
    expect(pack.warnings.map((w) => w.code)).toContain("truncated-prompt");
    expect(pack.primary.map((p) => p.id)).toContain("concepts/alpha");
    expect(pack.primary[0].reasons).toContain("title-match");
  });
});

describe("buildContextPack — suggestedActions prefix matches recommendNextAction", () => {
  it("places recommendNextAction.recommended at index 0", async () => {
    await writePage(path.join(tmpDir, CONCEPTS_DIR), "ready", "Ready");
    const pack = await buildContextPack({ root: tmpDir, prompt: "ready" });
    expect(pack.suggestedActions[0].command).toBe("llmwiki view --open");
  });

  it("appends otherActions in declared order after the primary recommendation", async () => {
    await writePage(path.join(tmpDir, QUERIES_DIR), "q", "QueryPage");
    const pack = await buildContextPack({ root: tmpDir, prompt: "querypage" });
    const args = pack.suggestedActions.map((a) => a.executable?.args.join(" "));
    expect(args.slice(0, 1)).toEqual(["view --open"]);
    expect(args.slice(1)).toContain("query");
  });
});

describe("buildContextPack — budget envelope", () => {
  it("estimates tokens using the chars/4 heuristic on the serialized pack", async () => {
    const pack = await buildContextPack({ root: tmpDir, prompt: "x", budget: 500 });
    expect(pack.budget.requestedTokens).toBe(500);
    expect(pack.budget.estimatedTokens).toBeGreaterThan(0);
    expect(pack.budget.truncated).toBe(false);
    expect(pack.budget.trimmedSections).toEqual([]);
  });

  it("estimateTokens helper is deterministic and pessimistic on the high side", () => {
    expect(estimateTokens("hi")).toBe(1);
    expect(estimateTokens("a".repeat(8))).toBe(2);
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens(null)).toBe(0);
  });

  it("with a tiny --budget, sets truncated=true and non-empty trimmedSections (still valid JSON)", async () => {
    // One concept page plus default deterministic warnings/suggestions
    // produces an envelope well over 1 token; trimming must fire.
    await writePage(path.join(tmpDir, CONCEPTS_DIR), "alpha", "Alpha", "Some prose body.");
    const pack = await buildContextPack({ root: tmpDir, prompt: "alpha", budget: 1 });
    expect(pack.budget.truncated).toBe(true);
    expect(pack.budget.trimmedSections.length).toBeGreaterThan(0);
    // Trimming must not produce invalid output — round-trip through
    // JSON.parse to prove the envelope still parses.
    expect(() => JSON.parse(JSON.stringify(pack))).not.toThrow();
    // trimmedSections only contains the documented section keys.
    const allowed = new Set(["neighbors", "sourceWindows", "chunks", "primary"]);
    for (const section of pack.budget.trimmedSections) expect(allowed.has(section)).toBe(true);
  });

  it("trims `primary` last and reports it in trimmedSections when no other section can satisfy the budget", async () => {
    // One matching page → primary[] starts with one entry; chunks +
    // sourceWindows + neighbors are all empty in this fixture, so the
    // trimmer descends to the documented last-resort section.
    await writePage(path.join(tmpDir, CONCEPTS_DIR), "alpha", "Alpha", "body one");
    const pack = await buildContextPack({ root: tmpDir, prompt: "alpha", budget: 1 });
    expect(pack.budget.trimmedSections).toContain("primary");
    expect(pack.primary.length).toBe(0);
  });

  it("marks an irreducible empty-wiki envelope as truncated with trimmedSections=[]", async () => {
    // Edge case: a completely empty wiki still produces an envelope
    // larger than 1 token because of the stable metadata + suggested
    // actions block. The trimmer has nothing to drop, so
    // trimmedSections legitimately stays empty — but `truncated`
    // MUST flip to `true` so consumers can tell the budget was
    // overshot. The closed section-key contract is preserved: we
    // never invent a sentinel section name.
    const pack = await buildContextPack({ root: tmpDir, prompt: "anything", budget: 1 });
    expect(pack.budget.truncated).toBe(true);
    expect(pack.budget.trimmedSections).toEqual([]);
    expect(pack.budget.estimatedTokens).toBeGreaterThan(1);
    // Envelope still round-trips through JSON parsing.
    expect(() => JSON.parse(JSON.stringify(pack))).not.toThrow();
  });

  it("reported estimatedTokens matches estimatePackTokens(finalPack) within one character of digit drift", async () => {
    // After the two-pass re-estimate the reported value should match
    // the actual JSON-string-length estimate of the final envelope
    // exactly (or within a single token in the rare digit-flip case,
    // e.g. estimate climbs from 99 to 100 between passes).
    await writePage(path.join(tmpDir, CONCEPTS_DIR), "alpha", "Alpha", "body one");
    const pack = await buildContextPack({ root: tmpDir, prompt: "alpha", budget: 500 });
    const actual = estimatePackTokens(pack);
    expect(Math.abs(pack.budget.estimatedTokens - actual)).toBeLessThanOrEqual(1);
  });
});

/**
 * Build one SemanticChunkHit for `slug` with deterministic text/score.
 * Used by Slice 2 ranker tests to drive the mocked retrieval without
 * hand-spelling every field per assertion.
 */
function hitFor(slug: string, score: number, suffix = ""): SemanticChunkHit {
  return {
    slug,
    text: `chunk text for ${slug}${suffix}`,
    score,
    contentHash: `hash-${slug}${suffix}`,
  };
}

describe("buildContextPack — Slice 2 semantic retrieval integration", () => {
  it("forwards the configured topChunks (default 8) into retrieveSemanticChunks", async () => {
    await buildContextPack({ root: tmpDir, prompt: "anything" });
    expect(mockedRetrieve).toHaveBeenCalledTimes(1);
    const [, , topChunks] = mockedRetrieve.mock.calls[0];
    expect(topChunks).toBe(8);
  });

  it("forwards an explicit --top-chunks override into retrieveSemanticChunks", async () => {
    await buildContextPack({ root: tmpDir, prompt: "x", topChunks: 3 });
    const [, , topChunks] = mockedRetrieve.mock.calls[0];
    expect(topChunks).toBe(3);
  });

  it("passes the FULL ranking prompt (not the truncated echo) to retrieval", async () => {
    const longPrompt = "a".repeat(PROMPT_ECHO_MAX_LENGTH + 100);
    await buildContextPack({ root: tmpDir, prompt: longPrompt });
    const [, promptArg] = mockedRetrieve.mock.calls[0];
    expect(promptArg).toBe(longPrompt);
    expect((promptArg as string).length).toBeGreaterThan(PROMPT_ECHO_MAX_LENGTH);
  });

  it("merges semantic-chunk reason and chunks[] when retrieval returns hits", async () => {
    await writePage(path.join(tmpDir, CONCEPTS_DIR), "retrieval", "Retrieval");
    mockedRetrieve.mockResolvedValueOnce({
      hits: [hitFor("retrieval", 0.92)],
      warning: null,
    });
    const pack = await buildContextPack({ root: tmpDir, prompt: "unrelated query" });
    expect(pack.primary.length).toBe(1);
    expect(pack.primary[0].id).toBe("concepts/retrieval");
    expect(pack.primary[0].reasons).toContain("semantic-chunk");
    expect(pack.primary[0].chunks).toHaveLength(1);
    expect(pack.primary[0].chunks[0]).toEqual({
      text: "chunk text for retrieval",
      score: 0.92,
      contentHash: "hash-retrieval",
    });
  });

  it("de-dupes a page that matched both lexically and semantically and unions reasons", async () => {
    await writePage(path.join(tmpDir, CONCEPTS_DIR), "shared", "Shared", "lexical body");
    mockedRetrieve.mockResolvedValueOnce({
      hits: [hitFor("shared", 0.8)],
      warning: null,
    });
    const pack = await buildContextPack({ root: tmpDir, prompt: "shared" });
    expect(pack.primary.length).toBe(1);
    expect(pack.primary[0].reasons).toEqual(
      expect.arrayContaining(["semantic-chunk", "title-match", "exact-slug", "exact-title"]),
    );
    expect(pack.primary[0].chunks).toHaveLength(1);
  });

  it("attaches multiple chunks for the same page in retrieval order", async () => {
    await writePage(path.join(tmpDir, CONCEPTS_DIR), "alpha", "Alpha");
    mockedRetrieve.mockResolvedValueOnce({
      hits: [
        hitFor("alpha", 0.9, "-1"),
        hitFor("alpha", 0.8, "-2"),
        hitFor("alpha", 0.7, "-3"),
      ],
      warning: null,
    });
    const pack = await buildContextPack({ root: tmpDir, prompt: "unrelated" });
    expect(pack.primary[0].chunks.map((c) => c.contentHash)).toEqual([
      "hash-alpha-1",
      "hash-alpha-2",
      "hash-alpha-3",
    ]);
  });

  it("silently drops chunks whose slug is missing from the snapshot", async () => {
    mockedRetrieve.mockResolvedValueOnce({
      hits: [hitFor("ghost-slug", 0.9)],
      warning: null,
    });
    const pack = await buildContextPack({ root: tmpDir, prompt: "anything" });
    expect(pack.primary).toEqual([]);
  });

  it("emits embedding-store-missing warning when retrieval reports the store is unusable", async () => {
    mockedRetrieve.mockResolvedValueOnce({
      hits: [],
      warning: "embedding-store-missing",
    });
    const pack = await buildContextPack({ root: tmpDir, prompt: "anything" });
    expect(pack.warnings.map((w) => w.code)).toContain("embedding-store-missing");
  });

  it("emits query-embedding-unavailable warning when retrieval reports the provider failed", async () => {
    mockedRetrieve.mockResolvedValueOnce({
      hits: [],
      warning: "query-embedding-unavailable",
    });
    const pack = await buildContextPack({ root: tmpDir, prompt: "anything" });
    expect(pack.warnings.map((w) => w.code)).toContain("query-embedding-unavailable");
  });

  it("still ranks lexically when the warning fires (no crash, primary populated by other signals)", async () => {
    await writePage(path.join(tmpDir, CONCEPTS_DIR), "alpha", "Alpha");
    mockedRetrieve.mockResolvedValueOnce({
      hits: [],
      warning: "query-embedding-unavailable",
    });
    const pack = await buildContextPack({ root: tmpDir, prompt: "alpha" });
    expect(pack.primary.length).toBe(1);
    expect(pack.primary[0].reasons).toContain("title-match");
    expect(pack.primary[0].reasons).not.toContain("semantic-chunk");
    expect(pack.warnings.map((w) => w.code)).toContain("query-embedding-unavailable");
  });
});

/**
 * Seed two concept pages where `from` carries a wikilink to `to`. Both
 * pages match the prompt "alpha beta" through title tokens so they
 * both land in `primary[]` via lexical signals; the wikilink between
 * them is what `annotateGraphNeighbors` should pick up.
 */
async function seedTwoLinkedConcepts(): Promise<void> {
  await writePage(
    path.join(tmpDir, CONCEPTS_DIR),
    "alpha",
    "Alpha Beta",
    "[[Alpha Beta Two]]\n",
  );
  await writePage(
    path.join(tmpDir, CONCEPTS_DIR),
    "alpha-beta-two",
    "Alpha Beta Two",
    "body two",
  );
}

describe("buildContextPack — graph-neighbor reason annotation", () => {
  it("two primary pages connected by a wikilink each gain `graph-neighbor` as an additional reason", async () => {
    await seedTwoLinkedConcepts();
    const pack = await buildContextPack({ root: tmpDir, prompt: "alpha beta" });
    expect(pack.primary.length).toBe(2);
    for (const entry of pack.primary) {
      expect(entry.reasons).toContain("graph-neighbor");
      // Additive only: every annotated entry still carries at least
      // one non-graph signal (the ranking that earned its slot).
      const nonGraph = entry.reasons.filter((r) => r !== "graph-neighbor");
      expect(nonGraph.length).toBeGreaterThan(0);
      // Reasons remain alphabetically sorted and de-duped.
      expect([...entry.reasons].sort()).toEqual(entry.reasons);
      expect(new Set(entry.reasons).size).toBe(entry.reasons.length);
    }
  });

  it("does NOT promote graph-only pages into primary[] (only annotates existing entries)", async () => {
    // Alpha is the only page that matches the prompt; Beta is linked
    // from Alpha but matches no lexical/exact/semantic signal of its
    // own. Beta must stay out of primary[] entirely.
    await writePage(path.join(tmpDir, CONCEPTS_DIR), "alpha", "Alpha", "[[Beta]]\n");
    await writePage(path.join(tmpDir, CONCEPTS_DIR), "beta", "Beta", "unrelated body");
    const pack = await buildContextPack({ root: tmpDir, prompt: "alpha" });
    const primaryIds = pack.primary.map((p) => p.id);
    expect(primaryIds).toContain("concepts/alpha");
    expect(primaryIds).not.toContain("concepts/beta");
    // Alpha has no other primary peer to link to → no graph-neighbor.
    const alpha = pack.primary.find((p) => p.id === "concepts/alpha");
    expect(alpha?.reasons).not.toContain("graph-neighbor");
  });

  it("`--no-neighbors` suppresses the graph-neighbor reason on connected primary pages", async () => {
    await seedTwoLinkedConcepts();
    const pack = await buildContextPack({
      root: tmpDir,
      prompt: "alpha beta",
      neighbors: false,
    });
    for (const entry of pack.primary) {
      expect(entry.reasons).not.toContain("graph-neighbor");
    }
  });

  it("`depth: 0` suppresses the graph-neighbor reason on connected primary pages", async () => {
    await seedTwoLinkedConcepts();
    const pack = await buildContextPack({
      root: tmpDir,
      prompt: "alpha beta",
      depth: 0,
    });
    for (const entry of pack.primary) {
      expect(entry.reasons).not.toContain("graph-neighbor");
    }
  });
});
