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

/** Run `llmwiki context <prompt> [args...] --json`, assert exit 0, return parsed payload. */
async function runJsonContext(
  prompt: string,
  extra: string[] = [],
): Promise<Record<string, unknown>> {
  const result = await runCLI(["context", prompt, ...extra, "--json"], tmpDir);
  expectCLIExit(result, 0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
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
