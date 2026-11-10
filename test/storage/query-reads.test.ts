/**
 * @file test/storage/query-reads.test.ts
 * @description FIXED outcomes for the reads a query makes through
 * `src/storage/`: the bounded prefix read, the page scan built on it, the two
 * registry page reads, the index check, and the saved-answer precondition.
 *
 * The prefix read is the delicate one, so its contract is pinned by MEASURING
 * what was read, not only by what came back: one `read` call at offset 0, of
 * the cap, no loop after a short read, a link followed, and a failing `close`
 * rejecting. On top of it, four metadata-only cases pin the rule the scan
 * depends on: at most the cap is read UNLESS a frontmatter block is still open
 * at the cap, in which case the WHOLE file is read as well. A file of exactly
 * the cap counts as not complete.
 *
 * Reads are observed through one module mock of `fs/promises` that forwards
 * every call to the real filesystem. The storage files import
 * `node:fs/promises`; the mock reaching them is part of what is shown.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

interface ReadCall { requested: number; position: unknown; bytesRead: number }
/** What the mock saw and what it should do to the next opened handle. */
const tape = (() => ({
  reads: {} as Record<string, ReadCall[]>, wholeReads: [] as string[],
  shortReadOf: null as number | null, closeError: null as Error | null,
}))();

// Snapshot real modules before mock.module replaces them for this file.
const realFsPromises = { ...(await import("fs/promises")) };

vi.mock("fs/promises", async () => {
  const actual = realFsPromises as typeof import("fs/promises");
  const open = (async (target: unknown, ...rest: unknown[]) => {
    const handle = await (actual.open as (...args: unknown[]) => Promise<fs.FileHandle>)(target, ...rest);
    const realRead = handle.read.bind(handle) as (...args: unknown[]) => Promise<{ bytesRead: number }>;
    const realClose = handle.close.bind(handle);
    const calls = (tape.reads[String(target)] ??= []);
    handle.read = (async (buffer: Buffer, offset: number, length: number, position: unknown) => {
      const result = await realRead(buffer, offset, tape.shortReadOf ?? length, position);
      calls.push({ requested: length, position, bytesRead: result.bytesRead });
      return result;
    }) as typeof handle.read;
    const closeError = tape.closeError;
    handle.close = async () => { await realClose(); if (closeError) throw closeError; };
    return handle;
  }) as typeof actual.open;
  const readFile = ((target: unknown, ...rest: unknown[]) => {
    if (typeof target === "string") tape.wholeReads.push(target);
    return (actual.readFile as (...args: unknown[]) => unknown)(target, ...rest);
  }) as typeof actual.readFile;
  return { ...actual, open, readFile };
});

vi.mock("../../src/commands/query-selection.js", () => ({
  selectRelevantPages: vi.fn(async () => ({ refs: [], chunks: [], reasoning: "nothing selected", warnings: [] })),
}));

import { readLocationPrefix } from "../../src/storage/disk-locations.js";
import { scanEntityDir } from "../../src/wiki/collect.js";
import { buildLiveRegistryEntry, loadPageRecordsByPageId } from "../../src/utils/page-registry.js";
import { generateAnswer } from "../../src/commands/query.js";
import { stageQueryProposal } from "../../src/commands/query-proposal.js";
import { sha256Text } from "../../src/connectors/hash.js";

const CAP = 64 * 1024;
const PAGE = (title: string): string => `---\ntitle: ${title}\nsummary: S.\n---\n\nBody of ${title}.\n`;
const NO_INDEX = "Wiki index not found. Run `llmwiki compile` first.";

/** The run's temp directory and the project inside it. */
const run = { base: "", root: "" };
const at = (relative: string): string => path.join(run.root, relative);
/** What a promise settles to: its value, or the error it rejected with. */
const settled = <T>(work: Promise<T>): Promise<T | Error> => work.then((value) => value, (error: Error) => error);

/** Write a file under the project, creating its directory, and return its absolute path. */
const put = async (relative: string, content: string | Buffer): Promise<string> => {
  const file = at(relative);
  await fs.mkdir(path.dirname(file), { recursive: true }).then(() => fs.writeFile(file, content));
  return file;
};

beforeEach(async () => {
  run.base = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "llmwiki-query-reads-")));
  run.root = path.join(run.base, "project");
  await fs.mkdir(run.root);
  Object.assign(tape, { reads: {}, wholeReads: [], shortReadOf: null, closeError: null });
});

afterEach(async () => {
  Object.assign(tape, { shortReadOf: null, closeError: null });
  await fs.rm(run.base, { recursive: true, force: true });
});

describe("readLocationPrefix", () => {
  it.each([[10, 10], [CAP, CAP], [CAP + 5000, CAP]])("of a %i-byte file returns %i bytes from ONE read of the cap at offset 0", async (size, expected) => {
    const file = await put("file.bin", Buffer.alloc(size, 0x61));
    const prefix = await readLocationPrefix(file, CAP);
    expect(prefix.length).toBe(expected);
    expect(prefix.equals(Buffer.alloc(expected, 0x61))).toBe(true);
    expect(tape.reads[file]).toEqual([{ requested: CAP, position: 0, bytesRead: expected }]);
  });

  it("follows a link at the location", async () => {
    await put("target.md", "linked text");
    await fs.symlink(at("target.md"), at("link.md"));
    expect((await readLocationPrefix(at("link.md"), CAP)).toString("utf-8")).toBe("linked text");
  });

  it("returns a short read as it is and does not read again", async () => {
    const file = await put("file.bin", Buffer.alloc(100, 0x62));
    tape.shortReadOf = 7;
    const prefix = await readLocationPrefix(file, CAP);
    expect(prefix.equals(Buffer.alloc(7, 0x62))).toBe(true);
    expect(tape.reads[file]).toEqual([{ requested: CAP, position: 0, bytesRead: 7 }]);
  });

  it("rejects when close fails after a good read, and rejects raw for nothing there", async () => {
    const file = await put("file.bin", "good");
    tape.closeError = Object.assign(new Error("EIO: close failed"), { code: "EIO" });
    const closeError = tape.closeError;
    expect(await settled(readLocationPrefix(file, CAP))).toBe(closeError);
    expect(tape.reads[file]).toEqual([{ requested: CAP, position: 0, bytesRead: 4 }]);
    tape.closeError = null;
    expect(await settled(readLocationPrefix(at("missing"), CAP))).toMatchObject({ code: "ENOENT" });
  });
});

describe("the metadata-only page scan", () => {
  /** Scan one concepts page without its body; report what was read and what was found. */
  async function scanOne(content: string): Promise<{ prefixBytes: number[]; wholeFileRead: boolean; title: unknown; hasBlock: boolean; body: string }> {
    const file = await put("wiki/concepts/page.md", content);
    const { scans } = await scanEntityDir(run.root, "wiki/concepts", { includeBody: false });
    return {
      prefixBytes: (tape.reads[file] ?? []).map((call) => call.bytesRead), wholeFileRead: tape.wholeReads.includes(file),
      title: scans[0]?.frontmatter.title, hasBlock: scans[0]?.parseStatus.hasFrontmatterBlock ?? false, body: scans[0]?.body ?? "",
    };
  }
  const padTo = (text: string, size: number, tail = ""): string => text + "x".repeat(size - Buffer.byteLength(text) - Buffer.byteLength(tail)) + tail;

  it("reads the whole file when the frontmatter closes beyond the cap, and finds its metadata", async () => {
    const seen = await scanOne(`---\ntitle: Far Fence\nnote: ${"n".repeat(CAP + 100)}\n---\n\nBody.\n`);
    expect(seen).toEqual({ prefixBytes: [CAP], wholeFileRead: true, title: "Far Fence", hasBlock: true, body: "" });
  });

  it("answers from the prefix for a file of exactly the cap whose frontmatter closes within it", async () => {
    const content = padTo("---\ntitle: Exact Closed\n---\n\n", CAP);
    expect(Buffer.byteLength(content)).toBe(CAP);
    expect(await scanOne(content)).toEqual({ prefixBytes: [CAP], wholeFileRead: false, title: "Exact Closed", hasBlock: true, body: "" });
  });

  it("falls back to the whole file for a file of exactly the cap whose frontmatter is still open", async () => {
    const content = padTo("---\ntitle: Exact Open\nnote: ", CAP);
    expect(Buffer.byteLength(content)).toBe(CAP);
    const seen = await scanOne(content);
    expect({ prefixBytes: seen.prefixBytes, wholeFileRead: seen.wholeFileRead, hasBlock: seen.hasBlock }).toEqual({ prefixBytes: [CAP], wholeFileRead: true, hasBlock: false });
  });

  it("reads only the prefix of a page with short frontmatter and a multi-megabyte body", async () => {
    const seen = await scanOne(`${PAGE("Big Body")}${"b".repeat(3 * 1024 * 1024)}`);
    expect(seen).toEqual({ prefixBytes: [CAP], wholeFileRead: false, title: "Big Body", hasBlock: true, body: "" });
  });

  it("lists pages in name order, skips non-pages and escapes, and tells a missing directory from a redirected one", async () => {
    for (const name of ["b.md", "a.md", "c.md"]) await put(`wiki/concepts/${name}`, PAGE(name));
    await put("wiki/concepts/notes.txt", "not a page");
    await fs.writeFile(path.join(run.base, "outside.md"), PAGE("LEAK"));
    await fs.symlink(path.join(run.base, "outside.md"), at("wiki/concepts/leak.md"));
    // Name order: the disk adapter sorts, as Node's libuv did (Bun's readdir does not).
    const listed = (await fs.readdir(at("wiki/concepts"))).filter((name) => ["a.md", "b.md", "c.md"].includes(name)).sort();
    const scan = await scanEntityDir(run.root, "wiki/concepts", { includeBody: false });
    expect({ status: scan.dirStatus, stems: scan.scans.map((entry) => entry.stem) }).toEqual({ status: "ok", stems: listed.map((name) => name.slice(0, -3)) });
    expect(await scanEntityDir(run.root, "wiki/absent")).toEqual({ scans: [], dirStatus: "missing" });
    await fs.symlink(at("wiki/concepts"), at("wiki/redirected"));
    expect(await scanEntityDir(run.root, "wiki/redirected")).toEqual({ scans: [], dirStatus: "invalid" });
  });
});

describe("the registry's two page reads", () => {
  beforeEach(async () => {
    await put("wiki/concepts/alpha.md", PAGE("Alpha"));
    await fs.writeFile(path.join(run.base, "outside.md"), PAGE("LEAK"));
    await fs.symlink(path.join(run.base, "outside.md"), at("wiki/concepts/leak.md"));
    await fs.symlink(at("wiki/concepts/alpha.md"), at("wiki/concepts/inside.md"));
  });

  it("loads a confined page and one reached by an in-directory link, and drops an escaping page and unknown ids", async () => {
    const records = await loadPageRecordsByPageId(run.root, ["concepts/alpha", "concepts/inside", "concepts/leak", "concepts/missing", "nowhere/alpha", "not-an-id"]);
    expect(records.map((record) => [record.slug, record.title])).toEqual([["alpha", "Alpha"], ["inside", "Alpha"]]);
    expect(JSON.stringify(records)).not.toContain("LEAK");
    expect(await loadPageRecordsByPageId(path.join(run.base, "no-such-root"), ["concepts/alpha"])).toEqual([]);
  });

  it("builds a live entry for a confined page and none for an escaping or missing one", async () => {
    const entry = await buildLiveRegistryEntry(run.root, "concepts/alpha");
    expect(entry).toMatchObject({ capturedRealpath: at("wiki/concepts/alpha.md"), expectedCanonicalDir: at("wiki/concepts") });
    const viaLink = await buildLiveRegistryEntry(run.root, "concepts/inside");
    expect(viaLink).toMatchObject({ capturedRealpath: at("wiki/concepts/alpha.md") });
    expect({ ...viaLink, capturedRealpath: "" }).toEqual({ ...entry, capturedRealpath: "" });
    expect(await buildLiveRegistryEntry(run.root, "concepts/leak")).toBeNull();
    expect(await buildLiveRegistryEntry(run.root, "concepts/missing")).toBeNull();
  });
});

describe("the query's index check and the saved-answer precondition", () => {
  it("refuses a missing or dangling index and goes on past a present or linked one", async () => {
    expect(await settled(generateAnswer(run.root, "Q"))).toMatchObject({ message: NO_INDEX });
    await fs.mkdir(at("wiki"));
    await fs.symlink(at("wiki/nowhere.md"), at("wiki/index.md"));
    expect(await settled(generateAnswer(run.root, "Q"))).toMatchObject({ message: NO_INDEX });
    await fs.rm(at("wiki/index.md"));
    await put("wiki/real-index.md", "# Index\n");
    await fs.symlink(at("wiki/real-index.md"), at("wiki/index.md"));
    expect(await generateAnswer(run.root, "Q")).toMatchObject({ answer: "", selectedPages: [] });
    await fs.rm(at("wiki/index.md"));
    await put("wiki/index.md", "# Index\n");
    expect(await generateAnswer(run.root, "Q")).toMatchObject({ answer: "", selectedPages: [] });
  });

  it("records the target's digest, or its absence, and refuses any other read failure", async () => {
    const stage = (question: string): Promise<string> => stageQueryProposal({ root: run.root, question, document: "---\ntitle: T\n---\n\nAn answer.\n", report: { citations: [] } as never });
    const candidate = async (id: string): Promise<Record<string, unknown>> => JSON.parse(await fs.readFile(at(`.llmwiki/candidates/${id}.json`), "utf-8")) as Record<string, unknown>;
    const absent = await candidate(await stage("Absent target"));
    expect([absent.expectTargetAbsent, absent.expectedTargetHash]).toEqual([true, undefined]);
    await put("wiki/queries/present-target.md", "existing page text");
    const present = await candidate(await stage("Present target"));
    expect([present.expectTargetAbsent, present.expectedTargetHash]).toEqual([undefined, sha256Text("existing page text")]);
    await fs.mkdir(at("wiki/queries/unreadable-target.md"), { recursive: true });
    expect(await settled(stage("Unreadable target"))).toMatchObject({ code: "EISDIR" });
  });
});
