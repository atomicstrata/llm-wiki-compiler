/**
 * @file test/storage/product-install-activation-io.test.ts
 * @description The product install and activation journeys through their REAL
 * callers (`installLocalProductPackage`, `measureProductPackageStore`,
 * `activateProductLocked`) after their physical work moved into `src/storage/`.
 * One narrow recorder wraps seven `fs/promises` calls, the directory `sync`,
 * and the two incumbent atomic writers: it records each call by a short key,
 * can make one fail, and can run one hook after a directory listing returns.
 * Files, the project lock and the package store are real.
 *
 * These cases pin only what the move could silently change: the order of the
 * staging steps and their modes, the EXACT options object each writer is
 * handed, cleanup in `finally` and its swallowed failures, what a failing
 * directory sync and a colliding rename do, and that the store sizes an entry
 * WITHOUT following a link. Injected error codes show how the code reacts to
 * them; they are not observations of a real filesystem or of durability.
 */

import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";

type Planted = Error | { thenFail: Error };
const io = {
  calls: [] as string[],
  writes: [] as Array<{ writer: string; leaf: string; opts: Record<string, unknown> }>,
  fail: new Map<string, Planted>(),
  afterListing: null as null | ((dir: string) => Promise<void>),
  createOnlyDone: 0,
  failSyncAfterWrites: null as null | { leaves: number; dir: string; error: Error },
  /** A short, run-independent name for a path: its last segment, with random and digest names replaced. */
  label: (file: unknown): string => {
    const name = String(file).slice(String(file).lastIndexOf("/") + 1);
    if (/^[0-9a-f]{32}$/u.test(name)) return "<token>";
    if (/^[0-9a-f]{64}(\.json)?$/u.test(name)) return name.endsWith(".json") ? "<digest>.json" : "<digest>";
    return name.startsWith("llmwiki-product-") && name.length > "llmwiki-product-".length ? "llmwiki-product-*" : name;
  },
};

// Copy the real modules first: vi.mock patches them in place, so a later read would see the mock.
const realFsPromises = { ...(await import("node:fs/promises")) };
const realUtilsAtomicWrite = { ...(await import("../../src/utils/atomic-write.js")) };

vi.mock("node:fs/promises", async () => {
  const actual = realFsPromises;
  const real = actual as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  /** Record one call; a planted failure rejects, optionally AFTER the real call has been made. */
  const traced = (name: string) => async (...args: unknown[]): Promise<unknown> => {
    const mode = (args.at(-1) as { mode?: number } | undefined)?.mode;
    const key = `${name} ${io.label(args[0])}`;
    io.calls.push(mode === undefined ? key : `${key} mode=${mode.toString(8)}`);
    const planted = io.fail.get(key);
    if (planted instanceof Error) throw planted;
    const result = await real[name]!(...args);
    if (planted) throw planted.thenFail;
    if (name === "readdir") await io.afterListing?.(String(args[0]));
    return result;
  };
  const open = async (...args: unknown[]): Promise<unknown> => {
    const handle = await real.open!(...args) as { sync: () => Promise<void> };
    const armed = io.failSyncAfterWrites;
    if (args[1] !== "r" || armed === null || io.createOnlyDone < armed.leaves || io.label(args[0]) !== armed.dir) return handle;
    io.failSyncAfterWrites = null;
    handle.sync = async () => { throw armed.error; };
    return handle;
  };
  const wrapped = Object.fromEntries(["mkdtemp", "lstat", "readdir", "mkdir", "writeFile", "rm", "rename"].map((name) => [name, traced(name)]));
  return { ...actual, ...wrapped, open, default: { ...actual, ...wrapped, open } };
});

vi.mock("../../src/utils/atomic-write.js", async () => {
  const actual = realUtilsAtomicWrite;
  type Writer = (leaf: string, content: string | Uint8Array, opts?: object) => Promise<void>;
  const traced = (writer: "atomicWrite" | "atomicWriteNoReplaceDurable"): Writer => async (leaf, content, opts) => {
    const key = `${writer} ${io.label(leaf)}`;
    io.calls.push(key);
    io.writes.push({ writer, leaf: io.label(leaf), opts: { ...opts } });
    const planted = io.fail.get(key);
    if (planted instanceof Error) throw planted;
    await (actual[writer] as Writer)(leaf, content, opts);
    if (writer === "atomicWriteNoReplaceDurable") io.createOnlyDone += 1;
  };
  return { ...actual, atomicWrite: traced("atomicWrite"), atomicWriteNoReplaceDurable: traced("atomicWriteNoReplaceDurable") };
});

import { activateProductLocked } from "../../src/products/binding/activate.js";
import { digestDirectoryName } from "../../src/products/ids.js";
import { installLocalProductPackage } from "../../src/products/packages/install.js";
import { measureProductPackageStore } from "../../src/products/packages/store.js";
import { productStorePaths } from "../../src/products/paths.js";
import { useTempRoot } from "../fixtures/temp-root.js";
import { FIXTURE_PRINCIPAL, buildActivatableProduct } from "../products/binding-fixture.js";
import { writeSourcePackage } from "../products/product-package-fixture.js";

const fs = realFsPromises;
const PRODUCT = buildActivatableProduct();
const HEX = digestDirectoryName(PRODUCT.manifest.packageDigest);
const MEMBERS = PRODUCT.manifest.members.length;
const root = useTempRoot();
let scratch = "";
let source = "";
let systemTemp: string | undefined;
const withCode = (code: string): Error => Object.assign(new Error(`${code}: sabotaged`), { code });
const store = () => productStorePaths(root.dir);
const install = () => installLocalProductPackage(root.dir, source);
const activate = (options = {}) => activateProductLocked(root.dir, PRODUCT.manifest.packageDigest, FIXTURE_PRINCIPAL, options);
const leftovers = async (): Promise<string[]> => [...await fs.readdir(scratch), ...await fs.readdir(store().tmpRoot).catch(() => [])];

beforeEach(async () => {
  scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "llmwiki-install-io-")));
  source = await writeSourcePackage(path.join(`${scratch}-src`, "pkg-src"), PRODUCT);
  systemTemp = process.env.TMPDIR;
  process.env.TMPDIR = scratch;
  Object.assign(io, { calls: [], writes: [], afterListing: null, createOnlyDone: 0, failSyncAfterWrites: null });
  io.fail.clear();
});
afterEach(async () => {
  // Assigning `undefined` to an environment key stores the string "undefined"; an absent TMPDIR must be restored by deleting it.
  if (systemTemp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = systemTemp;
  await fs.rm(scratch, { recursive: true, force: true });
  await fs.rm(`${scratch}-src`, { recursive: true, force: true });
});

describe("install: staging, commit, receipt, cleanup", () => {
  it("stages owner-only, commits, writes the receipt, then removes the staging directory", async () => {
    expect((await install()).status).toBe("installed");
    const staged = io.calls.filter((call) => call.includes("mode=") || /^(mkdtemp|rm llmwiki|lstat pkg-src|atomicWrite)/u.test(call));
    expect(staged).toEqual([
      "mkdtemp llmwiki-product-", "lstat pkg-src", "writeFile manifest.json mode=600", "mkdir members mode=700",
      ...Array.from({ length: MEMBERS }, () => "writeFile <digest> mode=600"),
      "atomicWriteNoReplaceDurable manifest.json", ...Array.from({ length: MEMBERS }, () => "atomicWriteNoReplaceDurable <digest>"),
      "atomicWrite <digest>.json", "rm llmwiki-product-*",
    ]);
    expect(await leftovers()).toEqual([]);
  });

  it("hands each writer exactly the options object the caller wrote", async () => {
    await install();
    const createOnly = io.writes.filter((write) => write.writer === "atomicWriteNoReplaceDurable");
    expect(createOnly).toHaveLength(MEMBERS + 1);
    for (const write of createOnly) expect(write.opts).toStrictEqual({ confineRoot: root.dir, exactParent: true, mode: 0o600 });
    const receipt = io.writes.find((write) => write.leaf === "<digest>.json");
    expect(receipt?.opts).toStrictEqual({ confineRoot: root.dir, durable: true });
  });

  it("leaves no staging directory and no temp tree after a refused source or a failed commit", async () => {
    const [memberHex] = [...PRODUCT.bytesByHex.keys()];
    io.fail.set("rename <token>", withCode("EACCES"));
    await expect(install()).rejects.toMatchObject({ code: "EACCES" });
    expect(await leftovers()).toEqual([]);
    await fs.writeFile(path.join(source, "members", memberHex!), "corrupt");
    await expect(install()).rejects.toThrow();
    expect(await leftovers()).toEqual([]);
  });

  it("swallows a failing cleanup of the staging directory and of the temp tree", async () => {
    io.fail.set("rm llmwiki-product-*", withCode("EPERM"));
    io.fail.set("rm <token>", withCode("EPERM"));
    expect((await install()).status).toBe("installed");
    expect(io.calls.filter((call) => call.startsWith("rm "))).toEqual(["rm <token>", "rm llmwiki-product-*"]);
  });

  it("commits through a tolerated directory-sync failure and fails on any other", async () => {
    io.failSyncAfterWrites = { leaves: MEMBERS + 1, dir: "members", error: withCode("EINVAL") };
    expect((await install()).status).toBe("installed");
    expect(io.failSyncAfterWrites).toBeNull();
    await fs.rm(path.join(root.dir, ".llmwiki"), { recursive: true, force: true });
    const failure = withCode("EIO");
    Object.assign(io, { createOnlyDone: 0, failSyncAfterWrites: { leaves: MEMBERS + 1, dir: "members", error: failure } });
    await expect(install()).rejects.toBe(failure);
    expect(await leftovers()).toEqual([]);
  });

  it("converges when the rename collides with a valid package, and rejects raw otherwise", async () => {
    io.fail.set("rename <token>", { thenFail: withCode("ENOTEMPTY") });
    expect((await install()).status).toBe("already-present");
    await fs.rm(path.join(root.dir, ".llmwiki"), { recursive: true, force: true });
    const failure = withCode("EACCES");
    io.fail.set("rename <token>", failure);
    await expect(install()).rejects.toBe(failure);
  });

  it("reports a rejected receipt write as provenance unavailable, with the package installed and no binding", async () => {
    io.fail.set("atomicWrite <digest>.json", withCode("EIO"));
    expect(await install()).toMatchObject({ status: "installed", receiptWritten: false });
    expect(await fs.readdir(path.join(root.dir, ".llmwiki"))).not.toContain("active-product.json");
  });
});

describe("store capacity: sizes are read without following a link", () => {
  it("counts a link's own size when a listed regular file becomes a link before it is sized", async () => {
    await install();
    const measured = (await measureProductPackageStore(root.dir)).totalBytes;
    const victim = store().manifestFile(HEX);
    const large = path.join(scratch, "large.bin");
    await fs.writeFile(large, Buffer.alloc(8192));
    const victimBytes = (await fs.stat(victim)).size;
    io.afterListing = async (dir) => {
      if (dir !== path.dirname(victim)) return;
      io.afterListing = null;
      await fs.rm(victim);
      await fs.symlink(large, victim);
    };
    const swapped = (await measureProductPackageStore(root.dir)).totalBytes;
    expect(swapped).toBe(measured - victimBytes + Buffer.byteLength(large));
  });

  it("skips an entry that is already a link when it is listed (the directory-entry test, not the size read)", async () => {
    await install();
    const measured = (await measureProductPackageStore(root.dir)).totalBytes;
    await fs.symlink(store().manifestFile(HEX), path.join(store().storeRoot, "planted-link"));
    expect((await measureProductPackageStore(root.dir)).totalBytes).toBe(measured);
  });
});

describe("activation: the binding write", () => {
  it("runs the caller's hooks around one strict write, with a seam key only when that seam was supplied", async () => {
    await install();
    const order = (name: string) => async (): Promise<void> => { io.calls.push(name); };
    await activate({ faults: { beforeWrite: order("beforeWrite"), afterWrite: order("afterWrite"), beforeParentSync: order("beforeParentSync") } });
    const binding = io.writes.find((write) => write.leaf === "active-product.json");
    expect(Object.keys(binding!.opts).sort()).toEqual(["beforeDirectorySyncForTest", "confineRoot", "durable", "exactParent", "mode", "strictDurability"]);
    expect(binding!.opts).toMatchObject({ confineRoot: root.dir, exactParent: true, durable: true, strictDurability: true, mode: 0o600 });
    const steps = io.calls.filter((call) => /^(beforeWrite|afterWrite|atomicWrite active)/u.test(call));
    expect(steps).toEqual(["beforeWrite", "atomicWrite active-product.json", "afterWrite"]);
  });

  it("passes only the five flags when no seam is supplied, and replaces an existing binding in place", async () => {
    await install();
    await activate({ activatedAt: "2026-01-01T00:00:00.000Z" });
    await activate({ activatedAt: "2026-01-02T00:00:00.000Z" });
    const bindings = io.writes.filter((write) => write.leaf === "active-product.json");
    expect(bindings.map((write) => Object.keys(write.opts).sort())).toEqual(
      Array.from({ length: 2 }, () => ["confineRoot", "durable", "exactParent", "mode", "strictDurability"]));
    const leaves = (await fs.readdir(path.join(root.dir, ".llmwiki"))).filter((name) => name.includes("active-product"));
    expect(leaves).toEqual(["active-product.json"]);
  });
});
