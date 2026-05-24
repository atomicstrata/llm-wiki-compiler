/**
 * Unit tests for Slice 4 provenance — citation flattening, page warnings,
 * and (optional) source-window materialization.
 *
 * Citation tests are pure (in-process) and pin the documented
 * transformation rule: per-span objects, file/start/end lift from
 * `span.lines`, paragraph-only omits, dedupe by `(file,start,end)`,
 * first-seen document order preserved. Source-window tests build a
 * real `sources/` tree on disk so the path-confinement guards exercise
 * `fs.realpath` against actual filesystem entries.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, symlink } from "fs/promises";
import os from "os";
import path from "path";
import { flattenCitations } from "../src/context/provenance.js";
import {
  createSourceWindowBudget,
  materializeSourceWindows,
  MAX_LINES_PER_WINDOW,
  MAX_SOURCE_WINDOWS,
} from "../src/context/provenance.js";
import type { ClaimCitation } from "../src/utils/types.js";
import { SOURCES_DIR } from "../src/utils/constants.js";

/** Builder for a one-span claim citation with an optional line range. */
function claim(file: string, lines?: { start: number; end: number }): ClaimCitation {
  const raw = lines ? `${file}:${lines.start}-${lines.end}` : file;
  return { raw, spans: [lines ? { file, lines } : { file }] };
}

describe("flattenCitations — claim shape transformation", () => {
  it("returns empty array when the page has no citations", () => {
    expect(flattenCitations([])).toEqual([]);
  });

  it("lifts span.lines into top-level start/end for claim-level spans", () => {
    expect(flattenCitations([claim("a.md", { start: 1, end: 3 })])).toEqual([
      { file: "a.md", start: 1, end: 3 },
    ]);
  });

  it("omits start/end for paragraph-only citations", () => {
    const flat = flattenCitations([claim("p.md")]);
    expect(flat).toEqual([{ file: "p.md" }]);
    expect(flat[0]).not.toHaveProperty("start");
    expect(flat[0]).not.toHaveProperty("end");
  });

  it("splits multi-source markers into one object per span", () => {
    const citations: ClaimCitation[] = [
      { raw: "a.md, b.md", spans: [{ file: "a.md" }, { file: "b.md" }] },
    ];
    expect(flattenCitations(citations)).toEqual([{ file: "a.md" }, { file: "b.md" }]);
  });

  it("dedupes by (file, start, end) across markers", () => {
    const range = { start: 1, end: 3 };
    expect(flattenCitations([claim("a.md", range), claim("a.md", range)])).toEqual([
      { file: "a.md", start: 1, end: 3 },
    ]);
  });

  it("treats paragraph-only and line-range entries on the same file as distinct", () => {
    expect(
      flattenCitations([claim("a.md"), claim("a.md", { start: 5, end: 7 })]),
    ).toEqual([{ file: "a.md" }, { file: "a.md", start: 5, end: 7 }]);
  });

  it("preserves first-seen document order across multiple markers", () => {
    const flat = flattenCitations([
      claim("z.md", { start: 1, end: 2 }),
      claim("a.md"),
      claim("m.md", { start: 9, end: 9 }),
    ]);
    expect(flat.map((c) => c.file)).toEqual(["z.md", "a.md", "m.md"]);
  });
});

let root: string;
let sourcesDir: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "context-prov-"));
  sourcesDir = path.join(root, SOURCES_DIR);
  await mkdir(sourcesDir, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Write a multi-line source file rooted under `sources/`. */
async function writeSource(file: string, lines: string[]): Promise<void> {
  const target = path.join(sourcesDir, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, lines.join("\n"), "utf-8");
}

describe("materializeSourceWindows — happy path", () => {
  it("reads the requested 1-indexed inclusive line range out of sources/", async () => {
    await writeSource("paper.md", ["one", "two", "three", "four", "five"]);
    const budget = createSourceWindowBudget();
    const windows = await materializeSourceWindows(
      root,
      [{ file: "paper.md", start: 2, end: 4 }],
      budget,
    );
    expect(windows).toEqual([
      { file: "paper.md", start: 2, end: 4, text: "two\nthree\nfour" },
    ]);
    expect(budget.remaining).toBe(MAX_SOURCE_WINDOWS - 1);
  });

  it("skips paragraph-only citations (no start/end)", async () => {
    await writeSource("p.md", ["only", "two", "lines"]);
    const windows = await materializeSourceWindows(
      root,
      [{ file: "p.md" }],
      createSourceWindowBudget(),
    );
    expect(windows).toEqual([]);
  });

  it("clamps absurd line ranges at MAX_LINES_PER_WINDOW", async () => {
    const big = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
    await writeSource("big.md", big);
    const windows = await materializeSourceWindows(
      root,
      [{ file: "big.md", start: 1, end: 100 }],
      createSourceWindowBudget(),
    );
    expect(windows.length).toBe(1);
    expect(windows[0].text.split("\n").length).toBe(MAX_LINES_PER_WINDOW);
  });

  it("stops emitting windows once the shared budget is exhausted", async () => {
    await writeSource("a.md", ["x"]);
    const budget = createSourceWindowBudget();
    budget.remaining = 1;
    const windows = await materializeSourceWindows(
      root,
      [
        { file: "a.md", start: 1, end: 1 },
        { file: "a.md", start: 1, end: 1 },
      ],
      budget,
    );
    expect(windows.length).toBe(1);
    expect(budget.remaining).toBe(0);
  });
});

describe("materializeSourceWindows — path confinement", () => {
  it("rejects absolute paths (does not read /etc/passwd-style targets)", async () => {
    const windows = await materializeSourceWindows(
      root,
      [{ file: "/etc/passwd", start: 1, end: 1 }],
      createSourceWindowBudget(),
    );
    expect(windows).toEqual([]);
  });

  it("rejects parent traversal segments (`../secret.md`)", async () => {
    const secretRoot = await mkdtemp(path.join(os.tmpdir(), "context-secret-"));
    try {
      const secretPath = path.join(secretRoot, "secret.md");
      await writeFile(secretPath, "leaked", "utf-8");
      const relative = path.relative(sourcesDir, secretPath);
      expect(relative.startsWith("..")).toBe(true);
      const windows = await materializeSourceWindows(
        root,
        [{ file: relative, start: 1, end: 1 }],
        createSourceWindowBudget(),
      );
      expect(windows).toEqual([]);
    } finally {
      await rm(secretRoot, { recursive: true, force: true });
    }
  });

  it("rejects symlinks that escape sources/ even when the rel path looks safe", async () => {
    const secretRoot = await mkdtemp(path.join(os.tmpdir(), "context-symlink-"));
    try {
      const target = path.join(secretRoot, "real.md");
      await writeFile(target, "leaked", "utf-8");
      // Symlink rooted INSIDE sources/, pointing OUTSIDE.
      await symlink(target, path.join(sourcesDir, "link.md"));
      const windows = await materializeSourceWindows(
        root,
        [{ file: "link.md", start: 1, end: 1 }],
        createSourceWindowBudget(),
      );
      expect(windows).toEqual([]);
    } finally {
      await rm(secretRoot, { recursive: true, force: true });
    }
  });

  it("returns empty when the file does not exist", async () => {
    const windows = await materializeSourceWindows(
      root,
      [{ file: "missing.md", start: 1, end: 5 }],
      createSourceWindowBudget(),
    );
    expect(windows).toEqual([]);
  });

  it("returns empty when sources/ itself does not exist", async () => {
    const noSources = await mkdtemp(path.join(os.tmpdir(), "context-nosources-"));
    try {
      const windows = await materializeSourceWindows(
        noSources,
        [{ file: "any.md", start: 1, end: 1 }],
        createSourceWindowBudget(),
      );
      expect(windows).toEqual([]);
    } finally {
      await rm(noSources, { recursive: true, force: true });
    }
  });
});
