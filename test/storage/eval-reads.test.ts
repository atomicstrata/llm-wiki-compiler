/**
 * @file test/storage/eval-reads.test.ts
 * @description FIXED outcomes for the disk calls the deterministic (fast)
 * evaluation makes through `src/storage/`: the history append and its three
 * readers, the thresholds read, the source inventory's exclusion reason, and
 * the two canonicalisations of the evaluation's source resolver.
 *
 * What is pinned is what a caller can observe on real files: the bytes a
 * history line has, what a missing, torn or malformed file answers, which
 * failures reach the caller as the very error the disk raised, and, where the
 * code is sequential, the order of its calls. A fast run is also shown to make
 * no network request and to append exactly one line only when asked to record.
 *
 * Calls are observed through module mocks of `fs` and `fs/promises` that
 * forward to the real filesystem and can fail one chosen call or run a step
 * just before it. The storage files import the `node:` forms; the mocks
 * reaching them is part of what is shown.
 *
 * SCOPE. The inventory cases plant a regular file whose NAME holds `..`
 * between backslashes. That is a file name on POSIX and a path on Windows, so
 * those cases are skipped on `win32`. The "symlink" reason is reached here by
 * a CONSTRUCTED RACE (the file is swapped for a link just before the lookup):
 * an ordinary scan never hands a link to that code.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as disk from "fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** What the mocks recorded, and the one disturbance a test may arm. */
const seen = {
  log: [] as string[],
  failOn: null as { label: string; error: Error } | null,
  justBefore: null as { label: string; run: () => Promise<void> } | null,
};

// Copy the real modules first: vi.mock patches them in place, so a later read would see the mock.
const realFs = { ...(await import("fs")) };
const realFsPromises = { ...(await import("fs/promises")) };

vi.mock("fs", () => {
  const real = realFs;
  const existsSync = (target: unknown): boolean => {
    seen.log.push(`existsSync ${String(target)}`);
    return real.existsSync(target as string);
  };
  return { ...real, existsSync, default: { ...real, existsSync } };
});

vi.mock("fs/promises", async () => {
  const real = realFsPromises;
  const observed = ["mkdir", "appendFile", "readFile", "lstat", "realpath"] as const;
  const wrap = (name: (typeof observed)[number]) => async (...args: unknown[]): Promise<unknown> => {
    const label = `${name} ${String(args[0])}`;
    seen.log.push(`${label} ${JSON.stringify(args.slice(1))}`);
    if (seen.justBefore?.label === label) await seen.justBefore.run();
    if (seen.failOn?.label === label) throw seen.failOn.error;
    return (real[name] as (...rest: unknown[]) => Promise<unknown>)(...args);
  };
  return { ...real, ...Object.fromEntries(observed.map((name) => [name, wrap(name)])) };
});

import { appendHistory, loadHistory, loadLastFullReport, loadPreviousReport } from "../../src/eval/stats.js";
import { checkThresholds } from "../../src/eval/thresholds.js";
import { evaluateSourceUtilization } from "../../src/eval/source-utilization.js";
import { resolveSourceFile } from "../../src/eval/source-path.js";
import { runEval } from "../../src/eval/index.js";
import type { EvalReport } from "../../src/eval/types.js";

const HISTORY = ".llmwiki/eval/history.jsonl";
const THRESHOLDS = ".llmwiki/eval/thresholds.yaml";
let root = "";

/** Write every entry of `files` under the project, creating directories. */
async function write(files: Record<string, string>): Promise<void> {
  for (const [relative, text] of Object.entries(files)) {
    await disk.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await disk.writeFile(path.join(root, relative), text);
  }
}

/** The smallest report the history and threshold code reads fields from. */
function reportOf(suite: "fast" | "full", mark: string): EvalReport {
  return {
    suite, timestamp: mark, health: { score: 90 }, citationCoverage: { coveragePercent: 80, precisionPercent: 100 },
    sourceUtilization: { utilizationRate: 0.5, totalSources: 2, warnings: [] }, citationDepth: { claimLevelRate: 0.5 },
  } as unknown as EvalReport;
}

/** Recorded calls of the named kinds, in order, with the project root removed. */
function calls(...kinds: string[]): string[] {
  return seen.log.filter((entry) => kinds.includes(entry.split(" ")[0]!)).map((entry) => entry.split(`${root}/`).join(""));
}

/** An error no filesystem raises: seeing the same object again proves it was passed on. */
const planted = (): Error => Object.assign(new Error("planted disk failure"), { code: "EPLANTED" });

beforeEach(async () => {
  root = await disk.realpath(await disk.mkdtemp(path.join(tmpdir(), "eval-reads-")));
  Object.assign(seen, { log: [], failOn: null, justBefore: null });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await disk.rm(root, { recursive: true, force: true });
});

describe("appendHistory: make the directory, then add one line", () => {
  it("writes one JSON line per report and leaves earlier lines as they were", async () => {
    const first = reportOf("fast", "one"); const second = reportOf("full", "two");
    await appendHistory(root, first);
    const afterFirst = await disk.readFile(path.join(root, HISTORY), "utf8");
    expect(afterFirst).toBe(`${JSON.stringify(first)}\n`);
    await appendHistory(root, second);
    expect(await disk.readFile(path.join(root, HISTORY), "utf8")).toBe(`${afterFirst}${JSON.stringify(second)}\n`);
    expect(calls("mkdir", "appendFile").map((entry) => entry.split(" ").slice(0, 2).join(" "))).toEqual([
      "mkdir .llmwiki/eval", `appendFile ${HISTORY}`, "mkdir .llmwiki/eval", `appendFile ${HISTORY}`,
    ]);
    expect(calls("mkdir")[0]).toBe('mkdir .llmwiki/eval [{"recursive":true}]');
  });

  it("passes an append failure on untouched, after the directory was made", async () => {
    const error = planted();
    seen.failOn = { label: `appendFile ${path.join(root, HISTORY)}`, error };
    await expect(appendHistory(root, reportOf("fast", "one"))).rejects.toBe(error);
    expect((await disk.stat(path.join(root, ".llmwiki/eval"))).isDirectory()).toBe(true);
  });
});

describe("the history readers: ask whether it is there, then read it whole", () => {
  const lines = (...entries: string[]): string => `${entries.join("\n")}\n`;

  it("answers empty and null for no file, without attempting a read", async () => {
    expect(await loadHistory(root)).toEqual([]);
    expect(await loadPreviousReport(root)).toBeNull();
    expect(await loadLastFullReport(root)).toBeNull();
    expect(calls("existsSync")).toEqual(Array(3).fill(`existsSync ${HISTORY}`));
    expect(calls("readFile")).toEqual([]);
  });

  it("skips a malformed line, keeps order, and returns only the last n", async () => {
    const [a, b, c] = ["a", "b", "c"].map((mark) => JSON.stringify(reportOf("fast", mark)));
    await write({ [HISTORY]: lines(a!, "{ not json", b!, c!) });
    expect((await loadHistory(root)).map((entry) => entry.timestamp)).toEqual(["a", "b", "c"]);
    expect((await loadHistory(root, 2)).map((entry) => entry.timestamp)).toEqual(["b", "c"]);
    expect(calls("readFile")).toEqual(Array(2).fill(`readFile ${HISTORY} ["utf-8"]`));
  });

  it("treats a torn last line three ways: skipped, no previous report, earlier full run still found", async () => {
    const full = JSON.stringify(reportOf("full", "full-run")); const fast = JSON.stringify(reportOf("fast", "fast-run"));
    await write({ [HISTORY]: `${lines(full, fast)}${fast.slice(0, 20)}` });
    expect((await loadHistory(root)).map((entry) => entry.timestamp)).toEqual(["full-run", "fast-run"]);
    expect(await loadPreviousReport(root)).toBeNull();
    expect((await loadLastFullReport(root))?.timestamp).toBe("full-run");
  });

  it("rejects with the disk's own error when a directory is where the file should be", async () => {
    await disk.mkdir(path.join(root, HISTORY), { recursive: true });
    await expect(loadHistory(root)).rejects.toMatchObject({ code: "EISDIR" });
    await expect(loadPreviousReport(root)).rejects.toMatchObject({ code: "EISDIR" });
    await expect(loadLastFullReport(root)).rejects.toMatchObject({ code: "EISDIR" });
  });
});

describe("checkThresholds: an optional file, read whole when present", () => {
  const report = reportOf("fast", "now");

  it("finds no violation, and reads nothing, when there is no file", async () => {
    expect(await checkThresholds(report, root)).toEqual([]);
    expect(calls("existsSync", "readFile")).toEqual([`existsSync ${THRESHOLDS}`]);
  });

  it("reports the unmet threshold only, and nothing for an empty file", async () => {
    await write({ [THRESHOLDS]: "health_score: 80\nsource_utilization_rate: 1\n" });
    expect(await checkThresholds(report, root)).toEqual(["source_utilization_rate 50.0% is below threshold 100.0%"]);
    expect(calls("readFile")).toEqual([`readFile ${THRESHOLDS} ["utf-8"]`]);
    await write({ [THRESHOLDS]: "" });
    expect(await checkThresholds(report, root)).toEqual([]);
  });

  it("rejects with the parser's own error for malformed YAML, and the disk's for a directory", async () => {
    await write({ [THRESHOLDS]: "health_score: [unclosed\n" });
    await expect(checkThresholds(report, root)).rejects.toThrow(/YAML Parse error/);
    await disk.rm(path.join(root, THRESHOLDS));
    await disk.mkdir(path.join(root, THRESHOLDS));
    await expect(checkThresholds(report, root)).rejects.toMatchObject({ code: "EISDIR" });
  });
});

describe.skipIf(process.platform === "win32")("the source inventory's exclusion reason (POSIX file names)", () => {
  const REJECTED = "nested\\..\\escape.md";
  const lookup = (): string => `lstat ${path.join(root, "sources", REJECTED)}`;

  beforeEach(() => write({ "sources/kept.md": "# Kept\n", [`sources/${REJECTED}`]: "# Rejected by name\n" }));

  it("excludes a file the resolver rejects, after one lookup that follows no link", async () => {
    const result = await evaluateSourceUtilization(root);
    expect(result.warnings).toEqual([`${REJECTED}: could not be resolved (excluded)`]);
    expect(result.perSource.map((entry) => entry.sourceFile)).toEqual(["kept.md"]);
    expect(calls("lstat").filter((entry) => entry.includes(REJECTED))).toEqual([`lstat sources/${REJECTED} []`]);
  });

  it("gives the same reason when the lookup itself fails", async () => {
    seen.failOn = { label: lookup(), error: planted() };
    expect((await evaluateSourceUtilization(root)).warnings).toEqual([`${REJECTED}: could not be resolved (excluded)`]);
  });

  it("names a link only in a constructed race: the file becomes a link just before the lookup", async () => {
    const target = path.join(root, "sources", REJECTED);
    seen.justBefore = { label: lookup(), run: async () => { await disk.rm(target); await disk.symlink(path.join(root, "nowhere.md"), target); } };
    const result = await evaluateSourceUtilization(root);
    expect(result.warnings).toEqual([`${REJECTED}: symlink target missing or outside sources/ (excluded)`]);
  });
});

describe("resolveSourceFile: the directory is resolved first, then the file", () => {
  beforeEach(() => write({ "sources/inside.md": "# Inside\n", "outside.md": "# Outside\n" }));

  it("returns the resolved file, and null for a link that leaves sources/", async () => {
    const sources = path.join(root, "sources");
    expect(await resolveSourceFile(sources, "inside.md")).toBe(path.join(sources, "inside.md"));
    expect(calls("realpath")).toEqual(["realpath sources []", "realpath sources/inside.md []"]);
    await disk.symlink(path.join(root, "outside.md"), path.join(sources, "leak.md"));
    expect(await resolveSourceFile(sources, "leak.md")).toBeNull();
    expect(await resolveSourceFile(sources, "absent.md")).toBeNull();
  });

  it("answers null when the directory cannot be resolved, and never asks about the file", async () => {
    const sources = path.join(root, "sources");
    seen.failOn = { label: `realpath ${sources}`, error: planted() };
    expect(await resolveSourceFile(sources, "inside.md")).toBeNull();
    expect(calls("realpath")).toEqual(["realpath sources []"]);
  });
});

describe("a fast run: no request, and one history line only when recording", () => {
  it("records when asked, shows the same clock it stored, and leaves earlier lines alone", async () => {
    await write({ "wiki/concepts/page.md": '---\ntitle: "Page"\nsummary: "S."\n---\n\nA claim. ^[kept.md]\n', "sources/kept.md": "# Kept\n" });
    const fetched = vi.spyOn(globalThis, "fetch");
    await runEval(root, "fast", 20, false);
    expect(await loadHistory(root)).toEqual([]);
    const first = await runEval(root, "fast", 20, true);
    const afterFirst = await disk.readFile(path.join(root, HISTORY), "utf8");
    const second = await runEval(root, "fast", 20, true);
    const afterSecond = await disk.readFile(path.join(root, HISTORY), "utf8");
    expect(afterSecond.startsWith(afterFirst)).toBe(true);
    expect(afterSecond.slice(afterFirst.length)).toBe(`${JSON.stringify(second)}\n`);
    expect((await loadPreviousReport(root))?.timestamp).toBe(second.timestamp);
    expect(first.delta).toBeUndefined();
    expect(second.delta).toBeDefined();
    expect(fetched).not.toHaveBeenCalled();
  });
});
