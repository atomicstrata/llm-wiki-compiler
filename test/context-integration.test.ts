/**
 * Subprocess integration tests for `llmwiki context`.
 *
 * Runs the compiled CLI binary end-to-end via `runCLI`, so the v1 JSON
 * contract, exit codes, ANSI hygiene, and the `--omit-root` flag are
 * pinned at the same surface real users (and agents) see. No provider
 * credentials are required — Slice 1 is lexical-only.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { runCLI, expectCLIExit } from "./fixtures/run-cli.js";
import { runContextJson } from "./fixtures/context-cli-helpers.js";
import {
  mockOpenAIEnv,
  useAimockLifecycle,
  type MockClaudeHandle,
} from "./fixtures/aimock-helper.js";
import { CONCEPTS_DIR, EMBEDDINGS_FILE, LLMWIKI_DIR } from "../src/utils/constants.js";

const aimock = useAimockLifecycle("context-cli");

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "context-cli-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

/** Seed one concept page so the lexical ranker has something to find. */
async function seedConcept(slug: string, title: string, body: string = ""): Promise<void> {
  await mkdir(path.join(tmpDir, CONCEPTS_DIR), { recursive: true });
  const content = `---\ntitle: ${title}\n---\n\n${body}\n`;
  await writeFile(path.join(tmpDir, CONCEPTS_DIR, `${slug}.md`), content, "utf-8");
}

/** Local wrapper that forwards to the shared helper with this file's tmpDir. */
async function runJsonContext(
  prompt: string,
  extra: string[] = [],
): Promise<Record<string, unknown>> {
  return runContextJson(tmpDir, prompt, extra);
}

/** Extract the stable list of `warnings[].code` values from a JSON payload. */
function warningCodesOf(payload: Record<string, unknown>): string[] {
  const warnings = payload.warnings as Array<Record<string, unknown>>;
  return warnings.map((w) => w.code as string);
}

/** Assert primary[] is non-empty and return the first entry for further assertions. */
function firstPrimary(payload: Record<string, unknown>): Record<string, unknown> {
  const primary = payload.primary as Array<Record<string, unknown>>;
  expect(primary.length).toBeGreaterThanOrEqual(1);
  return primary[0];
}

describe("`llmwiki context --json` — JSON envelope", () => {
  it("returns version 1 and stable top-level field set on an empty wiki", async () => {
    const payload = await runJsonContext("anything");
    expect(payload.version).toBe(1);
    expect(Object.keys(payload)).toEqual([
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
  });

  it("classifies a seeded page lexically and surfaces matchedIn-derived reasons", async () => {
    await seedConcept("retrieval", "Retrieval");
    const payload = await runJsonContext("retrieval");
    const top = firstPrimary(payload);
    expect(top.id).toBe("concepts/retrieval");
    expect(top.reasons as string[]).toEqual(
      expect.arrayContaining(["title-match", "exact-slug", "exact-title"]),
    );
  });

  it("emits no ANSI escape sequences in --json output", async () => {
    await seedConcept("alpha", "Alpha");
    const result = await runCLI(["context", "alpha", "--json"], tmpDir);
    expectCLIExit(result, 0);
    // eslint-disable-next-line no-control-regex
    expect(result.stdout).not.toMatch(/\x1b\[/);
  });

  it("places the recommendNextAction prefix in suggestedActions[0]", async () => {
    await seedConcept("hello", "Hello");
    const payload = await runJsonContext("hello");
    const actions = payload.suggestedActions as Array<Record<string, unknown>>;
    expect(actions.length).toBeGreaterThan(0);
    expect(actions[0].command).toBe("llmwiki view --open");
  });
});

describe("`llmwiki context --json --omit-root`", () => {
  it("sets project.root to null while keeping the field present", async () => {
    const payload = await runJsonContext("anything", ["--omit-root"]);
    const project = payload.project as Record<string, unknown>;
    expect(Object.keys(project)).toContain("root");
    expect(project.root).toBeNull();
  });
});

describe("`llmwiki context` — long prompt truncation", () => {
  it("truncates the echoed prompt and emits truncated-prompt warning", async () => {
    const longPrompt = "z".repeat(1100);
    const payload = await runJsonContext(longPrompt);
    expect((payload.prompt as string).length).toBe(1024);
    const warnings = payload.warnings as Array<Record<string, unknown>>;
    expect(warnings.map((w) => w.code)).toContain("truncated-prompt");
  });
});

describe("`llmwiki context` — markdown output", () => {
  it("renders a basic Context Pack markdown skeleton with primary and suggested actions", async () => {
    await seedConcept("alpha", "Alpha");
    const result = await runCLI(["context", "alpha"], tmpDir);
    expectCLIExit(result, 0);
    expect(result.stdout).toContain("# Context Pack");
    expect(result.stdout).toContain("## Primary Pages");
    expect(result.stdout).toContain("## Suggested Next Actions");
    expect(result.stdout).toContain("llmwiki view --open");
  });

  it("falls through to markdown when --format markdown is supplied explicitly", async () => {
    const result = await runCLI(["context", "x", "--format", "markdown"], tmpDir);
    expectCLIExit(result, 0);
    expect(result.stdout.startsWith("# Context Pack")).toBe(true);
  });

  it("--json wins over --format markdown when both are supplied", async () => {
    const result = await runCLI(["context", "x", "--format", "markdown", "--json"], tmpDir);
    expectCLIExit(result, 0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed.version).toBe(1);
  });
});

describe("`llmwiki context` — defaults", () => {
  it("uses 8000 as the default budget when --budget is omitted", async () => {
    const payload = await runJsonContext("anything");
    const budget = payload.budget as Record<string, unknown>;
    expect(budget.requestedTokens).toBe(8000);
  });

  it("respects an explicit --budget override", async () => {
    const payload = await runJsonContext("anything", ["--budget", "1234"]);
    const budget = payload.budget as Record<string, unknown>;
    expect(budget.requestedTokens).toBe(1234);
  });
});

/**
 * Seed a v2 embedding store with one chunk that has a known vector and
 * model. The model defaults to what `mockOpenAIEnv` configures
 * (`text-embedding-3-small`) so the active-model check inside
 * `loadActiveStore` passes for aimock-driven runs. Pass an override
 * (e.g. `voyage-3-lite`) for tests that drive the anthropic fallback.
 */
async function seedEmbeddingStore(
  root: string,
  options: { model?: string; vector?: number[] } = {},
): Promise<void> {
  const vector = options.vector ?? [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7];
  const store = {
    version: 2,
    model: options.model ?? "text-embedding-3-small",
    dimensions: vector.length,
    entries: [
      {
        slug: "retrieval",
        title: "Retrieval",
        summary: "Page-level embedding for retrieval.",
        vector,
        updatedAt: "2026-05-24T00:00:00.000Z",
      },
    ],
    chunks: [
      {
        slug: "retrieval",
        title: "Retrieval",
        chunkIndex: 0,
        contentHash: "seeded-hash",
        text: "Seeded chunk body about retrieval.",
        vector,
        updatedAt: "2026-05-24T00:00:00.000Z",
      },
    ],
  };
  await mkdir(path.join(root, LLMWIKI_DIR), { recursive: true });
  await writeFile(
    path.join(root, EMBEDDINGS_FILE),
    JSON.stringify(store, null, 2),
    "utf-8",
  );
}

/** Strip any inherited provider creds so the test sees a clean fallback. */
function noCredentialsEnv(): NodeJS.ProcessEnv {
  return {
    LLMWIKI_PROVIDER: "anthropic",
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_AUTH_TOKEN: "",
    VOYAGE_API_KEY: "",
    LLMWIKI_CLAUDE_SETTINGS_PATH: "/path/that/does/not/exist.json",
  };
}

describe("`llmwiki context` — Slice 2 semantic fallback warnings", () => {
  it("emits embedding-store-missing when no .llmwiki/embeddings.json exists", async () => {
    await seedConcept("alpha", "Alpha");
    const payload = await runJsonContext("alpha");
    expect(warningCodesOf(payload)).toContain("embedding-store-missing");
    // Lexical signals still rank the page even without semantic input.
    firstPrimary(payload);
  });

  it("emits embedding-store-missing when the store has no chunks (v1 / empty v2)", async () => {
    await seedConcept("alpha", "Alpha");
    // Seed an empty v2 store — the wrapper's pre-check treats it as unusable.
    await mkdir(path.join(tmpDir, LLMWIKI_DIR), { recursive: true });
    await writeFile(
      path.join(tmpDir, EMBEDDINGS_FILE),
      JSON.stringify({
        version: 2,
        model: "text-embedding-3-small",
        dimensions: 4,
        entries: [],
        chunks: [],
      }),
      "utf-8",
    );
    const payload = await runJsonContext("alpha");
    expect(warningCodesOf(payload)).toContain("embedding-store-missing");
  });

  it("emits query-embedding-unavailable when the provider has no credentials", async () => {
    await seedConcept("alpha", "Alpha");
    // Seed a valid v2 store with the anthropic embedding model so the
    // active-model check passes; embed() then throws when VOYAGE_API_KEY
    // is missing and the wrapper translates the throw into a stable warning.
    await seedEmbeddingStore(tmpDir, { model: "voyage-3-lite" });
    const result = await runCLI(
      ["context", "alpha", "--json"],
      tmpDir,
      noCredentialsEnv(),
    );
    expectCLIExit(result, 0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(warningCodesOf(payload)).toContain("query-embedding-unavailable");
    // Lexical fallback still places the page.
    firstPrimary(payload);
  });

  it("stale-model store keeps --json output pure (no stdout warning leaks)", async () => {
    // Regression: previously `findRelevantChunks` -> `loadActiveStore`
    // wrote a `! Embedding store was built with ...` line to stdout via
    // `output.status`, breaking JSON parsing. The wrapper must detect
    // the model mismatch up front and skip the call entirely.
    await seedConcept("alpha", "Alpha");
    await seedEmbeddingStore(tmpDir, { model: "definitely-stale-model" });
    const result = await runCLI(["context", "alpha", "--json"], tmpDir);
    expectCLIExit(result, 0);
    // stdout must parse cleanly as a single JSON object — no stale-warning prefix.
    expect(result.stdout.trimStart().startsWith("{")).toBe(true);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(warningCodesOf(payload)).toContain("embedding-store-missing");
    // eslint-disable-next-line no-control-regex
    expect(result.stdout).not.toMatch(/\x1b\[/);
  });

  it("malformed .llmwiki/embeddings.json does not crash and still lexically ranks", async () => {
    // Regression: previously `readEmbeddingStore` propagated JSON.parse
    // failures, exit 1 with a stack trace. The wrapper must catch and
    // fall back to lexical with the documented warning.
    await seedConcept("alpha", "Alpha");
    await mkdir(path.join(tmpDir, LLMWIKI_DIR), { recursive: true });
    await writeFile(path.join(tmpDir, EMBEDDINGS_FILE), "{broken", "utf-8");
    const result = await runCLI(["context", "alpha", "--json"], tmpDir);
    expectCLIExit(result, 0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(warningCodesOf(payload)).toContain("embedding-store-missing");
    // Lexical signals still rank the seeded page.
    const top = firstPrimary(payload);
    expect(top.id).toBe("concepts/alpha");
  });
});

describe("`llmwiki context` — Slice 2 semantic success via aimock", () => {
  /** Register a canned embedding response on the aimock server. */
  function registerEmbedding(handle: MockClaudeHandle, vector: number[]): void {
    handle.mock.onEmbedding(/.*/, { embedding: vector });
  }

  it("attaches semantic-chunk reason and populated chunks[] when retrieval succeeds", async () => {
    // Use the per-aimock workspace so the fixture lifecycle owns cleanup
    // (independent of the file-level beforeEach/afterEach tmpDir).
    const handle = await aimock.start();
    const vector = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7];
    registerEmbedding(handle, vector);
    const cwd = await aimock.makeWorkspace("# placeholder\n", "placeholder.md");
    await mkdir(path.join(cwd, CONCEPTS_DIR), { recursive: true });
    await writeFile(
      path.join(cwd, CONCEPTS_DIR, "retrieval.md"),
      "---\ntitle: Retrieval\n---\n\nbody\n",
      "utf-8",
    );
    await seedEmbeddingStore(cwd, { vector });
    const result = await runCLI(
      ["context", "totally unrelated question", "--json", "--top-chunks", "2"],
      cwd,
      mockOpenAIEnv(handle),
    );
    expectCLIExit(result, 0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    const top = firstPrimary(payload);
    expect(top.id).toBe("concepts/retrieval");
    expect(top.reasons as string[]).toContain("semantic-chunk");
    const chunks = top.chunks as Array<Record<string, unknown>>;
    expect(chunks.length).toBe(1);
    expect(chunks[0].text).toBe("Seeded chunk body about retrieval.");
    expect(chunks[0].contentHash).toBe("seeded-hash");
    expect(typeof chunks[0].score).toBe("number");
    // No fallback warnings should fire when retrieval succeeded.
    const codes = warningCodesOf(payload);
    expect(codes).not.toContain("embedding-store-missing");
    expect(codes).not.toContain("query-embedding-unavailable");
  });
});

/**
 * Write a wiki page with one or more `[[Wikilink]]` body lines so the
 * viewer collector resolves outgoing edges (and ghost edges when the
 * target page does not exist). Kept local to the Slice 3 integration
 * tests so the per-test bodies stay focused on graph topology.
 */
async function seedLinkedConcept(
  slug: string,
  title: string,
  wikilinks: string[],
): Promise<void> {
  await mkdir(path.join(tmpDir, CONCEPTS_DIR), { recursive: true });
  const body = wikilinks.map((target) => `[[${target}]]`).join("\n\n");
  const content = `---\ntitle: ${title}\n---\n\n${body}\n`;
  await writeFile(path.join(tmpDir, CONCEPTS_DIR, `${slug}.md`), content, "utf-8");
}

describe("`llmwiki context` — Slice 3 graph neighborhood expansion (CLI)", () => {
  it("emits a depth-1 outgoing neighbor + skips ghost as gap on a small linked wiki", async () => {
    // Alpha (primary via exact-slug) -> Beta (real, neighbor)
    // Alpha -> MissingTopic (ghost -> gap)
    await seedLinkedConcept("alpha", "Alpha", ["Beta", "MissingTopic"]);
    await seedLinkedConcept("beta", "Beta", []);
    const payload = await runJsonContext("alpha");
    const neighbors = payload.neighbors as Array<Record<string, unknown>>;
    expect(neighbors).toHaveLength(1);
    expect(neighbors[0]).toMatchObject({
      from: "concepts/alpha",
      to: "concepts/beta",
      direction: "outgoing",
      distance: 1,
      reason: "wikilink",
    });
    const gaps = payload.gaps as Array<Record<string, unknown>>;
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({
      code: "dangling-link",
      pageId: "concepts/alpha",
    });
  });

  it("--no-neighbors suppresses graph expansion while keeping neighbors[]/gaps[] present", async () => {
    await seedLinkedConcept("alpha", "Alpha", ["Beta", "MissingTopic"]);
    await seedLinkedConcept("beta", "Beta", []);
    const payload = await runJsonContext("alpha", ["--no-neighbors"]);
    expect(payload.neighbors).toEqual([]);
    expect(payload.gaps).toEqual([]);
  });

  it("--depth 0 suppresses neighbors AND gaps but keeps the keys present", async () => {
    await seedLinkedConcept("alpha", "Alpha", ["Beta", "MissingTopic"]);
    await seedLinkedConcept("beta", "Beta", []);
    const payload = await runJsonContext("alpha", ["--depth", "0"]);
    expect(payload.neighbors).toEqual([]);
    expect(payload.gaps).toEqual([]);
  });

  it("--depth 2 reaches a second-hop neighbor at distance 2 via a bridge", async () => {
    // Alpha (primary) -> Beta -> Gamma
    await seedLinkedConcept("alpha", "Alpha", ["Beta"]);
    await seedLinkedConcept("beta", "Beta", ["Gamma"]);
    await seedLinkedConcept("gamma", "Gamma", []);
    const payload = await runJsonContext("alpha", ["--depth", "2"]);
    const neighbors = payload.neighbors as Array<Record<string, unknown>>;
    const distances = new Map(neighbors.map((n) => [n.to as string, n.distance as number]));
    expect(distances.get("concepts/beta")).toBe(1);
    expect(distances.get("concepts/gamma")).toBe(2);
    const gamma = neighbors.find((n) => n.to === "concepts/gamma");
    expect(gamma?.from).toBe("concepts/beta");
  });

  it("markdown output includes a `## Graph Neighborhood` section with rendered edges", async () => {
    await seedLinkedConcept("alpha", "Alpha", ["Beta"]);
    await seedLinkedConcept("beta", "Beta", []);
    const result = await runCLI(["context", "alpha"], tmpDir);
    expectCLIExit(result, 0);
    expect(result.stdout).toContain("## Graph Neighborhood");
    expect(result.stdout).toContain("`concepts/alpha`");
    expect(result.stdout).toContain("`concepts/beta`");
    expect(result.stdout).toContain("(wikilink, distance 1)");
  });

  it("annotates connected primary pages with `graph-neighbor` as an additive reason", async () => {
    // Seed two pages that BOTH match the prompt "alpha beta" lexically
    // (so both land in primary[]) and are wired together by a
    // wikilink. The graph-neighbor reason is the only thing that
    // distinguishes this from the plain ranking path.
    await seedLinkedConcept("alpha", "Alpha Beta", ["Alpha Beta Two"]);
    await seedLinkedConcept("alpha-beta-two", "Alpha Beta Two", []);
    const payload = await runJsonContext("alpha beta");
    const primary = payload.primary as Array<{ id: string; reasons: string[] }>;
    expect(primary.length).toBe(2);
    // Every entry MUST gain `graph-neighbor` AND keep a non-graph
    // signal so the additive-only contract is visible at the CLI surface.
    expect(primary.every((p) => p.reasons.includes("graph-neighbor"))).toBe(true);
    expect(
      primary.every((p) => p.reasons.some((r) => r !== "graph-neighbor")),
    ).toBe(true);
  });

  it("does not promote a graph-only page into primary[]", async () => {
    // Alpha matches the prompt; Beta is reachable via wikilink but
    // never matches the prompt itself. Beta must stay out of primary.
    await seedLinkedConcept("alpha", "Alpha", ["Beta"]);
    await seedLinkedConcept("beta", "Beta", []);
    const payload = await runJsonContext("alpha");
    const primaryIds = (payload.primary as Array<{ id: string }>).map((p) => p.id);
    expect(primaryIds).toContain("concepts/alpha");
    expect(primaryIds).not.toContain("concepts/beta");
  });

  it("--no-neighbors and --depth 0 both suppress the graph-neighbor annotation", async () => {
    await seedLinkedConcept("alpha", "Alpha Beta", ["Alpha Beta Two"]);
    await seedLinkedConcept("alpha-beta-two", "Alpha Beta Two", []);
    for (const args of [["--no-neighbors"], ["--depth", "0"]]) {
      const payload = await runJsonContext("alpha beta", args);
      const primary = payload.primary as Array<{ reasons: string[] }>;
      expect(primary.length).toBe(2);
      for (const entry of primary) {
        expect(entry.reasons).not.toContain("graph-neighbor");
      }
    }
  });
});

describe("`llmwiki context --json --budget 1` — deterministic budget trimming", () => {
  /** Run `context --json --budget 1` and return the parsed `budget` block. */
  async function runTinyBudget(prompt: string): Promise<Record<string, unknown>> {
    const result = await runCLI(["context", prompt, "--json", "--budget", "1"], tmpDir);
    expectCLIExit(result, 0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    return payload.budget as Record<string, unknown>;
  }

  it("exits 0, parses as JSON, sets truncated=true and non-empty trimmedSections", async () => {
    await seedConcept("alpha", "Alpha", "Some prose body so the pack is well over a single token.");
    const budget = await runTinyBudget("alpha");
    expect(budget.truncated).toBe(true);
    expect(Array.isArray(budget.trimmedSections)).toBe(true);
    expect((budget.trimmedSections as string[]).length).toBeGreaterThan(0);
    // trimmedSections must only contain documented section keys.
    const allowed = new Set(["neighbors", "sourceWindows", "chunks", "primary"]);
    for (const section of budget.trimmedSections as string[]) expect(allowed.has(section)).toBe(true);
  });

  it("empty wiki + --budget 1 still marks the envelope truncated with an empty trimmedSections", async () => {
    // No seeded pages — the envelope itself (metadata + suggestedActions)
    // is well over 1 token but the trimmer has nothing to drop. The
    // CLI must still emit valid JSON and signal truncated=true so a
    // consuming agent can tell the budget was overshot.
    const budget = await runTinyBudget("anything");
    expect(budget.truncated).toBe(true);
    expect(budget.trimmedSections).toEqual([]);
    expect(budget.estimatedTokens as number).toBeGreaterThan(1);
  });
});
