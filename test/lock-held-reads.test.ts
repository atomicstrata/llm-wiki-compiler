/**
 * @file test/lock-held-reads.test.ts
 * @description Inside one lock-held section a repeat read is served from the
 * first; outside one every call reads; and a write through `atomicWrite` ends
 * the sharing, because the section's callback may be an embedder's that writes
 * what was read.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { atomicWrite } from "../src/utils/atomic-write.js";
import { readOncePerLockHold, withLockHeldReads } from "../src/utils/lock-held-reads.js";

let root: string;
let reads: number;

/** A read that counts itself and answers with its own ordinal. */
const countedRead = (): Promise<number> => readOncePerLockHold("probe", root, async () => ++reads);

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "lock-held-reads-")));
  reads = 0;
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("lock-held reads", () => {
  it("reads every time outside a section", async () => {
    await countedRead();
    await countedRead();
    expect(reads).toBe(2);
  });

  it("serves a repeat from the first read inside a section", async () => {
    const values = await withLockHeldReads(async () => [await countedRead(), await countedRead()]);
    expect(values).toEqual([1, 1]);
  });

  it("reads again after a write inside the section", async () => {
    const values = await withLockHeldReads(async () => {
      const before = await countedRead();
      await atomicWrite(path.join(root, "profile.yaml"), "changed\n");
      return [before, await countedRead()];
    });
    expect(values).toEqual([1, 2]);
  });
});
