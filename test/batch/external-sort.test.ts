/**
 * @file test/batch/external-sort.test.ts
 * @description The run store's external merge sort is STABLE and
 * multi-pass: with more runs than its fixed fan-in it merges level by level,
 * and its output equals one in-memory stable sort of the same items (ties in
 * the order they were added), including items far apart that compare equal.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { afterEach, beforeEach } from "../config/storage-profile-hooks.js";
import { ExternalSorter, SORT_CHUNK_ITEMS, SORT_FAN_IN } from "../../src/compiler/batch/external-sort.js";
import { BatchRun } from "../../src/compiler/batch/run-store.js";

/** Writing several level-0 and level-1 runs costs durable commits on the test volume. */
const SORT_TIMEOUT_MS = 300_000;
let root = "";

beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "llmwiki-batch-sort-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

/** One item: a sort key with many ties, and the order it was added in. */
interface Item { readonly key: string; readonly added: number }

describe("the external merge sort", () => {
  it("sorts stably across more runs than its fan-in (two merge levels)", async () => {
    const run = await BatchRun.create(root, { batchSize: 10, embeddings: false, identity: { policy: "p", sources: null, cstate: "c" } });
    const compare = (a: Item, b: Item): number => a.key.localeCompare(b.key);
    const sorter = new ExternalSorter<Item>(run, "xs:", compare);
    const items: Item[] = [];
    const total = SORT_CHUNK_ITEMS * (SORT_FAN_IN + 2) + 17;
    for (let added = 0; added < total; added += 1) {
      const item = { key: `k${(added * 7919) % 13}`, added };
      items.push(item);
      await sorter.add(item);
    }
    const sorted: Item[] = [];
    for await (const item of sorter.sorted()) sorted.push(item);
    expect(sorted).toEqual([...items].sort(compare));
  }, SORT_TIMEOUT_MS);
});
