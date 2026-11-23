/**
 * @file Archive journal publication faults on temporary indexed and pins directories.
 * Directory sync faults are scoped to a single fixture path and test.
 *
 * Writing-only replay: a process stop after the create-only writer opened
 * `archive.json.writing` but before it linked `.tmp` leaves only that scratch.
 * No thrown fault can leave it (the writer's own catch removes the scratch), so
 * it is CONSTRUCTED as an exclusive 0600 file holding a prefix of the exact
 * writer bytes. The retry discards only such a proved prefix and publishes
 * afresh; a foreign, wrong-mode, aliased, over-long or symlinked scratch, and any
 * scratch beside a leaf without a replay route, refuses and stays byte for byte.
 */
import { expect, spyOn, test } from "bun:test";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { prepareArchiveLeaf } from "../../src/scale/downgrade-archive.js";
import { identityAt } from "../../src/scale/downgrade-fs.js";
import { readArchiveLeaf, recordArchiveLeaf, recordStage } from "../../src/scale/downgrade-journal.js";
import * as durability from "../../src/utils/atomic-write-durability.js";

const plan = "a".repeat(64);
const dir = ".llmwiki/scale-downgrade/8-aaaaaaaaaaaa";
const indexedPath = ".llmwiki/indexed";
const pinsPath = ".llmwiki/indexed-pins";
const failure = "injected archive ready-link directory sync failure";

/** A path-specific sync fault immediately after the real writer links its ready name. */
function injectReadyFault(file: string, linked = false) {
  const realSync = durability.fsyncDirectoryChain;
  return spyOn(durability, "fsyncDirectoryChain").mockImplementation((parent, binding, before, scope) =>
    realSync(parent, binding, async (entry) => {
      await before?.(entry);
      if (entry !== path.dirname(file)) return;
      const destination = await identityAt(path.dirname(file), path.basename(file));
      if ((destination !== null) === linked) throw new Error(failure);
    }, scope));
}

/** The archive caller derives its expected identities from still-live regular directories. */
async function createInputs(root: string) {
  await mkdir(path.join(root, dir), { recursive: true });
  await mkdir(path.join(root, indexedPath));
  await mkdir(path.join(root, pinsPath));
  const indexed = await identityAt(root, indexedPath);
  const pins = await identityAt(root, pinsPath);
  if (indexed?.kind !== "directory" || pins?.kind !== "directory") throw new Error("missing archive inputs");
  return { plan, indexed, pins };
}

/** Show the exact ready pair, then exercise the same journal replay with fresh in-place identities. */
test("replays a positively bound archive ready pair before any move", async () => {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), "archive-ready-"));
  try {
    const input = await createInputs(root);
    const target = path.join(root, dir, "archive.json");
    const seam = injectReadyFault(target);
    try {
      await expect(recordArchiveLeaf(root, dir, input)).rejects.toThrow(failure);
    } finally {
      seam.mockRestore();
    }
    expect(await readArchiveLeaf(root, dir, plan)).toBeNull();
    const ready = await lstat(target + ".tmp", { bigint: true });
    expect(ready.nlink).toBe(2n);
    expect((await lstat(target + ".writing", { bigint: true })).ino).toBe(ready.ino);
    expect(await readFile(target + ".tmp", "utf8")).toBe(JSON.stringify({ format: "llmwiki-scale-downgrade-archive", version: 1, ...input }) + "\n");
    const indexed = await identityAt(root, indexedPath);
    const pins = await identityAt(root, pinsPath);
    expect({ indexed, pins }).toEqual({ indexed: input.indexed, pins: input.pins });
    expect(await identityAt(root, dir + "/indexed")).toBeNull();
    expect(await identityAt(root, dir + "/indexed-pins")).toBeNull();
    await recordArchiveLeaf(root, dir, input);
    expect((await lstat(target, { bigint: true })).ino).toBe(ready.ino);
    expect((await lstat(target, { bigint: true })).nlink).toBe(1n);
    expect(await readArchiveLeaf(root, dir, plan)).toMatchObject(input);
  } finally {
    await rm(root, { recursive: true });
  }
});

/** Stop the real prepare path at a publication checkpoint without reaching archive moves. */
async function interruptPrepare(root: string, linked: boolean) {
  const target = path.join(root, dir, "archive.json");
  const seam = injectReadyFault(target, linked);
  try {
    await expect(prepareArchiveLeaf(root, dir, plan)).rejects.toThrow(failure);
  } finally {
    seam.mockRestore();
  }
  return target;
}

/** The strict reader stays strict; prepare can recover before either source moves. */
test.each([[false], [true]])("prepares the archive on its original inode with destination linked=%s", async (linked) => {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), "archive-prepare-"));
  try {
    const inputs = await createInputs(root);
    const target = await interruptPrepare(root, linked);
    const ready = await lstat(target + ".tmp", { bigint: true });
    if (linked) await expect(readArchiveLeaf(root, dir, plan)).rejects.toMatchObject({ code: "scale_downgrade_partial" });
    else expect(await readArchiveLeaf(root, dir, plan)).toBeNull();
    expect(await prepareArchiveLeaf(root, dir, plan)).toMatchObject(inputs);
    expect(await readArchiveLeaf(root, dir, plan)).toMatchObject(inputs);
    expect((await lstat(target, { bigint: true })).ino).toBe(ready.ino);
    expect((await lstat(target)).nlink).toBe(1);
    await expect(lstat(target + ".tmp")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(target + ".writing")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await identityAt(root, indexedPath)).toEqual(inputs.indexed);
    expect(await identityAt(root, pinsPath)).toEqual(inputs.pins);
    expect(await identityAt(root, dir + "/indexed")).toBeNull();
    expect(await identityAt(root, dir + "/indexed-pins")).toBeNull();
  } finally {
    await rm(root, { recursive: true });
  }
});

/** Refuse unknown target state or stale source identity without touching the prepared bytes. */
test.each([[false], [true]])("retains archive scratch on a move or identity conflict, linked=%s", async (linked) => {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), "archive-conflict-"));
  try {
    await createInputs(root);
    const target = await interruptPrepare(root, linked);
    const alias = target + ".tmp";
    const ready = await lstat(alias, { bigint: true });
    const body = await readFile(alias);
    const from = path.join(root, indexedPath);
    const to = path.join(root, dir, "indexed");
    await rename(from, to);
    await expect(prepareArchiveLeaf(root, dir, plan)).rejects.toThrow("targets must both be absent");
    expect((await lstat(alias, { bigint: true })).ino).toBe(ready.ino);
    await rename(to, from + "-retained");
    await mkdir(from);
    await expect(prepareArchiveLeaf(root, dir, plan)).rejects.toMatchObject({ code: "scale_downgrade_partial" });
    expect((await lstat(alias, { bigint: true })).nlink).toBe(ready.nlink);
    expect(await readFile(alias)).toEqual(body);
    if (linked) expect((await lstat(target, { bigint: true })).ino).toBe(ready.ino);
    else await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true });
  }
});

/** An exact committed inode with a different temp name must not authorize cleanup. */
test("preserves a foreign replacement of the archive alias", async () => {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), "archive-foreign-"));
  try {
    await createInputs(root);
    const target = await interruptPrepare(root, true);
    await unlink(target + ".tmp");
    await link(target, target + ".foreign");
    await writeFile(target + ".tmp", "foreign", { mode: 0o600 });
    await expect(prepareArchiveLeaf(root, dir, plan)).rejects.toMatchObject({ code: "scale_downgrade_partial" });
    expect(await readFile(target + ".tmp", "utf8")).toBe("foreign");
    expect((await lstat(target)).nlink).toBe(2);
    expect((await lstat(target + ".foreign")).ino).toBe((await lstat(target)).ino);
  } finally {
    await rm(root, { recursive: true });
  }
});

/** A settled journal remains usable after the sources have already moved. */
test("keeps the original settled archive journal after both directories moved", async () => {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), "archive-settled-"));
  try {
    const inputs = await createInputs(root);
    const leaf = await prepareArchiveLeaf(root, dir, plan);
    const target = path.join(root, dir, "archive.json");
    const before = await lstat(target, { bigint: true });
    await rename(path.join(root, indexedPath), path.join(root, dir, "indexed"));
    await rename(path.join(root, pinsPath), path.join(root, dir, "indexed-pins"));
    expect(await prepareArchiveLeaf(root, dir, plan)).toEqual(leaf);
    expect(await readArchiveLeaf(root, dir, plan)).toMatchObject(inputs);
    expect((await lstat(target, { bigint: true })).ino).toBe(before.ino);
    expect(await identityAt(root, indexedPath)).toBeNull();
    expect(await identityAt(root, pinsPath)).toBeNull();
  } finally {
    await rm(root, { recursive: true });
  }
});

/** A fresh archive root, its live inputs, the journal path and the exact bytes its writer produces. */
async function writingRoot() {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), "archive-writing-"));
  const inputs = await createInputs(root);
  const bytes = Buffer.from(JSON.stringify({ format: "llmwiki-scale-downgrade-archive", version: 1, ...inputs }) + "\n");
  return { root, inputs, target: path.join(root, dir, "archive.json"), bytes };
}

/** Leave `body` at the exact writing name, created exclusively with `mode`, as a stopped writer would. */
async function plantWriting(target: string, body: Buffer, mode = 0o600): Promise<string> {
  const writing = target + ".writing";
  await writeFile(writing, body, { flag: "wx", mode });
  await chmod(writing, mode);
  return writing;
}

/** Require the scratch to be kept exactly and nothing to be published beside it. */
async function expectKept(target: string, scratch: string, body: Buffer, ino: bigint): Promise<void> {
  expect((await lstat(scratch, { bigint: true })).ino).toBe(ino);
  expect(await readFile(scratch)).toEqual(body);
  await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(lstat(target + ".tmp")).rejects.toMatchObject({ code: "ENOENT" });
}

/** Empty, partial and complete prefixes are all positively this publication's bytes. */
test.each([["empty", 0], ["partial", 0.5], ["complete", 1]])("replays a writing-only %s prefix before any move", async (_label, fraction) => {
  const { root, inputs, target, bytes } = await writingRoot();
  try {
    const writing = await plantWriting(target, bytes.subarray(0, Math.floor(bytes.length * fraction)));
    expect(await prepareArchiveLeaf(root, dir, plan)).toMatchObject(inputs);
    expect(await readFile(target)).toEqual(bytes);
    expect((await lstat(target)).nlink).toBe(1);
    expect((await lstat(target)).mode & 0o7777).toBe(0o600);
    await expect(lstat(writing)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(target + ".tmp")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readArchiveLeaf(root, dir, plan)).toMatchObject(inputs);
    expect(await identityAt(root, dir + "/indexed")).toBeNull();
  } finally {
    await rm(root, { recursive: true });
  }
});

/** Each scratch the retry cannot prove is this publication's own prefix. */
const UNPROVED: ReadonlyArray<[string, (bytes: Buffer) => Buffer, number]> = [
  ["foreign bytes", () => Buffer.from("{\"foreign\":true}\n"), 0o600],
  ["a wrong mode", (bytes) => bytes.subarray(0, 8), 0o644],
  ["over-long bytes", (bytes) => Buffer.concat([bytes, Buffer.from("x")]), 0o600],
];

/** Wrong content, wrong mode and growth past the exact value refuse and keep the scratch. */
test.each(UNPROVED)("keeps a writing-only scratch with %s", async (_label, bodyOf, mode) => {
  const { root, target, bytes } = await writingRoot();
  try {
    const body = bodyOf(bytes);
    const writing = await plantWriting(target, body, mode);
    const ino = (await lstat(writing, { bigint: true })).ino;
    await expect(prepareArchiveLeaf(root, dir, plan)).rejects.toMatchObject({ code: "scale_downgrade_partial" });
    await expectKept(target, writing, body, ino);
  } finally {
    await rm(root, { recursive: true });
  }
});

/** A second link at a foreign name means the inode is not exclusively this scratch. */
test("keeps a writing-only prefix that has a foreign alias", async () => {
  const { root, target, bytes } = await writingRoot();
  try {
    const body = bytes.subarray(0, 4);
    const writing = await plantWriting(target, body);
    await link(writing, target + ".foreign");
    const ino = (await lstat(writing, { bigint: true })).ino;
    await expect(prepareArchiveLeaf(root, dir, plan)).rejects.toMatchObject({ code: "scale_downgrade_partial" });
    await expectKept(target, writing, body, ino);
    expect((await lstat(target + ".foreign", { bigint: true })).ino).toBe(ino);
  } finally {
    await rm(root, { recursive: true });
  }
});

/** The scratch name must itself be the regular file: a symlink to exact bytes is never followed or removed. */
test("keeps a symlink at the writing name", async () => {
  const { root, target, bytes } = await writingRoot();
  try {
    const elsewhere = path.join(root, "elsewhere.json");
    await writeFile(elsewhere, bytes, { mode: 0o600 });
    await symlink(elsewhere, target + ".writing");
    await expect(prepareArchiveLeaf(root, dir, plan)).rejects.toMatchObject({ code: "scale_downgrade_partial" });
    expect(await readlink(target + ".writing")).toBe(elsewhere);
    expect(await readFile(elsewhere)).toEqual(bytes);
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true });
  }
});

/** A leaf that does not opt into replay keeps refusing any reserved scratch, even an empty one. */
test("keeps writing scratch beside a stage leaf that has no replay route", async () => {
  const { root } = await writingRoot();
  try {
    const target = path.join(root, dir, "attempt-1", "stage.json");
    await mkdir(path.dirname(target));
    const writing = await plantWriting(target, Buffer.alloc(0));
    const ino = (await lstat(writing, { bigint: true })).ino;
    await expect(recordStage(root, dir, { plan, attempt: 1, units: [], priors: [] })).rejects.toThrow("unproved publication scratch");
    await expectKept(target, writing, Buffer.alloc(0), ino);
  } finally {
    await rm(root, { recursive: true });
  }
});
