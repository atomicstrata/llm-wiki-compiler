/**
 * Unit tests for the project-state collector and recommendation rules.
 *
 * Pins the seven primary states, the per-state `otherActions` table,
 * the three-state lint-cache contract (missing / unparseable /
 * populated), and the broken-project recommendation shape.
 *
 * Each test owns its temporary root so failures don't bleed between
 * cases. The collector must not create `.llmwiki/` or any other state
 * in any test directory.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { collectProjectState } from "../src/project/state.js";
import { recommendNextAction } from "../src/project/recommendations.js";
import { writeLintCache } from "../src/linter/cache.js";
import {
  SOURCES_DIR,
  CONCEPTS_DIR,
  QUERIES_DIR,
  LLMWIKI_DIR,
  LAST_LINT_FILE,
  CANDIDATES_DIR,
  INDEX_FILE,
} from "../src/utils/constants.js";
import { expectFreshDirUnchanged } from "./fixtures/project-state-helpers.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "project-state-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

/** Write an empty `.md` file under `dir` and ensure parents exist. */
async function touchMarkdown(dir: string, name: string, body = "# stub"): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, name), body, "utf-8");
}

/** Write a candidate JSON file directly so we don't depend on the compile pipeline. */
async function seedCandidate(root: string, id: string): Promise<void> {
  const dir = path.join(root, CANDIDATES_DIR);
  await mkdir(dir, { recursive: true });
  const body = {
    id,
    title: "Stub",
    slug: id,
    summary: "stub",
    sources: ["x.md"],
    body: "stub",
    generatedAt: new Date().toISOString(),
  };
  await writeFile(path.join(dir, `${id}.json`), JSON.stringify(body), "utf-8");
}

/** Collect state and return just the otherActions `executable.args` lists. */
async function otherActionArgs(root: string): Promise<(string[] | undefined)[]> {
  const state = await collectProjectState(root);
  return recommendNextAction(state).otherActions.map((a) => a.executable?.args);
}

describe("collectProjectState — primary state classification", () => {
  it("fresh empty directory classifies as `fresh` with no warnings", async () => {
    const state = await collectProjectState(tmpDir);
    const rec = recommendNextAction(state);
    expect(rec.state).toBe("fresh");
    expect(state.warnings).toEqual([]);
  });

  it("sources/ with no wiki pages classifies as `sources-only`", async () => {
    await touchMarkdown(path.join(tmpDir, SOURCES_DIR), "a.md");
    const state = await collectProjectState(tmpDir);
    expect(recommendNextAction(state).state).toBe("sources-only");
  });

  it("pending candidate outranks lint errors (review-pending precedence)", async () => {
    await touchMarkdown(path.join(tmpDir, CONCEPTS_DIR), "a.md");
    await writeLintCache(tmpDir, { warnings: 0, errors: 3, info: 0, results: [] });
    await seedCandidate(tmpDir, "candidate-aabbccdd");
    const state = await collectProjectState(tmpDir);
    expect(recommendNextAction(state).state).toBe("review-pending");
  });

  it("lint cache with errors classifies as `lint-attention`", async () => {
    await touchMarkdown(path.join(tmpDir, CONCEPTS_DIR), "a.md");
    await writeLintCache(tmpDir, { warnings: 1, errors: 2, info: 0, results: [] });
    const state = await collectProjectState(tmpDir);
    expect(recommendNextAction(state).state).toBe("lint-attention");
  });

  it("wiki pages without urgent state classify as `wiki-ready`", async () => {
    await touchMarkdown(path.join(tmpDir, CONCEPTS_DIR), "a.md");
    await touchMarkdown(path.join(tmpDir, CONCEPTS_DIR), "b.md");
    const state = await collectProjectState(tmpDir);
    expect(recommendNextAction(state).state).toBe("wiki-ready");
  });

  it("wiki/ directory with zero pages classifies as `empty-wiki`", async () => {
    await mkdir(path.join(tmpDir, "wiki"), { recursive: true });
    const state = await collectProjectState(tmpDir);
    expect(recommendNextAction(state).state).toBe("empty-wiki");
  });

  it("empty sources/ dir with no wiki classifies as `fresh`, not empty-wiki", async () => {
    await mkdir(path.join(tmpDir, SOURCES_DIR), { recursive: true });
    const state = await collectProjectState(tmpDir);
    expect(recommendNextAction(state).state).toBe("fresh");
  });

  it("`.llmwiki/` only with no candidates or lint errors classifies as `fresh`", async () => {
    await mkdir(path.join(tmpDir, LLMWIKI_DIR), { recursive: true });
    const state = await collectProjectState(tmpDir);
    expect(recommendNextAction(state).state).toBe("fresh");
  });

  it("unreadable root classifies as `broken-project`", async () => {
    const missing = path.join(tmpDir, "does-not-exist");
    const state = await collectProjectState(missing);
    const rec = recommendNextAction(state);
    expect(rec.state).toBe("broken-project");
    expect(state.warnings.map((w) => w.code)).toContain("project-unreadable");
  });
});

describe("collectProjectState — lint cache three-state contract", () => {
  it("missing cache reports present=false and entry=null", async () => {
    const state = await collectProjectState(tmpDir);
    expect(state.lint.present).toBe(false);
    expect(state.lint.entry).toBeNull();
    expect(state.warnings.some((w) => w.code === "lint-cache-unparseable")).toBe(false);
  });

  it("unparseable cache reports present=true, entry=null, and emits lint-cache-unparseable warning", async () => {
    await mkdir(path.join(tmpDir, LLMWIKI_DIR), { recursive: true });
    await writeFile(path.join(tmpDir, LAST_LINT_FILE), "{ not valid json", "utf-8");
    const state = await collectProjectState(tmpDir);
    expect(state.lint.present).toBe(true);
    expect(state.lint.entry).toBeNull();
    expect(state.warnings.some((w) => w.code === "lint-cache-unparseable")).toBe(true);
  });

  it("populated cache reports present=true and entry with the cache fields", async () => {
    await writeLintCache(tmpDir, { warnings: 4, errors: 1, info: 0, results: [] });
    const state = await collectProjectState(tmpDir);
    expect(state.lint.present).toBe(true);
    expect(state.lint.entry).toEqual(
      expect.objectContaining({ warnings: 4, errors: 1, at: expect.any(String) }),
    );
  });
});

describe("collectProjectState — never mutates the project root", () => {
  it("does not create .llmwiki/ in a fresh directory", async () => {
    await collectProjectState(tmpDir);
    await expectFreshDirUnchanged(tmpDir);
  });
});

describe("collectProjectState — structural warnings", () => {
  it("emits index-missing when pages exist but wiki/index.md does not", async () => {
    await touchMarkdown(path.join(tmpDir, CONCEPTS_DIR), "a.md");
    const state = await collectProjectState(tmpDir);
    expect(state.warnings.map((w) => w.code)).toContain("index-missing");
  });

  it("does not emit index-missing when wiki/index.md exists", async () => {
    await touchMarkdown(path.join(tmpDir, CONCEPTS_DIR), "a.md");
    await touchMarkdown(path.dirname(path.join(tmpDir, INDEX_FILE)), path.basename(INDEX_FILE));
    const state = await collectProjectState(tmpDir);
    expect(state.warnings.some((w) => w.code === "index-missing")).toBe(false);
  });

  it("emits sources-not-compiled when sources exist but no wiki pages do", async () => {
    await touchMarkdown(path.join(tmpDir, SOURCES_DIR), "a.md");
    const state = await collectProjectState(tmpDir);
    expect(state.warnings.map((w) => w.code)).toContain("sources-not-compiled");
  });

  it("counts both concepts and queries toward wiki-ready classification", async () => {
    await touchMarkdown(path.join(tmpDir, QUERIES_DIR), "q.md");
    const state = await collectProjectState(tmpDir);
    expect(state.conceptCount).toBe(0);
    expect(state.queryCount).toBe(1);
    expect(recommendNextAction(state).state).toBe("wiki-ready");
  });
});

describe("recommendNextAction — broken-project recommendation shape", () => {
  it("returns command:null and executable:null for broken-project", async () => {
    const state = await collectProjectState(path.join(tmpDir, "missing"));
    const rec = recommendNextAction(state);
    expect(rec.recommended.command).toBeNull();
    expect(rec.recommended.executable).toBeNull();
    expect(rec.otherActions).toEqual([]);
  });
});

describe("recommendNextAction — per-state otherActions table", () => {
  it("fresh -> ingest, quickstart", async () => {
    expect(await otherActionArgs(tmpDir)).toEqual([["ingest"], ["quickstart"]]);
  });

  it("sources-only -> compile, quickstart", async () => {
    await touchMarkdown(path.join(tmpDir, SOURCES_DIR), "a.md");
    expect(await otherActionArgs(tmpDir)).toEqual([["compile"], ["quickstart"]]);
  });

  it("empty-wiki -> compile, ingest", async () => {
    await mkdir(path.join(tmpDir, "wiki"), { recursive: true });
    expect(await otherActionArgs(tmpDir)).toEqual([["compile"], ["ingest"]]);
  });

  it("review-pending -> review list, review approve", async () => {
    await touchMarkdown(path.join(tmpDir, CONCEPTS_DIR), "a.md");
    await seedCandidate(tmpDir, "candidate-aabbccdd");
    expect(await otherActionArgs(tmpDir)).toEqual([["review", "list"], ["review", "approve"]]);
  });

  it("lint-attention -> lint, view --open", async () => {
    await touchMarkdown(path.join(tmpDir, CONCEPTS_DIR), "a.md");
    await writeLintCache(tmpDir, { warnings: 0, errors: 1, info: 0, results: [] });
    expect(await otherActionArgs(tmpDir)).toEqual([["lint"], ["view", "--open"]]);
  });

  it("wiki-ready -> view --open, query", async () => {
    await touchMarkdown(path.join(tmpDir, CONCEPTS_DIR), "a.md");
    expect(await otherActionArgs(tmpDir)).toEqual([["view", "--open"], ["query"]]);
  });

  it("placeholder actions list slot names rather than literal angle brackets in args", async () => {
    const action = recommendNextAction(await collectProjectState(tmpDir)).recommended;
    expect(action.executable?.placeholders).toEqual(["source"]);
    expect(action.executable?.args).not.toContain("<source>");
  });
});
