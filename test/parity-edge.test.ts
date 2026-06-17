/**
 * @file test/parity-edge.test.ts
 * @description Frozen GOLDEN parity baseline for the low-level wiki collector
 * on EDGE inputs that the hand-picked default corpus does not exercise.
 *
 * The default parity baseline (`test/parity-default.test.ts`) proves the
 * read/export surfaces over a small, healthy ~8-page corpus. That leaves the
 * structural edge classes that historically break filesystem collectors —
 * 0-byte files, malformed YAML frontmatter, frontmatter-only (no body), CRLF
 * line endings, and large readdir directories — unproven. This file builds an
 * edge corpus, freezes `collectRawWikiPages` over it as its OWN goldens (under
 * `test/parity/__golden__/`, never touching the frozen default goldens), and
 * asserts the path-confinement contract directly. Future refactors of
 * `scanEntityDir`/`collectRawWikiPages` are therefore caught beyond the happy
 * path: any behavioral drift on these inputs fails byte-for-byte here.
 *
 * Confinement assertions are direct `expect` (not golden) because realpath
 * resolution of symlinks is platform-sensitive and the contract under test is
 * boolean (excluded / `invalid`), not a serialized shape.
 */

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, symlink, realpath } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { collectRawWikiPages, scanEntityDir, type RawWikiPage } from "../src/wiki/collect.js";
import { CONCEPTS_DIR, QUERIES_DIR } from "../src/utils/constants.js";
import { assertGolden } from "./parity/golden.js";

/** Number of files written into the bulk directory to exercise readdir order. */
const BULK_FILE_COUNT = 25;

let root = "";
/** Realpath of `root` — macOS resolves temp dirs through the /private symlink. */
let realRoot = "";

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "parity-edge-"));
  realRoot = await realpath(root);
  await buildEdgeCorpus(root);
});

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

/**
 * Materialize the edge corpus under `wiki/concepts/`: a 0-byte file, a file
 * with malformed YAML frontmatter, a file with valid frontmatter but no body,
 * a file with CRLF line endings, and a bulk directory of {@link BULK_FILE_COUNT}
 * files. The confinement symlinks are added by {@link addConfinementCases}.
 */
async function buildEdgeCorpus(target: string): Promise<void> {
  const concepts = path.join(target, CONCEPTS_DIR);
  await mkdir(concepts, { recursive: true });
  await mkdir(path.join(target, QUERIES_DIR), { recursive: true });
  await writeFile(path.join(concepts, "empty.md"), "");
  await writeFile(path.join(concepts, "malformed.md"), "---\ntitle: [unterminated\n---\n\n# Body\n");
  await writeFile(path.join(concepts, "no-body.md"), "---\ntitle: No Body\n---\n");
  await writeFile(path.join(concepts, "crlf.md"), "---\r\ntitle: CRLF\r\n---\r\n\r\n# CRLF\r\n\r\nLine one.\r\nLine two.\r\n");
  await writeBulkFiles(concepts);
}

/** Write {@link BULK_FILE_COUNT} numbered files to stress readdir/order handling. */
async function writeBulkFiles(dir: string): Promise<void> {
  for (let index = 0; index < BULK_FILE_COUNT; index += 1) {
    const stem = `bulk-${String(index).padStart(2, "0")}`;
    await writeFile(path.join(dir, `${stem}.md`), `---\ntitle: Bulk ${index}\n---\n\n# ${stem}\n`);
  }
}

/**
 * Deterministic total order over collected pages: readdir order is NOT stable
 * across platforms or runs, so sort by `pageDirectory` then `slug` to make the
 * snapshot run-stable. Returns a new array.
 */
function sortPages(pages: RawWikiPage[]): RawWikiPage[] {
  return [...pages].sort(
    (a, b) => a.pageDirectory.localeCompare(b.pageDirectory) || a.slug.localeCompare(b.slug),
  );
}

/**
 * Rewrite the absolute `filePath` of each page to a stable `<ROOT>`-relative
 * token so the snapshot does not embed the random temp dir. Both the lexical
 * and realpath spellings of `root` are stripped (macOS /private divergence).
 */
function stripRoots(pages: RawWikiPage[]): RawWikiPage[] {
  const variants = [...new Set([root, realRoot].filter(Boolean))].sort((a, b) => b.length - a.length);
  return pages.map((page) => {
    let filePath = page.filePath;
    for (const variant of variants) filePath = filePath.split(variant).join("<ROOT>");
    return { ...page, filePath };
  });
}

describe("collector edge-input golden", () => {
  it("freezes collectRawWikiPages over the edge corpus", async () => {
    const pages = await collectRawWikiPages(root);
    assertGolden("edge.collect", stripRoots(sortPages(pages)));
  });
});

/**
 * Add a symlinked `.md` file pointing OUTSIDE its directory, a symlinked
 * subdirectory, and (in a second isolated root) a symlinked entity directory.
 * Returns nothing; the symlinks live alongside the corpus under `root`.
 */
async function addConfinementCases(): Promise<{ outsideTarget: string }> {
  const concepts = path.join(root, CONCEPTS_DIR);
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), "parity-edge-outside-"));
  const outsideTarget = path.join(outsideDir, "leak.md");
  await writeFile(outsideTarget, "---\ntitle: Leak\n---\n\n# Leak\n");
  await symlink(outsideTarget, path.join(concepts, "leak.md"));
  await mkdir(path.join(outsideDir, "subdir"), { recursive: true });
  await writeFile(path.join(outsideDir, "subdir", "nested.md"), "---\ntitle: Nested\n---\n\n# Nested\n");
  await symlink(path.join(outsideDir, "subdir"), path.join(concepts, "linked-subdir"));
  return { outsideTarget };
}

describe("collector confinement contract", () => {
  let outsideRoot = "";

  // Add the confinement symlinks once for this describe so each test is
  // self-contained and order-independent (no test relies on a sibling having
  // created the symlinks first).
  beforeAll(async () => {
    await addConfinementCases();
  });

  afterAll(async () => {
    if (outsideRoot) await rm(outsideRoot, { recursive: true, force: true });
  });

  it("excludes a symlinked .md file whose target is outside its directory", async () => {
    const slugs = (await collectRawWikiPages(root)).map((p) => p.slug);
    expect(slugs).not.toContain("leak");
  });

  it("excludes a symlinked subdirectory (contributes no pages)", async () => {
    const slugs = (await collectRawWikiPages(root)).map((p) => p.slug);
    expect(slugs).not.toContain("nested");
    expect(slugs).not.toContain("linked-subdir");
  });

  it("flags a symlinked entity directory as dirStatus invalid", async () => {
    outsideRoot = await mkdtemp(path.join(os.tmpdir(), "parity-edge-symdir-"));
    const realQueriesTarget = await mkdtemp(path.join(os.tmpdir(), "parity-edge-qtarget-"));
    await mkdir(path.join(outsideRoot, "wiki"), { recursive: true });
    await symlink(realQueriesTarget, path.join(outsideRoot, QUERIES_DIR));
    const scan = await scanEntityDir(outsideRoot, QUERIES_DIR);
    expect(scan.dirStatus).toBe("invalid");
    expect(scan.scans).toEqual([]);
    await rm(realQueriesTarget, { recursive: true, force: true });
  });
});
