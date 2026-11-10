/**
 * @file test/storage/residual-reads.test.ts
 * @description FIXED outcomes for the reads the embedding page scan, the
 * approval-time citation index, source freshness and the lock and journal
 * root lookups moved onto (`src/storage/disk-locations.ts`,
 * `readConfinedPageThrough` in `src/storage/disk-local-reads.ts`), on a temp
 * project, through the real callers.
 *
 * What the cases pin is that each caller kept ITS OWN rule, because the two
 * scans look alike and are not: the embedding scan swallows a listing failure
 * and accepts a page directory that is a link inside the project; the citation
 * index treats only a vanished directory as empty, throws every other failure,
 * refuses a redirected directory, and reads frontmatter only. Freshness still
 * hashes the DECODED text, and the lock and the journal still fall back to
 * the root as written when it cannot be resolved.
 *
 * Faults are injected through ONE module mock of `fs/promises`. The storage
 * files import `node:fs/promises`, so every injected case also shows the two
 * specifiers are one module to the mock.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "bun:test";
import * as fs from "fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

type FaultedCall = "readdir" | "realpath" | "stat";
/** The next `remaining` calls of `call` on exactly `target` reject with `error`. */
const fault = (() => ({ call: "", target: "", error: null as Error | null, remaining: 0 }))();

// Snapshot real modules before mock.module replaces them for this file.
const realFsPromises = { ...(await import("fs/promises")) };

vi.mock("fs/promises", async () => {
  const actual = realFsPromises as typeof import("fs/promises");
  const guarded = (call: FaultedCall) => (target: unknown, ...rest: unknown[]) => {
    if (fault.remaining > 0 && fault.call === call && target === fault.target) {
      fault.remaining -= 1;
      return Promise.reject(fault.error);
    }
    return (actual[call] as (...args: unknown[]) => unknown)(target, ...rest);
  };
  return { ...actual, readdir: guarded("readdir"), realpath: guarded("realpath"), stat: guarded("stat"), open: vi.fn(actual.open) };
});

import { locationIsRegularFile, locationRealPath, readLocationText } from "../../src/storage/disk-locations.js";
import { readConfinedPageThrough } from "../../src/storage/disk-local-reads.js";
import { collectNamespacedPageRecords } from "../../src/utils/embeddings-pages.js";
import { requestedPagesExistence } from "../../src/utils/embeddings-collect.js";
import { collectAnswerCitationIndex } from "../../src/citations/answer-index.js";
import { buildFreshnessSnapshot } from "../../src/freshness/index.js";
import { loadProfile } from "../../src/profile/load.js";
import { allTargetsConfined, type JournalBatch } from "../../src/trust/journal.js";
import { acquireLockBlocking, releaseLock } from "../../src/utils/lock.js";
import { writeTestStateJson } from "../fixtures/state-json.js";

/** SHA-256 of "a�b": the text Node decodes from the bytes 61 ff 62. Not the hash of those bytes. */
const DECODED_INVALID_UTF8_HASH = "05087813392efc16fe8ff448920c6328e53af865df39419436659d9ffda90f7b";
/** SHA-256 of "﻿x": a byte-order mark is kept by the decode. */
const BOM_TEXT_HASH = "84144a41283d6dc344addf4e83189d83fdd656439675abf54e6f44ccb73b4eb6";
const PAGE = (title: string): string => `---\ntitle: ${title}\nsummary: S.\naliases: [${title} Alias]\n---\n\nBody of ${title}.\n`;

let base: string;
let root: string;
const at = (relative: string): string => path.join(root, relative);

/** Write a file under the project, creating its directory. */
async function put(relative: string, content: string | Buffer): Promise<string> {
  await fs.mkdir(path.dirname(at(relative)), { recursive: true });
  await fs.writeFile(at(relative), content);
  return at(relative);
}

/** Arm one or more rejections of `call` on exactly `target`. */
function arm(call: FaultedCall, target: string, code: string, remaining = 1): Error {
  const error = Object.assign(new Error(`${code}: injected`), { code });
  Object.assign(fault, { call, target, error, remaining });
  return error;
}

/** What a promise settles to: its value, or the error it rejected with. */
const settled = <T>(work: Promise<T>): Promise<T | Error> => work.catch((error: Error) => error);

beforeEach(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "llmwiki-residual-")));
  root = path.join(base, "project");
  fault.remaining = 0;
  (fs.open as unknown as Mock<typeof fs.open>).mockClear();
  await put("wiki/concepts/alpha.md", PAGE("Alpha"));
  await put("wiki/queries/question.md", PAGE("Question"));
  await fs.writeFile(path.join(base, "outside.md"), PAGE("LEAK"));
});

afterEach(async () => {
  fault.remaining = 0;
  await fs.rm(base, { recursive: true, force: true });
});

describe("the location helpers", () => {
  it("resolves a real path as Node does and rejects with the raw error itself", async () => {
    await fs.symlink(at("wiki"), at("wiki-link"));
    expect(await locationRealPath(at("wiki-link/concepts/alpha.md"))).toBe(at("wiki/concepts/alpha.md"));
    expect(await settled(locationRealPath(at("missing")))).toMatchObject({ code: "ENOENT" });
    const injected = arm("realpath", at("wiki"), "EIO");
    expect(await settled(locationRealPath(at("wiki")))).toBe(injected);
  });

  it("answers regular-file by a FOLLOWING stat and rejects raw for nothing there", async () => {
    await fs.symlink(at("wiki/concepts/alpha.md"), at("file-link"));
    await fs.symlink(at("wiki"), at("dir-link"));
    await fs.symlink(at("nowhere"), at("dangling"));
    expect(await locationIsRegularFile(at("wiki/concepts/alpha.md"))).toBe(true);
    expect(await locationIsRegularFile(at("file-link"))).toBe(true);
    expect(await locationIsRegularFile(at("wiki"))).toBe(false);
    expect(await locationIsRegularFile(at("dir-link"))).toBe(false);
    expect(await settled(locationIsRegularFile(at("dangling")))).toMatchObject({ code: "ENOENT" });
    expect(await settled(locationIsRegularFile(at("wiki/concepts/alpha.md/child")))).toMatchObject({ code: "ENOTDIR" });
  });

  it("reads text through a link and rejects raw for a directory and for nothing", async () => {
    await fs.symlink(at("wiki/concepts/alpha.md"), at("file-link"));
    expect(await readLocationText(at("file-link"))).toBe(PAGE("Alpha"));
    expect(await settled(readLocationText(at("wiki")))).toMatchObject({ code: "EISDIR" });
    expect(await settled(readLocationText(at("missing")))).toMatchObject({ code: "ENOENT" });
  });

  it("lends the confined page's handle, reports a read fault with its cause, and closes the handle", async () => {
    const page = at("wiki/concepts/alpha.md");
    const lent: FileHandle[] = [];
    const firstBytes = async (handle: FileHandle): Promise<string> => { lent.push(handle); return (await handle.read(Buffer.alloc(3), 0, 3, 0)).buffer.toString(); };
    expect(await readConfinedPageThrough(page, at("wiki/concepts"), firstBytes)).toEqual({ kind: "ok", value: "---" });
    expect(await readConfinedPageThrough(page, at("wiki/queries"), firstBytes)).toEqual({ kind: "absent" });
    const cause = Object.assign(new Error("EIO: read"), { code: "EIO" });
    const failing = async (handle: FileHandle): Promise<never> => { lent.push(handle); throw cause; };
    expect(await readConfinedPageThrough(page, at("wiki/concepts"), failing, { strictIo: true })).toEqual({ kind: "unreadable", cause });
    expect(lent).toHaveLength(2);
    for (const handle of lent) await expect(handle.stat()).rejects.toMatchObject({ code: "EBADF" });
  });
});

describe("the embedding page scan keeps its permissive rule", () => {
  const slugs = async (): Promise<string[]> => (await collectNamespacedPageRecords(root)).map(({ namespace, record }) => `${namespace}/${record.slug}`);

  it("returns pages in listing order, concepts first, and drops what it always dropped", async () => {
    await put("wiki/concepts/notes.txt", "not a page");
    await put("wiki/concepts/orphan.md", "---\ntitle: Orphan\norphaned: true\n---\n");
    await put("wiki/concepts/untitled.md", "---\nsummary: none\n---\n");
    await fs.symlink(path.join(base, "outside.md"), at("wiki/concepts/leak.md"));
    await fs.symlink(at("wiki/concepts/alpha.md"), at("wiki/concepts/inside-link.md"));
    const listed = (await fs.readdir(at("wiki/concepts"))).filter((name) => ["alpha.md", "inside-link.md"].includes(name));
    expect(await slugs()).toEqual([...listed.map((name) => `concepts/${name.slice(0, -3)}`), "queries/question"]);
    expect(JSON.stringify(await collectNamespacedPageRecords(root))).not.toContain("LEAK");
  });

  it("scans a page directory linked inside the project and skips one linked outside it", async () => {
    await fs.rename(at("wiki/concepts"), at("wiki/real-concepts"));
    await fs.symlink(at("wiki/real-concepts"), at("wiki/concepts"));
    expect(await slugs()).toEqual(["concepts/alpha", "queries/question"]);
    await fs.rm(at("wiki/concepts"));
    await fs.mkdir(path.join(base, "elsewhere"));
    await fs.writeFile(path.join(base, "elsewhere/leak.md"), PAGE("LEAK"));
    await fs.symlink(path.join(base, "elsewhere"), at("wiki/concepts"));
    expect(await slugs()).toEqual(["queries/question"]);
  });

  it("skips a directory whose listing fails, and answers nothing for a missing root", async () => {
    arm("readdir", at("wiki/concepts"), "EACCES");
    expect(await slugs()).toEqual(["queries/question"]);
    expect(await collectNamespacedPageRecords(path.join(base, "missing"))).toEqual([]);
  });

  it("tells a present page from an absent one, and an unanswerable failure from both", async () => {
    await fs.mkdir(at("wiki/concepts/folder.md"));
    await fs.symlink(at("wiki/concepts/alpha.md"), at("wiki/concepts/linked.md"));
    const profile = await loadProfile(root);
    const ask = async (slug: string): Promise<string | undefined> => (await requestedPagesExistence(root, profile, [`concepts/${slug}`])).get(`concepts/${slug}`);
    expect([await ask("alpha"), await ask("linked"), await ask("folder"), await ask("missing")]).toEqual(["present", "present", "absent", "absent"]);
    arm("stat", at("wiki/concepts/alpha.md"), "ENOTDIR");
    expect(await ask("alpha")).toBe("absent");
    arm("stat", at("wiki/concepts/alpha.md"), "EACCES");
    expect(await ask("alpha")).toBe("unknown");
  });
});

describe("the citation index keeps its strict rule", () => {
  const retainedIds = async (): Promise<string[]> => (await collectAnswerCitationIndex(root)).retained.map((target) => target.id);

  it("treats only a vanished directory as empty and throws any other listing failure", async () => {
    arm("readdir", at("wiki/concepts"), "ENOENT");
    expect(await retainedIds()).toEqual(["queries/question"]);
    const denied = arm("readdir", at("wiki/concepts"), "EACCES");
    expect(await settled(collectAnswerCitationIndex(root))).toBe(denied);
  });

  it("answers empty for a missing root and throws a genuine fault resolving it", async () => {
    expect(await collectAnswerCitationIndex(path.join(base, "missing"))).toEqual({ retained: [], pending: [] });
    // EIO, not EACCES: portableRealpath treats EACCES as Bun's unreadable-leaf
    // quirk and resolves it the way Node would, so it is no longer a fault here.
    const denied = arm("realpath", root, "EIO");
    expect(await settled(collectAnswerCitationIndex(root))).toBe(denied);
  });

  it("refuses a page directory linked inside the project, which the embedding scan accepts", async () => {
    await fs.rename(at("wiki/concepts"), at("wiki/real-concepts"));
    await fs.symlink(at("wiki/real-concepts"), at("wiki/concepts"));
    expect(await retainedIds()).toEqual(["queries/question"]);
    expect((await collectNamespacedPageRecords(root)).map(({ record }) => record.slug)).toEqual(["alpha", "question"]);
  });

  it("reads frontmatter through the handle and never the whole page", async () => {
    await put("wiki/concepts/alpha.md", `${PAGE("Alpha")}${"x".repeat(200_000)}`);
    const actual = realFsPromises as typeof fs;
    const wholeReads: unknown[] = [];
    (fs.open as unknown as Mock<typeof fs.open>).mockImplementation(async (...args) => {
      const handle = await actual.open(...args);
      (vi.spyOn(handle, "readFile") as unknown as Mock<(...read: unknown[]) => Promise<string>>)
        .mockImplementation(async (...read) => { wholeReads.push(read); return ""; });
      return handle;
    });
    const index = await collectAnswerCitationIndex(root);
    (fs.open as unknown as Mock<typeof fs.open>).mockImplementation(actual.open);
    expect(index.retained.map((target) => [target.id, target.aliases])).toEqual([["concepts/alpha", ["Alpha Alias"]], ["queries/question", ["Question Alias"]]]);
    expect(wholeReads).toEqual([]);
  });
});

describe("source freshness keeps its reads and its decoded hash", () => {
  const stateListing = (...files: string[]) => ({ version: 1 as const, indexHash: "", sources: Object.fromEntries(files.map((file) => [file, { hash: "RECORDED", concepts: ["topic"], compiledAt: "t" }])) });
  const absentSource = { recordedHash: "RECORDED", currentHash: null, exists: false, concepts: ["topic"] };

  it("answers not-there for every source when the sources directory is missing", async () => {
    await writeTestStateJson(root, stateListing("a.md"));
    expect((await buildFreshnessSnapshot(root)).sources).toEqual({ "a.md": absentSource });
  });

  it("hashes the decoded text, not the bytes, and keeps a byte-order mark", async () => {
    await put("sources/invalid.md", Buffer.from([0x61, 0xff, 0x62]));
    await put("sources/bom.md", Buffer.from([0xef, 0xbb, 0xbf, 0x78]));
    await writeTestStateJson(root, stateListing("invalid.md", "bom.md"));
    const { sources } = await buildFreshnessSnapshot(root);
    expect(sources["invalid.md"]).toMatchObject({ exists: true, currentHash: DECODED_INVALID_UTF8_HASH });
    expect(sources["bom.md"]).toMatchObject({ exists: true, currentHash: BOM_TEXT_HASH });
  });

  it("reads a real source under a linked project root and treats a source that is a directory as not there", async () => {
    await put("sources/a.md", Buffer.from([0x61, 0xff, 0x62]));
    await writeTestStateJson(root, stateListing("a.md"));
    await fs.symlink(root, path.join(base, "linked"));
    expect((await buildFreshnessSnapshot(path.join(base, "linked"))).sources["a.md"]).toMatchObject({ exists: true, currentHash: DECODED_INVALID_UTF8_HASH });
    await fs.mkdir(at("sources/folder.md"));
    await writeTestStateJson(root, stateListing("folder.md"));
    // Public #280 parity: a directory where the source used to be is unverifiable,
    // exactly like a named pipe, instead of rejecting the whole snapshot with EISDIR.
    expect((await buildFreshnessSnapshot(root)).sources).toEqual({ "folder.md": absentSource });
  });
});

describe("the lock and the journal fall back to the root as written", () => {
  it("queues and releases on the written root when it cannot be resolved", async () => {
    const linked = path.join(base, "linked");
    await fs.symlink(root, linked);
    arm("realpath", linked, "EACCES");
    await acquireLockBlocking(linked, { timeoutMs: 2_000 });
    arm("realpath", linked, "EACCES");
    await releaseLock(linked);
    arm("realpath", linked, "EACCES");
    await acquireLockBlocking(linked, { timeoutMs: 2_000 });
    arm("realpath", linked, "EACCES");
    await releaseLock(linked);
    expect(fault.remaining).toBe(0);
    expect(await settled(fs.stat(at(".llmwiki/lock")))).toMatchObject({ code: "ENOENT" });
  });

  it("confines a recorded target under either form of the root, resolved or not", async () => {
    const linked = path.join(base, "linked");
    await fs.symlink(root, linked);
    const batch = (targetPath: string): JournalBatch => ({ batchId: "b", root: linked, status: "pending", entries: [{ targetPath, preState: { absent: true } }] });
    expect(await allTargetsConfined(batch(at("wiki/concepts/alpha.md")))).toBe(true);
    expect(await allTargetsConfined(batch(path.join(linked, "wiki/concepts/alpha.md")))).toBe(true);
    arm("realpath", linked, "EACCES");
    expect(await allTargetsConfined(batch(path.join(linked, "wiki/concepts/alpha.md")))).toBe(true);
    expect(fault.remaining).toBe(0);
    expect(await allTargetsConfined(batch(path.join(base, "outside.md")))).toBe(false);
  });
});
