/**
 * @file test/storage/compile-tail.test.ts
 * @description FIXED outcomes for the two calls a direct compile still made
 * inline and now makes through `src/storage/`: the listing that snapshots
 * which pages exist before a compile, and the append to the activity log.
 *
 * The listing has no export of its own, so it is exercised through the real
 * `compileAndReport` with the provider stubbed, and observed where it shows:
 * the `Created` and `Updated` lines of the compile's log entry. What the cases
 * pin is that a first compile with no page directories is not an error, that
 * only a `.md` page in the CONCEPTS directory counts as already existing, and
 * that a query page with the same slug does not.
 *
 * The append is exercised through the real `appendLog` with a fixed date, so
 * the exact bytes are compared, blank line included, and through the storage
 * function for the errors `appendLog` deliberately swallows.
 */

import { describe, expect, it, vi } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { useCompileProject } from "../fixtures/compile-project.js";
import { compileAndReport } from "../../src/compiler/index.js";
import { AnthropicProvider } from "../../src/providers/anthropic.js";
import { appendLocationText } from "../../src/storage/disk-locations.js";
import { appendLog } from "../../src/utils/activity-log.js";

const FIXED_DATE = new Date("2026-01-02T03:04:05.678Z");
const FIXED_ENTRY = "## [2026-01-02T03:04:05Z] compile | 1 source(s) → 1 page(s)\n- Sources: a.md\n- Created: [[alpha]]\n\n";
const PAGE = "---\ntitle: Sample Topic\nsummary: Already here.\n---\n\nAn earlier body.\n";

/** What the stubbed provider answers: one concept, and one page body citing the seeded source. */
const CANNED = {
  toolCall: JSON.stringify({ concepts: [{ concept: "Sample Topic", summary: "S.", is_new: true }] }),
  complete: "The sample topic is described here. ^[sample.md]",
} as const;

/** Stub the two model calls so a compile produces the one page `sample-topic`. */
function stubProvider(): void {
  for (const call of ["toolCall", "complete"] as const) {
    vi.spyOn(AnthropicProvider.prototype, call).mockImplementation(async () => CANNED[call]);
  }
}

/** The detail lines of the compile entry a run appended to the log. */
async function compileEntryDetails(root: string): Promise<string[]> {
  const log = await readFile(path.join(root, "log.md"), "utf-8");
  return log.split("\n").filter((line) => line.startsWith("- Created:") || line.startsWith("- Updated:"));
}

describe("the page snapshot taken before a compile", () => {
  const project = useCompileProject({ dirSuffix: "compile-tail" });

  /** Seed one file under the project, run the real compile, and return the entry's Created and Updated lines. */
  async function compileWith(seed?: { relative: string; content: string }): Promise<string[]> {
    stubProvider();
    await rm(path.join(project.dir, "wiki"), { recursive: true, force: true });
    if (seed) {
      await mkdir(path.dirname(path.join(project.dir, seed.relative)), { recursive: true });
      await writeFile(path.join(project.dir, seed.relative), seed.content);
    }
    await compileAndReport(project.dir);
    return compileEntryDetails(project.dir);
  }

  it("treats a first compile with no page directories as nothing existing", async () => {
    expect(await compileWith()).toEqual(["- Created: [[sample-topic]]"]);
  }, 30_000);

  it("counts a concept page of the same slug as existing", async () => {
    expect(await compileWith({ relative: "wiki/concepts/sample-topic.md", content: PAGE })).toEqual(["- Updated: [[sample-topic]]"]);
  }, 30_000);

  it("does not count a QUERY page of the same slug as an existing concept", async () => {
    expect(await compileWith({ relative: "wiki/queries/sample-topic.md", content: PAGE })).toEqual(["- Created: [[sample-topic]]"]);
  }, 30_000);

  it("does not count a concepts entry that is not a .md page", async () => {
    expect(await compileWith({ relative: "wiki/concepts/sample-topic.txt", content: "not a page" })).toEqual(["- Created: [[sample-topic]]"]);
  }, 30_000);
});

describe("the activity log append", () => {
  /** Run `work` in a fresh directory, removing it afterwards. */
  async function inTempRoot<T>(work: (root: string) => Promise<T>): Promise<T> {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "llmwiki-compile-tail-")));
    try {
      return await work(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
  const fixedAppend = (root: string): Promise<void> =>
    appendLog(root, "compile", "1 source(s) → 1 page(s)", { date: FIXED_DATE, details: ["Sources: a.md", "Created: [[alpha]]"] });

  it("creates a missing log with exactly the entry and its blank line", () => inTempRoot(async (root) => {
    await fixedAppend(root);
    expect(await readFile(path.join(root, "log.md"), "utf-8")).toBe(FIXED_ENTRY);
  }));

  it("adds to an existing log and leaves what was there untouched", () => inTempRoot(async (root) => {
    await writeFile(path.join(root, "log.md"), "earlier, with no final newline");
    await fixedAppend(root);
    await fixedAppend(root);
    expect(await readFile(path.join(root, "log.md"), "utf-8")).toBe(`earlier, with no final newline${FIXED_ENTRY}${FIXED_ENTRY}`);
  }));

  it("follows a link at the log's location and writes through it", () => inTempRoot(async (root) => {
    await writeFile(path.join(root, "elsewhere.md"), "");
    await symlink(path.join(root, "elsewhere.md"), path.join(root, "log.md"));
    await fixedAppend(root);
    expect(await readFile(path.join(root, "elsewhere.md"), "utf-8")).toBe(FIXED_ENTRY);
  }));

  it("warns and does not throw when the log cannot be written", () => inTempRoot(async (root) => {
    await mkdir(path.join(root, "log.md"));
    const printed: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((line: unknown) => { printed.push(String(line)); });
    try {
      await expect(fixedAppend(root)).resolves.toBeUndefined();
    } finally {
      log.mockRestore();
    }
    expect(printed.join("\n")).toContain("Skipped log.md update: EISDIR");
  }));

  it("rejects with the raw error from the storage function, which swallows nothing", () => inTempRoot(async (root) => {
    await mkdir(path.join(root, "a-directory"));
    await expect(appendLocationText(path.join(root, "a-directory"), "x")).rejects.toMatchObject({ code: "EISDIR" });
    await expect(appendLocationText(path.join(root, "missing-parent", "log.md"), "x")).rejects.toMatchObject({ code: "ENOENT" });
  }));
});
