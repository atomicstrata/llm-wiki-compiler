/**
 * @file test/storage/shared-page-reads.test.ts
 * @description Contract of the read-sharing window compile's tail opens around
 * index, MOC and embeddings regeneration: inside it, one read per page is
 * shared by every ask; outside it, and in a later window, every ask reads.
 */

import { describe, expect, it } from "bun:test";
import { sharedPageRead, withSharedPageReads } from "../../src/storage/shared-page-reads.js";
import type { ConfinedReadResult } from "../../src/storage/legacy-local-reads.js";

/** A page reader that counts its calls and answers with the call number. */
function countingRead(): { read: () => Promise<ConfinedReadResult>; calls: () => number } {
  let calls = 0;
  return { read: async () => ({ content: `read ${++calls}` }), calls: () => calls };
}

describe("sharedPageRead", () => {
  it("reads every time outside a window", async () => {
    const page = countingRead();
    await sharedPageRead("/w/concepts", "a.md", page.read);
    await sharedPageRead("/w/concepts", "a.md", page.read);
    expect(page.calls()).toBe(2);
  });

  it("shares one read per page inside a window, across awaits", async () => {
    const page = countingRead();
    const results = await withSharedPageReads(async () => {
      const first = await sharedPageRead("/w/concepts", "a.md", page.read);
      await Promise.resolve();
      const second = await sharedPageRead("/w/concepts", "a.md", page.read);
      return [first, second];
    });
    expect(page.calls()).toBe(1);
    expect(results).toEqual([{ content: "read 1" }, { content: "read 1" }]);
  });

  it("keys on directory and name, and starts each window empty", async () => {
    const page = countingRead();
    await withSharedPageReads(async () => {
      await sharedPageRead("/w/concepts", "a.md", page.read);
      await sharedPageRead("/w/queries", "a.md", page.read);
      await sharedPageRead("/w/concepts", "b.md", page.read);
    });
    await withSharedPageReads(() => sharedPageRead("/w/concepts", "a.md", page.read));
    expect(page.calls()).toBe(4);
  });
});
