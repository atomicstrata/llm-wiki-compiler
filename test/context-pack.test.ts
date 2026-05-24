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

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { buildContextPack } from "../src/context/build.js";
import { estimateTokens } from "../src/context/budget.js";
import { PROMPT_ECHO_MAX_LENGTH } from "../src/context/types.js";
import { CONCEPTS_DIR, QUERIES_DIR } from "../src/utils/constants.js";

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
});
