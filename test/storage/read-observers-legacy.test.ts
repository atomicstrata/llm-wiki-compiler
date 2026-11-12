/**
 * @file test/storage/read-observers-legacy.test.ts
 * @description Three read-only observers through their ROOT functions, on real
 * files: journal health (`journalHealth`, `classifyJournalFile`, `loadBatch`),
 * the project-state collector (`collectProjectState`) and the context pack's
 * source windows (`materializeSourceWindows`). It states behaviours no other
 * test states, so that moving their disk reads behind consumer-owned sources
 * cannot change them. It is run byte for byte against the source both before
 * and after.
 *
 * What the cases pin:
 *  - a journal file that CARRIES ITS OWN `root` is judged by the project's real
 *    root, never by the one it carries, by the health read and by the per-file
 *    classifier alike, and `loadBatch` hands back the caller's root;
 *  - a journal directory that is a link INSIDE the project is read: the
 *    resolved directory is listed and each batch is read by the root as written;
 *  - a refused citation key costs exactly one disk call, the resolve of
 *    `sources/`, and `sources/` is resolved again for every cited window;
 *  - the collector looks at the root exactly as the caller spelled it, and a
 *    bad `sources` block in the project configuration REJECTS it (the one read
 *    it does not turn into a quiet default).
 *
 * "Exactly one call" cannot be seen on a real run, so `realpath`, `readFile`
 * and `stat` are recorded through ONE module mock of `fs/promises` that
 * forwards every call to the real filesystem and injects nothing. Setup uses
 * the real, unwrapped functions.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { tmpdir } from "node:os";
import path from "node:path";

type Recorded = "realpath" | "readFile" | "stat";
const calls = { seen: [] as string[] };

// Copy the real modules first: vi.mock patches them in place, so a later read would see the mock.
const realFsPromises = { ...(await import("node:fs/promises")) };

vi.mock("fs/promises", () => {
  const disk = realFsPromises;
  const recording = Object.fromEntries((["realpath", "readFile", "stat"] as Recorded[]).map((name) => [name, (...args: unknown[]): unknown => {
    calls.seen.push(`${name} ${String(args[0])}`);
    return (disk[name] as (...inner: unknown[]) => unknown)(...args);
  }]));
  return { ...disk, ...recording };
});

import { createSourceWindowBudget, materializeSourceWindows } from "../../src/context/provenance.js";
import { collectProjectState } from "../../src/project/state.js";
import { classifyJournalFile } from "../../src/trust/journal-classify.js";
import { journalHealth } from "../../src/trust/journal-health.js";
import { loadBatch } from "../../src/trust/journal.js";

const fs = realFsPromises;
let base = "";
let root = "";
const at = (relative: string): string => path.join(root, relative);
/** The recorded calls with the project root removed, so they read as project-relative. */
const recorded = (): string[] => calls.seen.map((entry) => entry.split(`${root}/`).join(""));

/** Write a file under the project, creating its directory. */
async function put(relative: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(at(relative)), { recursive: true });
  await fs.writeFile(at(relative), text);
}

/** A pending one-target batch file's text; `carried` adds a `root` property to the file itself. */
const pendingBatch = (batchId: string, targetPath: string, carried?: string): string =>
  JSON.stringify({ batchId, ...(carried === undefined ? {} : { root: carried }), status: "pending", entries: [{ targetPath, preState: { absent: true } }] });

beforeEach(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "read-observers-legacy-")));
  root = path.join(base, "project");
  await fs.mkdir(at("wiki/concepts"), { recursive: true });
  calls.seen = [];
});
afterEach(async () => { await fs.rm(base, { recursive: true, force: true }); });

describe("journal health, as it behaves today", () => {
  it("J1 judges a target outside the project unsafe although the file carries a root that would contain it", async () => {
    await put(".llmwiki/journal/wide.json", pendingBatch("wide", path.join(base, "outside.md"), "/"));
    expect(await classifyJournalFile(root, "wide")).toBe("unsafe");
    expect(await journalHealth(root)).toEqual({ status: "unavailable" });
    expect((await loadBatch(root, "wide"))?.root).toBe(root);
  });

  it("J2 judges a target inside the project revertable although the file carries an unrelated root", async () => {
    await put(".llmwiki/journal/elsewhere.json", pendingBatch("elsewhere", at("wiki/concepts/a.md"), path.join(base, "not-this-project")));
    expect(await classifyJournalFile(root, "elsewhere")).toBe("pending-revertable");
    expect(await journalHealth(root)).toEqual({ status: "pending" });
    expect((await loadBatch(root, "elsewhere"))?.root).toBe(root);
  });

  it("J3 reads a journal directory that is a link inside the project", async () => {
    await put(".llmwiki/real-journal/held.json", pendingBatch("held", at("wiki/concepts/a.md")));
    await fs.symlink(at(".llmwiki/real-journal"), at(".llmwiki/journal"));
    expect(await journalHealth(root)).toEqual({ status: "pending" });
    expect(await classifyJournalFile(root, "held")).toBe("pending-revertable");
  });
});

describe("source windows, as they behave today", () => {
  const windowsFor = (...files: string[]) =>
    materializeSourceWindows(root, files.map((file) => ({ file, start: 1, end: 1 })), createSourceWindowBudget());

  it.each(["", "/etc/passwd", "../outside.md", "nested/../paper.md"])("W1 a refused key %j costs exactly one call, the resolve of sources/", async (key) => {
    await put("sources/paper.md", "one\n");
    await put("outside.md", "outside\n");
    calls.seen = [];
    expect(await windowsFor(key)).toEqual([]);
    expect(recorded()).toEqual(["realpath sources"]);
  });

  it("W2 resolves sources/ again for every cited window", async () => {
    await put("sources/paper.md", "one\n");
    calls.seen = [];
    expect(await windowsFor("paper.md", "", "paper.md")).toEqual([
      { file: "paper.md", start: 1, end: 1, text: "one" }, { file: "paper.md", start: 1, end: 1, text: "one" },
    ]);
    expect(recorded()).toEqual([
      "realpath sources", "realpath sources/paper.md", "readFile sources/paper.md",
      "realpath sources",
      "realpath sources", "realpath sources/paper.md", "readFile sources/paper.md",
    ]);
  });
});

describe("the project-state collector, as it behaves today", () => {
  it("P1 looks at the root exactly as the caller spelled it, and reports that spelling", async () => {
    const spelled = `${root}${path.sep}`;
    const state = await collectProjectState(spelled);
    expect(state.root).toBe(spelled);
    expect(calls.seen[0]).toBe(`stat ${spelled}`);
    expect(state.hasWikiDir).toBe(true);
  });

  it("P2 rejects on a bad sources block in the project configuration", async () => {
    await put(".llmwiki/config.json", JSON.stringify({ version: 1, sources: { recursive: "yes" } }));
    await expect(collectProjectState(root)).rejects.toThrow("sources.recursive must be a boolean");
  });
});
