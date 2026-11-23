/**
 * @file test/portable/persistent-map.test.ts
 * @description The head table of the manifest store: an immutable hash trie.
 * A set returns a new map and leaves the old one a complete snapshot, and a
 * commit's table work follows what it wrote, not how big the table is.
 */

import { describe, expect, it } from "bun:test";
import { emptyTrieWork, PersistentMap } from "../../src/portable/store/persistent-map.js";

/** A map holding `count` keys `k0 .. k<count-1>`, each mapped to its index. */
function filled(count: number): PersistentMap<number> {
  return PersistentMap.empty<number>().setMany(Array.from({ length: count }, (_unused, index) => [`k${index}`, index] as const));
}

describe("the persistent head table", () => {
  it("returns a new map from every set and leaves the old one unchanged", () => {
    const before = filled(1_000);
    const after = before.setMany([["k5", -5], ["new", 42]]);
    expect(before.get("k5")).toBe(5);
    expect(before.get("new")).toBeUndefined();
    expect(before.size).toBe(1_000);
    expect(after.get("k5")).toBe(-5);
    expect(after.get("new")).toBe(42);
    expect(after.size).toBe(1_001);
  });

  it("enumerates every key exactly once", () => {
    const map = filled(5_000);
    const keys = [...map.keys()];
    expect(keys).toHaveLength(5_000);
    expect(new Set(keys).size).toBe(5_000);
    expect(map.get("k4999")).toBe(4999);
    expect(map.get("absent")).toBeUndefined();
  });

  it("deletes keys without touching the map it came from", () => {
    const before = filled(300);
    const after = before.deleteMany(["k1", "k2", "absent"]);
    expect(after.size).toBe(298);
    expect(after.get("k1")).toBeUndefined();
    expect(before.get("k1")).toBe(1);
    expect([...after.keys()]).toHaveLength(298);
    expect(after.deleteMany([...after.keys()]).size).toBe(0);
  });

});

describe("the persistent head table under collisions and at size", () => {
  it("keeps both keys of a real 32-bit hash collision, and counts the shared bucket", () => {
    // "probe/ok659f" and "probe/qdqcsv" have the same FNV-1a hash (found by the coordinator's probe).
    const before = PersistentMap.empty<number>().setMany([["probe/ok659f", 1]]);
    const work = emptyTrieWork();
    const after = before.setMany([["probe/qdqcsv", 2], ["probe/ok659f", 3]], work);
    expect([after.get("probe/ok659f"), after.get("probe/qdqcsv"), before.get("probe/ok659f")]).toEqual([3, 2, 1]);
    expect(work.bucketEntriesCopied).toBeGreaterThanOrEqual(3);
    expect(after.deleteMany(["probe/ok659f"]).get("probe/qdqcsv")).toBe(2);
  });

  it("copies a bounded path per write, whatever the table size", () => {
    const copiedFor = (size: number): number => {
      const work = emptyTrieWork();
      filled(size).setMany([["one-more", 1]], work);
      return work.nodesCopied;
    };
    // At most one node per trie level plus a split: never proportional to the table.
    expect(copiedFor(100)).toBeLessThanOrEqual(9);
    expect(copiedFor(20_000)).toBeLessThanOrEqual(9);
  });
});
