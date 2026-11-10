/**
 * @file test/storage/disk-guarded-leaves.test.ts
 * @description The guarded physical observations a local project's custody
 * code is built on (`src/storage/disk-guarded-leaves.ts`), exercised directly
 * on a temp directory in generic vocabulary: directories, leaves, identities.
 *
 * These cases pin what moving the mechanics out of the candidate modules could
 * silently change: the ORDER of the probe's and the enumeration's steps (a
 * re-check that moved ahead of its hook could leave the existing race tests
 * green), the caps being enforced before an excess entry is kept, the close on
 * every path, the raw rejection for an unresolvable root, and the refusals of
 * the guarded read being values. For the guarded move: the source handle stays
 * open until AFTER the caller's post-rename check, and nothing is copied. A
 * refusal before the rename and a failed rename are `false` with both paths
 * left as they were; a post-rename check that returns `false` or throws is
 * also `false`, but the rename has already happened and is NOT undone. For the
 * writes: they carry only the incumbent writer's no-replace, atomicity and
 * confinement, their hooks run at the writer's two points, and the existence
 * check and the removal are single unguarded system calls with raw errors.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** Events the wrapped primitives record: each close of a leaf handle the confined opener returned. */
const handleLog = (() => [] as string[])();

// Snapshot real modules before mock.module replaces them for this file.
const realFsPromises = { ...(await import("node:fs/promises")) };
const realUtilsConfinedRead = { ...(await import("../../src/utils/confined-read.js")) };

vi.mock("node:fs/promises", async () => {
  const actual = realFsPromises as typeof import("node:fs/promises");
  return { ...actual, access: vi.fn(actual.access), opendir: vi.fn(actual.opendir), rename: vi.fn(actual.rename) };
});

vi.mock("../../src/utils/confined-read.js", async () => {
  const actual = realUtilsConfinedRead as typeof import("../../src/utils/confined-read.js");
  const openConfinedLeaf: typeof actual.openConfinedLeaf = async (...args) => {
    const opened = await actual.openConfinedLeaf(...args);
    if (opened.kind !== "confirmed") return opened;
    const close = opened.handle.close.bind(opened.handle);
    opened.handle.close = async () => { handleLog.push("handle-closed"); return close(); };
    return opened;
  };
  return { ...actual, openConfinedLeaf };
});

import { access, opendir } from "node:fs/promises";
import { AtomicWriteCollisionError } from "../../src/utils/atomic-write.js";
import { CandidateCustodyBoundaryError } from "../../src/compiler/candidate-custody-snapshot.js";
import { moveCandidateWithCustody } from "../../src/compiler/candidate-custody.js";
import {
  createLeafNoReplace, directoryStillBound, enumerateSuffixedNames, ensureDirectory, leafDigest, leafMatches,
  leafPresent, moveGuardedLeaf, probeDirectory, readGuardedLeaf, removeLeaf, replaceLeafAtomic, sameIdentity,
  type GuardedLeafExpectation, type GuardedLeafMoveRequest, type GuardedLeafRead, type SuffixedNameEnumeration,
} from "../../src/storage/disk-guarded-leaves.js";
import { captureCandidateDirectoryBinding, type CandidateDirectoryBinding } from "../../src/storage/disk-record-directory.js";

const QUEUE = ".llmwiki/candidates";

/**
 * The raw error the runtime's own `realpath` raises for `target`, as `{ code, syscall, path }`.
 * The syscall is runtime-specific (Node reports `realpath`, Bun `lstat`), so the raw-rejection
 * assertions compare against this rather than a hard-coded name.
 */
async function rawRealpathError(target: string): Promise<{ code?: string; syscall?: string; path?: string }> {
  const err = (await realpath(target).then(() => { throw new Error(`${target} resolved`); }, (e: unknown) => e)) as NodeJS.ErrnoException;
  return { code: err.code, syscall: err.syscall, path: err.path };
}

let base: string;
let root: string;
let queue: string;
let binding: CandidateDirectoryBinding;

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), "llmwiki-guarded-leaves-")));
  root = path.join(base, "project");
  queue = path.join(root, QUEUE);
  await mkdir(queue, { recursive: true });
  await writeFile(path.join(queue, "a.json"), "leaf bytes", "utf-8");
  binding = (await captureCandidateDirectoryBinding(root, QUEUE))!;
  (access as unknown as Mock<typeof access>).mockClear();
  (opendir as unknown as Mock<typeof opendir>).mockClear();
  (rename as unknown as Mock<typeof rename>).mockClear();
  handleLog.length = 0;
});

afterEach(() => rm(base, { recursive: true, force: true }));

/** Replace the queue directory with a different one at the same path. */
async function replaceQueue(): Promise<void> {
  await rename(queue, path.join(root, ".llmwiki", "moved-away"));
  await mkdir(queue);
}

/** An enumeration that logs each checkpoint and hook, with caps high unless overridden. */
function loggedEnumeration(log: string[], overrides: Partial<SuffixedNameEnumeration> = {}): SuffixedNameEnumeration {
  return {
    suffix: ".json", maxDirectEntries: 201, maxNames: 200,
    recheck: async () => { log.push("recheck"); },
    overflow: () => new Error("overflow"),
    beforeOpen: async () => { log.push("beforeOpen"); },
    afterOpen: async () => { log.push("afterOpen"); },
    ...overrides,
  };
}

describe("directoryStillBound and probeDirectory", () => {
  it("compares identities by device and inode, and loses a binding when the directory is replaced", async () => {
    expect(sameIdentity({ dev: 1, ino: 2 }, { dev: 1, ino: 2 })).toBe(true);
    expect(sameIdentity({ dev: 1, ino: 2 }, { dev: 1, ino: 3 })).toBe(false);
    expect(await directoryStillBound(root, binding)).toBe(true);
    await replaceQueue();
    expect(await directoryStillBound(root, binding)).toBe(false);
    expect(await directoryStillBound(path.join(base, "no-project"), binding)).toBe(false);
  });

  it("probes for write with one access call for write and search, and never opens the directory", async () => {
    expect(await probeDirectory(root, binding, "write")).toBe(true);
    expect((access as unknown as Mock<typeof access>).mock.calls).toEqual([[binding.realDir, 2 | 1]]);
    expect((opendir as unknown as Mock<typeof opendir>)).not.toHaveBeenCalled();
  });

  it("probes for list as access, re-bind, open, close, re-bind again", async () => {
    expect(await probeDirectory(root, binding, "list")).toBe(true);
    expect((access as unknown as Mock<typeof access>).mock.calls).toEqual([[binding.realDir, 4 | 1]]);
    expect((opendir as unknown as Mock<typeof opendir>).mock.calls).toEqual([[binding.realDir]]);
    // The SECOND re-bind: the directory is replaced while it is open, after the first re-bind passed.
    (opendir as unknown as Mock<typeof opendir>).mockImplementationOnce(async (dir) => {
      const actual = realFsPromises as typeof import("node:fs/promises");
      const opened = await actual.opendir(dir);
      await replaceQueue();
      return opened;
    });
    expect(await probeDirectory(root, binding, "list")).toBe(false);
  });

  it("reports false, not an error, when the directory is gone or was already replaced", async () => {
    await replaceQueue();
    expect(await probeDirectory(root, binding, "write")).toBe(false);
    expect(await probeDirectory(root, binding, "list")).toBe(false);
    expect((opendir as unknown as Mock<typeof opendir>)).not.toHaveBeenCalled();
  });
});

describe("readGuardedLeaf", () => {
  const request = (leaf: string, maxBytes = 1024) => ({ root, leaf: path.join(queue, leaf), store: binding, location: binding, maxBytes });

  it("returns the exact bytes with the leaf's own device and inode", async () => {
    const read = await readGuardedLeaf(request("a.json"));
    const info = await stat(path.join(queue, "a.json"));
    expect(read).toEqual({ kind: "ok", bytes: Buffer.from("leaf bytes"), fileIdentity: { dev: info.dev, ino: info.ino } });
  });

  it("refuses by value: absent, oversize, a linked leaf, a directory, and a store that was replaced", async () => {
    await symlink(path.join(queue, "a.json"), path.join(queue, "link.json"));
    await mkdir(path.join(queue, "dir.json"));
    expect(await readGuardedLeaf(request("missing.json"))).toEqual({ kind: "absent" });
    expect(await readGuardedLeaf(request("a.json", 9))).toEqual({ kind: "unavailable" });
    expect(await readGuardedLeaf(request("a.json", 10))).toMatchObject({ kind: "ok" });
    expect(await readGuardedLeaf(request("link.json"))).toEqual({ kind: "unavailable" });
    expect(await readGuardedLeaf(request("dir.json"))).toEqual({ kind: "unavailable" });
    const stale = { ...binding, identity: { dev: binding.identity.dev, ino: binding.identity.ino + 1 } };
    expect(await readGuardedLeaf({ ...request("a.json"), store: stale })).toEqual({ kind: "unavailable" });
  });

  it("rejects with the raw error, not a refusal value, when the root cannot be resolved", async () => {
    const missingRoot = path.join(base, "no-project");
    const raw = await rawRealpathError(missingRoot);
    expect(raw).toMatchObject({ code: "ENOENT", path: missingRoot });
    await expect(readGuardedLeaf({ ...request("a.json"), root: missingRoot })).rejects.toMatchObject(raw);
  });
});

describe("enumerateSuffixedNames", () => {
  it("runs hook, re-check, open, hook, re-check, stream, re-check, close, in that order", async () => {
    const log: string[] = [];
    (opendir as unknown as Mock<typeof opendir>).mockImplementationOnce(async (dir) => {
      log.push("open");
      const opened = await (realFsPromises as typeof import("node:fs/promises")).opendir(dir);
      const close = opened.close.bind(opened);
      // Iterate with read(): Bun's own Dir iterator calls the PUBLIC close() when the stream
      // ends, which would log a runtime close in place of the one under test.
      const entries = {
        next: async () => {
          const entry = await opened.read();
          if (entry === null) log.push("stream-end");
          return entry === null ? { done: true as const, value: undefined } : { done: false as const, value: entry };
        },
        [Symbol.asyncIterator]() { return this; },
      };
      opened[Symbol.asyncIterator] = (() => entries) as unknown as typeof opened[typeof Symbol.asyncIterator];
      opened.close = (async () => { log.push("close"); return close(); }) as typeof opened.close;
      return opened;
    });
    expect(await enumerateSuffixedNames(binding, loggedEnumeration(log))).toEqual(["a"]);
    expect(log).toEqual(["beforeOpen", "recheck", "open", "afterOpen", "recheck", "stream-end", "recheck", "close"]);
  });

  it("names entries of any kind that end with the suffix, stem only, and nothing else", async () => {
    await mkdir(path.join(queue, "dir.json"));
    await symlink(path.join(queue, "a.json"), path.join(queue, "link.json"));
    await writeFile(path.join(queue, "notes.txt"), "x", "utf-8");
    await writeFile(path.join(queue, ".json"), "x", "utf-8");
    expect((await enumerateSuffixedNames(binding, loggedEnumeration([]))).sort()).toEqual(["", "a", "dir", "link"]);
  });

  it("refuses at the entry past each cap, before keeping it, and still closes the directory", async () => {
    for (const name of ["b.json", "c.json", "d.txt"]) await writeFile(path.join(queue, name), "x", "utf-8");
    const closed: string[] = [];
    (opendir as unknown as Mock<typeof opendir>).mockImplementation(async (dir) => {
      const opened = await (realFsPromises as typeof import("node:fs/promises")).opendir(dir);
      const close = opened.close.bind(opened);
      opened.close = (async () => { closed.push("close"); return close(); }) as typeof opened.close;
      return opened;
    });
    await expect(enumerateSuffixedNames(binding, loggedEnumeration([], { maxDirectEntries: 3 }))).rejects.toThrow("overflow");
    await expect(enumerateSuffixedNames(binding, loggedEnumeration([], { maxNames: 2 }))).rejects.toThrow("overflow");
    expect(await enumerateSuffixedNames(binding, loggedEnumeration([], { maxDirectEntries: 4, maxNames: 3 }))).toHaveLength(3);
    expect(closed.length).toBeGreaterThanOrEqual(3);
    (opendir as unknown as Mock<typeof opendir>).mockReset();
  });

  it("propagates a failed re-check or hook untouched and stops before the next step", async () => {
    const refusal = new Error("rebound");
    const log: string[] = [];
    const afterOpenRecheck = loggedEnumeration(log, {
      recheck: async () => { log.push("recheck"); if (log.filter((step) => step === "recheck").length === 2) throw refusal; },
    });
    await expect(enumerateSuffixedNames(binding, afterOpenRecheck)).rejects.toBe(refusal);
    expect(log).toEqual(["beforeOpen", "recheck", "afterOpen", "recheck"]);
    await expect(enumerateSuffixedNames(binding, loggedEnumeration([], { beforeOpen: async () => { throw refusal; } }))).rejects.toBe(refusal);
  });

  it("rejects an empty suffix with a RangeError before any hook, re-check or open", async () => {
    const log: string[] = [];
    await expect(enumerateSuffixedNames(binding, loggedEnumeration(log, { suffix: "" }))).rejects.toBeInstanceOf(RangeError);
    expect(log).toEqual([]);
    expect((opendir as unknown as Mock<typeof opendir>)).not.toHaveBeenCalled();
  });
});

describe("leafDigest, leafMatches and ensureDirectory", () => {
  const bytes = Buffer.from("leaf bytes");
  const identity = { dev: 7, ino: 11 };
  const expect_: GuardedLeafExpectation = { byteCount: 10, sha256: leafDigest(bytes), fileIdentity: identity };
  const read: GuardedLeafRead = { kind: "ok", bytes, fileIdentity: identity };

  it("matches only an ok read with the same byte count, identity and digest", () => {
    // sha256("leaf bytes"), computed outside this code base.
    expect(leafDigest(bytes)).toBe("97503caa9441fead55ec076409bf490afbc142713f4e09ca7ab74f57699aa68f");
    expect(leafMatches(read, expect_)).toBe(true);
    expect(leafMatches(read, { ...expect_, byteCount: 9 })).toBe(false);
    expect(leafMatches(read, { ...expect_, sha256: leafDigest(Buffer.from("leaf bytez")) })).toBe(false);
    expect(leafMatches(read, { ...expect_, fileIdentity: { dev: 7, ino: 12 } })).toBe(false);
    expect(leafMatches({ kind: "absent" }, expect_)).toBe(false);
    expect(leafMatches({ kind: "unavailable" }, expect_)).toBe(false);
  });

  it("creates one directory level and ignores every error, guarding nothing", async () => {
    await ensureDirectory(root, `${QUEUE}/archive`);
    expect((await stat(path.join(queue, "archive"))).isDirectory()).toBe(true);
    await expect(ensureDirectory(root, `${QUEUE}/archive`)).resolves.toBeUndefined();
    await expect(ensureDirectory(root, "absent-parent/child")).resolves.toBeUndefined();
    await expect(stat(path.join(root, "absent-parent"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("moveGuardedLeaf", () => {
  let archive: CandidateDirectoryBinding;
  let source: string;
  let destination: string;

  beforeEach(async () => {
    await mkdir(path.join(queue, "archive"));
    archive = (await captureCandidateDirectoryBinding(root, `${QUEUE}/archive`))!;
    source = path.join(queue, "a.json");
    destination = path.join(queue, "archive", "a.json");
  });

  /** A move request for the seeded leaf, expecting exactly its current bytes and identity. */
  async function request(overrides: Partial<GuardedLeafMoveRequest> = {}): Promise<GuardedLeafMoveRequest> {
    const info = await stat(source);
    const bytes = Buffer.from("leaf bytes");
    return {
      root, source, destination, maxBytes: 1024, parents: { source: binding, destination: archive },
      expect: { byteCount: bytes.byteLength, sha256: leafDigest(bytes), fileIdentity: { dev: info.dev, ino: info.ino } },
      afterRename: async () => true,
      ...overrides,
    };
  }

  /** Whether the leaf is still at the source with its bytes and nothing is at the destination. */
  async function untouched(): Promise<boolean> {
    const atSource = await readFile(source, "utf-8").catch(() => null);
    const atDestination = await stat(destination).then(() => true, () => false);
    return atSource !== null && !atDestination;
  }

  it("renames the leaf and keeps the source handle open until after afterRename", async () => {
    const moved = await moveGuardedLeaf(await request({
      afterRename: async () => { handleLog.push("afterRename"); return true; },
    }));
    expect(moved).toBe(true);
    expect(handleLog).toEqual(["afterRename", "handle-closed"]);
    expect(await readFile(destination, "utf-8")).toBe("leaf bytes");
    await expect(stat(source)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns afterRename's verdict and undoes nothing when it reports a conflict", async () => {
    expect(await moveGuardedLeaf(await request({ afterRename: async () => false }))).toBe(false);
    expect(await readFile(destination, "utf-8")).toBe("leaf bytes");
    expect(handleLog).toEqual(["handle-closed"]);
  });

  it("refuses a changed source, an existing destination and a rebound parent, leaving both paths as they were", async () => {
    const stale = { ...archive, identity: { dev: archive.identity.dev, ino: archive.identity.ino + 1 } };
    const wrongDigest = { ...(await request()).expect, sha256: leafDigest(Buffer.from("other bytes")) };
    expect(await moveGuardedLeaf(await request({ expect: wrongDigest }))).toBe(false);
    expect(await moveGuardedLeaf(await request({ maxBytes: 9 }))).toBe(false);
    expect(await moveGuardedLeaf(await request({ parents: { source: binding, destination: stale } }))).toBe(false);
    expect(await untouched()).toBe(true);
    expect((rename as unknown as Mock<typeof rename>)).not.toHaveBeenCalled();
    await writeFile(destination, "already archived", "utf-8");
    expect(await moveGuardedLeaf(await request())).toBe(false);
    expect([await readFile(source, "utf-8"), await readFile(destination, "utf-8")]).toEqual(["leaf bytes", "already archived"]);
    expect((rename as unknown as Mock<typeof rename>)).not.toHaveBeenCalled();
  });

  it("returns false and closes the handle when the rename fails, without copying", async () => {
    (rename as unknown as Mock<typeof rename>).mockRejectedValueOnce(Object.assign(new Error("EXDEV"), { code: "EXDEV" }));
    const afterRename = vi.fn(async () => true);
    expect(await moveGuardedLeaf(await request({ afterRename }))).toBe(false);
    expect(afterRename).not.toHaveBeenCalled();
    expect(await untouched()).toBe(true);
    expect(handleLog).toEqual(["handle-closed"]);
  });

  it("returns false and closes the handle when afterRename throws", async () => {
    expect(await moveGuardedLeaf(await request({ afterRename: async () => { throw new Error("observe failed"); } }))).toBe(false);
    expect(handleLog).toEqual(["handle-closed"]);
    expect(await readFile(destination, "utf-8")).toBe("leaf bytes");
  });

  it("is reached only after the candidate layer has captured its request: a malformed one still throws", async () => {
    const malformed = { root, fileId: "a", direction: "sideways", receipt: {} };
    await expect(moveCandidateWithCustody(malformed as never)).rejects.toBeInstanceOf(CandidateCustodyBoundaryError);
    expect(await untouched()).toBe(true);
    expect(handleLog).toEqual([]);
  });
});

describe("leafPresent and removeLeaf", () => {
  it("reports a file and a dangling link as present, an absent name as not, and rejects raw otherwise", async () => {
    await symlink(path.join(base, "nowhere"), path.join(queue, "dangling.json"));
    expect(await leafPresent(queue, "a.json")).toBe(true);
    expect(await leafPresent(queue, "dangling.json")).toBe(true);
    expect(await leafPresent(queue, "missing.json")).toBe(false);
    await expect(leafPresent(path.join(queue, "a.json"), "child.json"))
      .rejects.toMatchObject({ code: "ENOTDIR", syscall: "lstat" });
  });

  it("removes a leaf by path and rejects with the raw error when there is nothing to remove", async () => {
    await removeLeaf(path.join(queue, "a.json"));
    expect(await leafPresent(queue, "a.json")).toBe(false);
    await expect(removeLeaf(path.join(queue, "a.json")))
      .rejects.toMatchObject({ code: "ENOENT", syscall: "unlink", path: path.join(queue, "a.json") });
  });
});

describe("createLeafNoReplace and replaceLeafAtomic", () => {
  const fresh = (): string => path.join(queue, "fresh.json");

  it("runs afterParentCheck before the leaf exists and afterCommit once it does", async () => {
    const seen: string[] = [];
    await createLeafNoReplace({
      root, leaf: fresh(), text: "new leaf",
      afterParentCheck: async () => { seen.push(`check:${await leafPresent(queue, "fresh.json")}`); },
      afterCommit: async () => { seen.push(`commit:${await leafPresent(queue, "fresh.json")}`); },
    });
    expect(seen).toEqual(["check:false", "commit:true"]);
    expect(await readFile(fresh(), "utf-8")).toBe("new leaf");
  });

  it("never replaces an existing leaf: a collision rejects and the existing bytes stay", async () => {
    const collide = createLeafNoReplace({ root, leaf: path.join(queue, "a.json"), text: "usurper", afterParentCheck: async () => {} });
    await expect(collide).rejects.toBeInstanceOf(AtomicWriteCollisionError);
    expect(await readFile(path.join(queue, "a.json"), "utf-8")).toBe("leaf bytes");
  });

  it("aborts with the hook's own error, writing nothing, when afterParentCheck rejects", async () => {
    const refusal = new AtomicWriteCollisionError();
    const aborted = createLeafNoReplace({ root, leaf: fresh(), text: "new leaf", afterParentCheck: async () => { throw refusal; } });
    await expect(aborted).rejects.toBe(refusal);
    expect(await leafPresent(queue, "fresh.json")).toBe(false);
    expect((await readdir(queue)).sort()).toEqual(["a.json"]);
  });

  it("replaces a leaf's content whole and leaves no temp file beside it", async () => {
    await replaceLeafAtomic(root, path.join(queue, "a.json"), "replaced");
    expect(await readFile(path.join(queue, "a.json"), "utf-8")).toBe("replaced");
    expect(await readdir(queue)).toEqual(["a.json"]);
  });

  it("rejects raw for an unresolvable root and refuses a leaf outside the project, for both writers", async () => {
    const missingRoot = path.join(base, "no-project");
    const outside = path.join(base, "outside.json");
    const noHook = async (): Promise<void> => {};
    const raw = await rawRealpathError(missingRoot);
    expect(raw.code).toBe("ENOENT");
    await expect(replaceLeafAtomic(missingRoot, fresh(), "x")).rejects.toMatchObject(raw);
    await expect(createLeafNoReplace({ root: missingRoot, leaf: fresh(), text: "x", afterParentCheck: noHook }))
      .rejects.toMatchObject(raw);
    await expect(replaceLeafAtomic(root, outside, "x")).rejects.toThrow();
    await expect(createLeafNoReplace({ root, leaf: outside, text: "x", afterParentCheck: noHook })).rejects.toThrow();
    await expect(stat(outside)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
