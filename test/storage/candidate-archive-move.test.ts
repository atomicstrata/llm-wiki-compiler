/**
 * @file test/storage/candidate-archive-move.test.ts
 * @description `moveCandidateToArchive`, the move behind `rules reject`, through
 * the REAL function on real files in a temp project. Its one production caller
 * is `archiveRuleCandidate`; the concept review queue archives through the
 * custody move and never reaches it.
 *
 * The file states behaviour that moving the function's five disk calls behind
 * `src/storage/` must not change, so it is run byte for byte against the source
 * both before and after that move.
 *
 * One recorder wraps the existence check and the five promise calls under both
 * the bare and the `node:` module names. It passes every call through, notes a
 * call only while a move is running, and can make one named call on one named
 * path inside the temp project reject. Setup and assertions use the real,
 * unwrapped functions. Only A1 asserts a call list.
 *
 * SEVERAL CASES RECORD INCUMBENT BEHAVIOUR THAT IS KEPT ON PURPOSE AND NOT
 * ENDORSED: the copy fallback runs on ANY rename error (F2), a failed read in
 * that fallback writes an EMPTY archive file and deletes the source (F3), and
 * the fallback writes through a link at the destination (F6).
 *
 * No case reaches extraction or a provider: the one candidate is built with the
 * pure `buildRuleCandidate`.
 */

import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "bun:test";

type Op = "mkdir" | "rename" | "readFile" | "writeFile" | "unlink";

/** `calls` are [operation, ...arguments]; `faults` reject one operation on one path. */
const io = {
  on: false,
  calls: [] as unknown[][],
  faults: {} as Partial<Record<string, { at: string; error: Error }>>,
};

const recorder = (() => {
  type Fn = (...args: unknown[]) => unknown;
  /** Note the call while a move runs; reject it if a fault names this path. */
  const wrap = (name: string, real: Fn): Fn => (...args: unknown[]) => {
    if (io.on) io.calls.push([name, ...args]);
    const fault = io.on ? io.faults[name] : undefined;
    if (fault && fault.at === args[0]) return Promise.reject(fault.error);
    return real(...args);
  };
  /** A copy of one module object with the named functions wrapped, as named exports and on `default`. */
  const withWrapped = <T extends object>(actual: T, names: readonly string[]): T => {
    const real = actual as unknown as Record<string, Fn>;
    const wrapped = Object.fromEntries(names.map((name) => [name, wrap(name, real[name]!)]));
    return { ...actual, ...wrapped, default: { ...actual, ...wrapped } };
  };
  return {
    /** For `fs` and `node:fs`: the existence check. */
    ofFs: <T extends object>(actual: T): T => withWrapped(actual, ["existsSync"]),
    /** For `fs/promises` and `node:fs/promises`: the five promise calls. */
    ofFsPromises: <T extends object>(actual: T): T => withWrapped(actual, ["mkdir", "rename", "readFile", "writeFile", "unlink"]),
  };
})();

// Copy the real modules first: vi.mock patches them in place, so a later read would see the mock.
const realFsPromises = { ...(await import("node:fs/promises")) };
const realFs = { ...(await import("fs")) };

// All four specifiers: the function under test uses the bare names before the move and storage uses the `node:` names after it.
vi.mock("fs", () => recorder.ofFs(realFs));
vi.mock("node:fs", () => recorder.ofFs(realFs));
vi.mock("fs/promises", () => recorder.ofFsPromises(realFsPromises));
vi.mock("node:fs/promises", () => recorder.ofFsPromises(realFsPromises));

import { resolveConfinedCandidatesDir } from "../../src/compiler/candidate-store-paths.js";
import {
  archiveRuleCandidate, buildRuleCandidate, readRuleCandidate, writeRuleCandidate,
} from "../../src/compiler/rule-candidates.js";
import { candidateFileId, moveCandidateToArchive } from "../../src/utils/candidate-store.js";
import { RULE_CANDIDATES_ARCHIVE_DIR } from "../../src/utils/constants.js";
import { useTempRoot } from "../fixtures/temp-root.js";

const fs = realFsPromises;
const TEXT = '{"id":"a","note":"zażółć 規則"}';
const NOW = "2026-05-31T00:00:00.000Z";
useTempRoot();

const root = (): string => process.cwd();
const queue = (...parts: string[]): string => path.join(root(), "queue", ...parts);
const source = (): string => queue("a.json");
const target = (): string => queue("archive", "a.json");
const errorWith = (code: string): Error => Object.assign(new Error(`injected ${code}`), { code });
const textAt = (file: string): Promise<string> => fs.readFile(file, "utf-8");
const missing = async (file: string): Promise<void> => {
  await expect(fs.lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
};

/** Write the pending file, and the archive directory unless told not to. */
async function seed(withArchive = true): Promise<void> {
  await fs.mkdir(queue(withArchive ? "archive" : ""), { recursive: true });
  await fs.writeFile(source(), TEXT, "utf-8");
}

/** Make one operation reject with `code` when called on `at`; returns the error. */
function failing(op: Op, at: string, code: string): Error {
  const error = errorWith(code);
  io.faults[op] = { at, error };
  return error;
}

/** The copy fallback's whole outcome when `rename` rejects with `code`: copied, source deleted, true. */
async function expectFallbackCopies(code: string): Promise<void> {
  await seed();
  failing("rename", source(), code);
  expect(await move()).toBe(true);
  expect(await textAt(target())).toBe(TEXT);
  await missing(source());
}

/** The three calls of the ordinary route, in order, with their full arguments. */
const ordinaryCalls = (): unknown[][] => [
  ["existsSync", source()],
  ["mkdir", queue("archive"), { recursive: true }],
  ["rename", source(), target()],
];

/** Run the real move with the recorder on. */
async function move(from = source(), to = target()): Promise<boolean> {
  io.on = true;
  try {
    return await moveCandidateToArchive(from, to);
  } finally {
    io.on = false;
  }
}

beforeEach(() => { Object.assign(io, { on: false, calls: [], faults: {} }); });

describe("the archive move, ordinary route", () => {
  it("M1 returns false for a missing source and creates no archive directory", async () => {
    await fs.mkdir(queue());
    expect(await move()).toBe(false);
    await missing(queue("archive"));
  });

  it("M2 moves into a missing nested archive directory with the same bytes", async () => {
    await seed(false);
    const nested = queue("archive", "nested", "a.json");
    expect(await move(source(), nested)).toBe(true);
    expect(await textAt(nested)).toBe(TEXT);
    await missing(source());
  });

  it("M3 replaces an existing destination", async () => {
    await seed();
    await fs.writeFile(target(), "old", "utf-8");
    expect(await move()).toBe(true);
    expect(await textAt(target())).toBe(TEXT);
  });

  it("M4 returns false for a dangling source link; moves a link to a file as a link", async () => {
    await fs.mkdir(queue("archive"), { recursive: true });
    await fs.symlink(queue("nowhere.json"), source());
    expect(await move()).toBe(false);
    await missing(target());
    await fs.writeFile(queue("nowhere.json"), TEXT, "utf-8");
    expect(await move()).toBe(true);
    expect((await fs.lstat(target())).isSymbolicLink()).toBe(true);
  });

  it("M5 rejects when the archive parent is a file and leaves the source untouched", async () => {
    await seed(false);
    await fs.writeFile(queue("archive"), "a file, not a directory", "utf-8");
    await expect(move()).rejects.toBeDefined();
    expect(await textAt(source())).toBe(TEXT);
  });
});

describe("the archive move, copy fallback after a failed rename", () => {
  it("F1 copies then deletes when rename rejects with EXDEV", () => expectFallbackCopies("EXDEV"));

  it("F2 runs the same fallback for a rename error that is not EXDEV (incumbent, kept)", () => expectFallbackCopies("EACCES"));

  it("F3 writes an EMPTY archive file and deletes the source when the fallback read fails (incumbent loss, kept, not endorsed)", async () => {
    await seed();
    failing("rename", source(), "EXDEV");
    failing("readFile", source(), "EIO");
    expect(await move()).toBe(true);
    expect(await textAt(target())).toBe("");
    await missing(source());
  });

  it("F4 rejects with the raw error of a failing fallback write and keeps the source", async () => {
    await seed();
    failing("rename", source(), "EXDEV");
    const error = failing("writeFile", target(), "EIO");
    await expect(move()).rejects.toBe(error);
    expect(await textAt(source())).toBe(TEXT);
  });

  it("F5 rejects with the raw error of a failing fallback delete and leaves both files", async () => {
    await seed();
    failing("rename", source(), "EXDEV");
    const error = failing("unlink", source(), "EPERM");
    await expect(move()).rejects.toBe(error);
    expect(await textAt(source())).toBe(TEXT);
    expect(await textAt(target())).toBe(TEXT);
  });

  it("F6 writes THROUGH a link at the destination in the fallback (incumbent, kept)", async () => {
    await seed();
    await fs.writeFile(queue("elsewhere.json"), "old", "utf-8");
    await fs.symlink(queue("elsewhere.json"), target());
    failing("rename", source(), "EXDEV");
    expect(await move()).toBe(true);
    expect(await textAt(queue("elsewhere.json"))).toBe(TEXT);
    expect((await fs.lstat(target())).isSymbolicLink()).toBe(true);
    await missing(source());
  });
});

describe("the archive move through its one caller", () => {
  it("R1 archiveRuleCandidate moves the pending rule file into the rules archive byte for byte", async () => {
    const candidate = buildRuleCandidate({
      category: "process", slug: "require-tests-ab12cd34", title: "Require tests", description: "PRs include tests.",
      when: "a pull request is opened", then: "warn", evidence: [], provenance: { source: "llm-wiki-compiler" }, confidence: "high",
    }, NOW);
    const fileId = candidateFileId(candidate.id);
    const pending = await writeRuleCandidate(root(), candidate);
    const bytes = await fs.readFile(pending);
    await fs.mkdir(path.join(root(), RULE_CANDIDATES_ARCHIVE_DIR), { recursive: true });
    const archiveDir = await resolveConfinedCandidatesDir(root(), RULE_CANDIDATES_ARCHIVE_DIR);
    expect(archiveDir).not.toBeNull();
    expect(await archiveRuleCandidate(root(), fileId)).toBe(true);
    expect((await fs.readFile(path.join(archiveDir!, `${fileId}.json`))).equals(bytes)).toBe(true);
    await missing(pending);
    expect(await readRuleCandidate(root(), fileId, "archive")).toEqual(candidate);
  });
});

describe("the move's own disk calls, by argument", () => {
  it("A1 makes each call exactly once, in order, on the ordinary route and on the EXDEV fallback", async () => {
    await seed(false);
    expect(await move()).toBe(true);
    expect(io.calls).toStrictEqual(ordinaryCalls());
    io.calls = [];
    await fs.writeFile(source(), TEXT, "utf-8");
    failing("rename", source(), "EXDEV");
    expect(await move()).toBe(true);
    expect(io.calls).toStrictEqual([
      ...ordinaryCalls(),
      ["readFile", source(), "utf-8"],
      ["writeFile", target(), TEXT, "utf-8"],
      ["unlink", source()],
    ]);
  });
});
