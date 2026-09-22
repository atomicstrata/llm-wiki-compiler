/**
 * @file Bounded-read regressions for durable create-only collision and recovery.
 * @description A regular inode may grow after an initial fstat. These tests
 * intercept FileHandle reads to prove both durable paths read no more than the
 * expected bytes plus one sentinel byte and refuse the changed inode.
 */

import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AtomicWriteCollisionError,
  AtomicWriteCommittedCleanupError,
  atomicWriteNoReplaceDurable,
} from "../src/utils/atomic-write.js";
import { useTempRoot } from "./fixtures/temp-root.js";

let growAfterStat: (() => Promise<void>) | undefined;
let readRequests: number[] = [];
let unboundedReadCalls = 0;
let positionalReadLimit: number | undefined;

/** Instrument each opened handle without changing the filesystem implementation. */
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return Object.assign({}, actual, {
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const stat = handle.stat.bind(handle);
      const read = handle.read.bind(handle);
      handle.stat = (async (...statArgs: unknown[]) => {
        const result = await (stat as (...values: unknown[]) => Promise<unknown>)(...statArgs);
        await growAfterStat?.();
        return result;
      }) as typeof handle.stat;
      handle.read = (async (...readArgs: unknown[]) => {
        readRequests.push(Number(readArgs[2]));
        const limitedArgs = [...readArgs];
        limitedArgs[2] = Math.min(Number(readArgs[2]), positionalReadLimit ?? Number(readArgs[2]));
        return (read as (...values: unknown[]) => Promise<unknown>)(...limitedArgs);
      }) as typeof handle.read;
      handle.readFile = (async () => {
        unboundedReadCalls += 1;
        throw new Error("unbounded FileHandle.readFile is forbidden");
      }) as typeof handle.readFile;
      return handle;
    },
  });
});

const root = useTempRoot();
const CONTENT = Buffer.from("body");

afterEach(() => {
  growAfterStat = undefined;
  readRequests = [];
  unboundedReadCalls = 0;
  positionalReadLimit = undefined;
  vi.restoreAllMocks();
});

describe("durable no-replace growing inode reads", () => {
  it("bounds an existing collision read and refuses the grown inode", async () => {
    const target = await writeGrowingTarget("collision");
    growAfterStat = appendOnce(target);

    await expect(atomicWriteNoReplaceDurable(target, CONTENT, {
      confineRoot: root.dir,
    })).rejects.toBeInstanceOf(AtomicWriteCollisionError);

    expect(readRequests).toEqual([CONTENT.byteLength + 1]);
    expect(unboundedReadCalls).toBe(0);
    expect(await readFile(target)).toEqual(Buffer.from("body!"));
  });

  it("bounds a ready-temp recovery read and preserves the grown alias", async () => {
    const target = path.join(root.dir, "ready-recovery", "record");
    const temporary = `${target}.tmp`;
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(temporary, CONTENT);
    growAfterStat = appendOnce(temporary);

    const failure = await atomicWriteNoReplaceDurable(target, CONTENT, {
      confineRoot: root.dir,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AtomicWriteCommittedCleanupError);
    expect((failure as AtomicWriteCommittedCleanupError).cause).toMatchObject({
      message: expect.stringMatching(/durable temp bytes conflict/),
    });
    expect(readRequests).toEqual([CONTENT.byteLength + 1]);
    expect(unboundedReadCalls).toBe(0);
    expect(await readFile(temporary)).toEqual(Buffer.from("body!"));
    await expect(readFile(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("syncs an exact existing collision after deterministic short positional reads", async () => {
    const target = await writeGrowingTarget("short-collision");
    positionalReadLimit = 2;
    let synced = false;

    await expect(atomicWriteNoReplaceDurable(target, CONTENT, {
      confineRoot: root.dir,
      beforeExistingFileSyncForTest: async () => { synced = true; },
    })).rejects.toBeInstanceOf(AtomicWriteCollisionError);

    expect(synced).toBe(true);
    expect(readRequests).toEqual([CONTENT.byteLength + 1, 3, 1]);
    expect(unboundedReadCalls).toBe(0);
  });

  it("recovers an exact ready temp after deterministic short positional reads", async () => {
    const target = path.join(root.dir, "short-ready-recovery", "record");
    const temporary = `${target}.tmp`;
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(temporary, CONTENT);
    positionalReadLimit = 2;

    await atomicWriteNoReplaceDurable(target, CONTENT, { confineRoot: root.dir });

    expect(readRequests).toEqual([CONTENT.byteLength + 1, 3, 1]);
    expect(unboundedReadCalls).toBe(0);
    expect(await readFile(target)).toEqual(CONTENT);
    expect(await readdir(path.dirname(target))).toEqual(["record"]);
  });
});

/** Create one pre-existing regular collision leaf with the exact expected bytes. */
async function writeGrowingTarget(name: string): Promise<string> {
  const target = path.join(root.dir, name, "record");
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, CONTENT);
  return target;
}

/** Return a one-shot hook that grows the exact regular inode after fstat returns. */
function appendOnce(filePath: string): () => Promise<void> {
  let appended = false;
  return async () => {
    if (appended) return;
    appended = true;
    await appendFile(filePath, "!");
  };
}
