/**
 * Slice 4 subprocess integration tests for `llmwiki context`.
 *
 * Pins the end-to-end shape of `primary[].citations`,
 * `primary[].warnings`, `project.pendingCandidates`, `project.lint`,
 * and the optional `--include-sources` source windows + traversal
 * rejection. Sibling file to `context-integration.test.ts` so the
 * provenance surface is reviewable in isolation and neither file
 * exceeds the 400-line ceiling.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, symlink } from "fs/promises";
import os from "os";
import path from "path";
import { runCLI, expectCLIExit } from "./fixtures/run-cli.js";
import { runContextJson, withSecretRoot } from "./fixtures/context-cli-helpers.js";
import {
  CONCEPTS_DIR,
  LLMWIKI_DIR,
  LAST_LINT_FILE,
  CANDIDATES_DIR,
  SOURCES_DIR,
} from "../src/utils/constants.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "context-prov-cli-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

/** Seed a concept page whose body carries one claim-level citation. */
async function seedCitedConcept(slug: string, title: string, citation: string): Promise<void> {
  await mkdir(path.join(tmpDir, CONCEPTS_DIR), { recursive: true });
  const body = `Some prose. ^[${citation}]`;
  const content = `---\ntitle: ${title}\n---\n\n${body}\n`;
  await writeFile(path.join(tmpDir, CONCEPTS_DIR, `${slug}.md`), content, "utf-8");
}

/** Drop a source file under sources/ with the given lines. */
async function seedSource(file: string, lines: string[]): Promise<void> {
  const target = path.join(tmpDir, SOURCES_DIR, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, lines.join("\n"), "utf-8");
}

/** Seed a lint cache so `project.lint` is populated. */
async function seedLintCache(errors: number, warnings: number): Promise<void> {
  await mkdir(path.join(tmpDir, LLMWIKI_DIR), { recursive: true });
  const entry = { warnings, errors, at: new Date().toISOString() };
  await writeFile(path.join(tmpDir, LAST_LINT_FILE), JSON.stringify(entry), "utf-8");
}

/** Seed one pending candidate JSON file. */
async function seedCandidate(id: string): Promise<void> {
  await mkdir(path.join(tmpDir, CANDIDATES_DIR), { recursive: true });
  const body = {
    id,
    title: "Pending",
    slug: id,
    summary: "stub",
    sources: ["x.md"],
    body: "stub body",
    generatedAt: new Date().toISOString(),
  };
  await writeFile(path.join(tmpDir, CANDIDATES_DIR, `${id}.json`), JSON.stringify(body), "utf-8");
}

/** Local wrapper that forwards to the shared helper with this file's tmpDir. */
async function runJsonContext(
  prompt: string,
  extra: string[] = [],
): Promise<Record<string, unknown>> {
  return runContextJson(tmpDir, prompt, extra);
}

describe("`llmwiki context --json` — primary[].citations", () => {
  it("flattens a claim-level citation into a (file,start,end) object", async () => {
    await seedCitedConcept("alpha", "Alpha", "paper.md:42-58");
    const payload = await runJsonContext("alpha");
    const primary = payload.primary as Array<Record<string, unknown>>;
    expect(primary[0].citations).toEqual([{ file: "paper.md", start: 42, end: 58 }]);
  });

  it("emits paragraph-only citations without start/end", async () => {
    await seedCitedConcept("beta", "Beta", "note.md");
    const payload = await runJsonContext("beta");
    const primary = payload.primary as Array<Record<string, unknown>>;
    expect(primary[0].citations).toEqual([{ file: "note.md" }]);
  });

  it("splits multi-source markers into one citation object per span", async () => {
    await seedCitedConcept("multi", "Multi", "a.md, b.md");
    const payload = await runJsonContext("multi");
    const primary = payload.primary as Array<Record<string, unknown>>;
    expect(primary[0].citations).toEqual([{ file: "a.md" }, { file: "b.md" }]);
  });
});

describe("`llmwiki context --json` — project visibility", () => {
  it("surfaces project.pendingCandidates from countCandidates()", async () => {
    await seedCandidate("pending-aabbccdd");
    const payload = await runJsonContext("anything");
    const project = payload.project as Record<string, unknown>;
    expect(project.pendingCandidates).toBe(1);
  });

  it("emits project.lint with the cached counts when the cache exists", async () => {
    await seedLintCache(3, 1);
    const payload = await runJsonContext("anything");
    const project = payload.project as Record<string, unknown>;
    expect(project.lint).toEqual({ warnings: 1, errors: 3, at: expect.any(String) });
  });

  it("emits project.lint as null when no lint cache exists", async () => {
    const payload = await runJsonContext("anything");
    const project = payload.project as Record<string, unknown>;
    expect(project.lint).toBeNull();
  });
});

describe("`llmwiki context --json --include-sources`", () => {
  it("materializes a source window for a claim-level citation", async () => {
    await seedCitedConcept("alpha", "Alpha", "paper.md:2-4");
    await seedSource("paper.md", ["one", "two", "three", "four", "five"]);
    const payload = await runJsonContext("alpha", ["--include-sources"]);
    const primary = payload.primary as Array<Record<string, unknown>>;
    expect(primary[0].sourceWindows).toEqual([
      { file: "paper.md", start: 2, end: 4, text: "two\nthree\nfour" },
    ]);
  });

  it("does not materialize windows for paragraph-only citations", async () => {
    await seedCitedConcept("beta", "Beta", "note.md");
    await seedSource("note.md", ["only one line"]);
    const payload = await runJsonContext("beta", ["--include-sources"]);
    const primary = payload.primary as Array<Record<string, unknown>>;
    expect(primary[0].sourceWindows).toEqual([]);
  });

  it("rejects traversal even when wikilinks would otherwise resolve the file", async () => {
    await seedCitedConcept("gamma", "Gamma", "../escape.md:1-1");
    await withSecretRoot("context-escape", async (secretRoot) => {
      await writeFile(path.join(secretRoot, "escape.md"), "leaked", "utf-8");
      const relative = path.relative(path.join(tmpDir, SOURCES_DIR), path.join(secretRoot, "escape.md"));
      await seedCitedConcept("gamma", "Gamma", `${relative}:1-1`);
      const payload = await runJsonContext("gamma", ["--include-sources"]);
      const primary = payload.primary as Array<Record<string, unknown>>;
      expect(primary[0].sourceWindows).toEqual([]);
    });
  });

  it("rejects symlinks that escape sources/ even when the rel path looks safe", async () => {
    await seedCitedConcept("delta", "Delta", "link.md:1-1");
    await withSecretRoot("context-escape", async (secretRoot) => {
      const target = path.join(secretRoot, "real.md");
      await writeFile(target, "leaked", "utf-8");
      await mkdir(path.join(tmpDir, SOURCES_DIR), { recursive: true });
      await symlink(target, path.join(tmpDir, SOURCES_DIR, "link.md"));
      const payload = await runJsonContext("delta", ["--include-sources"]);
      const primary = payload.primary as Array<Record<string, unknown>>;
      expect(primary[0].sourceWindows).toEqual([]);
    });
  });

  it("leaves sourceWindows empty when --include-sources is not passed", async () => {
    await seedCitedConcept("alpha", "Alpha", "paper.md:2-4");
    await seedSource("paper.md", ["one", "two", "three", "four", "five"]);
    const payload = await runJsonContext("alpha");
    const primary = payload.primary as Array<Record<string, unknown>>;
    expect(primary[0].sourceWindows).toEqual([]);
  });
});

describe("`llmwiki context` — markdown surfaces citations and source windows", () => {
  it("renders a Sources line when citations are present", async () => {
    await seedCitedConcept("alpha", "Alpha", "paper.md:42-58");
    const result = await runCLI(["context", "alpha"], tmpDir);
    expectCLIExit(result, 0);
    expect(result.stdout).toContain("Sources: `paper.md:42-58`");
  });

  it("renders a From-block per source window under --include-sources", async () => {
    await seedCitedConcept("alpha", "Alpha", "paper.md:2-3");
    await seedSource("paper.md", ["one", "two", "three"]);
    const result = await runCLI(["context", "alpha", "--include-sources"], tmpDir);
    expectCLIExit(result, 0);
    expect(result.stdout).toContain("From `paper.md:2-3`");
    expect(result.stdout).toContain("> two");
    expect(result.stdout).toContain("> three");
  });
});
