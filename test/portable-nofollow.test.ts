/** Missing native no-follow support must not permit symlink reads or appends. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readCappedNoFollow } from "../src/utils/confined-read.js";
import { openGraphFileAppend } from "../src/utils/jsonl-store.js";

// Exercise the unavailable-capability branch with real files; this is not a Windows runner.
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, constants: { ...fs.constants, O_NOFOLLOW: undefined, O_NONBLOCK: undefined, O_DIRECTORY: undefined } };
});

const race = vi.hoisted(() => ({
  beforeOpen: undefined as (() => Promise<void>) | undefined,
  afterOpen: undefined as (() => Promise<void>) | undefined,
}));
vi.mock("fs/promises", async (original) => {
  const fs = await original<typeof import("fs/promises")>();
  return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const hook = race.beforeOpen;
    race.beforeOpen = undefined;
    await hook?.();
    const handle = await fs.open(...args);
    const after = race.afterOpen;
    race.afterOpen = undefined;
    try { await after?.(); } catch (err) { await handle.close(); throw err; }
    return handle;
  } };
});

let root: string;
beforeEach(async () => {
  race.beforeOpen = undefined;
  race.afterOpen = undefined;
  root = await mkdtemp(path.join(tmpdir(), "portable-nofollow-"));
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

/** Exercise the store consumer, closing its handle even when a guard is missing. */
async function append(file: string): Promise<void> {
  const handle = await openGraphFileAppend(file, (message) => new Error(message));
  try { await handle.writeFile("entry\n"); } finally { await handle.close(); }
}

it("refuses a symlinked read leaf when the native flag is unavailable", async () => {
  const target = path.join(root, "target");
  const link = path.join(root, "link");
  await writeFile(target, "must not read");
  await symlink(target, link, "file");
  expect(await readCappedNoFollow(link, 1024)).toEqual({ kind: "unavailable" });
});

it("refuses append through a symlink without changing its target", async () => {
  const target = path.join(root, "target");
  const link = path.join(root, "link");
  await writeFile(target, "original");
  await symlink(target, link, "file");
  await expect(append(link)).rejects.toThrow();
  expect(await readFile(target, "utf8")).toBe("original");
});

it("still creates, appends, and reads ordinary files without native no-follow", async () => {
  const file = path.join(root, "ordinary");
  await append(file);
  await append(file);
  expect(await readCappedNoFollow(file, 1024)).toEqual({ kind: "ok", body: "entry\nentry\n" });
  expect(await readCappedNoFollow(path.join(root, "absent"), 1024)).toEqual({ kind: "absent" });
});

it("rejects a different regular file substituted between precheck and open", async () => {
  const file = path.join(root, "leaf");
  const replacement = path.join(root, "replacement");
  await writeFile(file, "original");
  await writeFile(replacement, "untrusted replacement");
  race.beforeOpen = async () => { await rename(replacement, file); };
  expect(await readCappedNoFollow(file, 1024)).toEqual({ kind: "unavailable" });
});

it("never creates an absent append target through a raced-in symlink", async () => {
  const target = path.join(root, "target");
  const file = path.join(root, "new-store");
  await writeFile(target, "original");
  race.beforeOpen = async () => { await symlink(target, file, "file"); };
  await expect(append(file)).rejects.toThrow();
  expect(await readFile(target, "utf8")).toBe("original");
});

it("does not create an outside file through a raced-in dangling symlink", async () => {
  const outside = path.join(root, "must-not-exist");
  const file = path.join(root, "new-store");
  race.beforeOpen = async () => { await symlink(outside, file, "file"); };
  await expect(append(file)).rejects.toThrow();
  await expect(readFile(outside)).rejects.toMatchObject({ code: "ENOENT" });
});

it("rejects a path replaced after the handle opens", async () => {
  const file = path.join(root, "leaf");
  const replacement = path.join(root, "replacement");
  await writeFile(file, "original");
  await writeFile(replacement, "replacement");
  race.afterOpen = async () => { await rename(replacement, file); };
  expect(await readCappedNoFollow(file, 1024)).toEqual({ kind: "unavailable" });
});

it("retries an exclusive-create collision with an ordinary file safely", async () => {
  const file = path.join(root, "new-store");
  race.beforeOpen = async () => { await writeFile(file, "other writer\n"); };
  await append(file);
  expect(await readFile(file, "utf8")).toBe("other writer\nentry\n");
});
