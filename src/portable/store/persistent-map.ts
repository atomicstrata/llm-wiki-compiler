/**
 * @file src/portable/store/persistent-map.ts
 * @description An immutable, path-copying hash trie keyed by string: the
 * table a manifest store's head is made of.
 *
 * WHY IT EXISTS. A head swap must leave every older head intact, because a
 * generation or a served read may still hold it as a snapshot. Copying the
 * whole object table for each commit does that, at a cost proportional to the
 * project per commit. This trie shares everything a commit did not change: a
 * set copies only the nodes on one path from the root, so a commit's table
 * work is proportional to what it wrote times the trie's depth (at most seven
 * levels of 32-way branching for a 32-bit hash), not to the project.
 *
 * Nothing here is a format. It is an in-memory structure of the volatile store
 * and is never persisted or sent anywhere.
 */

/** Bits of the hash consumed per level. */
const BITS_PER_LEVEL = 5;
/** Children one branch can hold. */
const BRANCH_WIDTH = 1 << BITS_PER_LEVEL;
/** Mask selecting one level's slice of the hash. */
const LEVEL_MASK = BRANCH_WIDTH - 1;
/** A 32-bit hash is exhausted after this shift; equal hashes then share one bucket. */
const HASH_BITS = 32;
/** FNV-1a 32-bit offset basis and prime. */
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** Every key with one full hash, in insertion order. */
interface Leaf<V> { readonly kind: "leaf"; readonly hash: number; readonly entries: readonly (readonly [string, V])[] }

/** Up to 32 children, addressed by a bitmap of which slots are filled. */
interface Branch<V> { readonly kind: "branch"; readonly bitmap: number; readonly children: readonly TrieNode<V>[] }

type TrieNode<V> = Leaf<V> | Branch<V>;

/**
 * Where table work is counted. `nodesCopied` is one unit per trie node a
 * write creates; `bucketEntriesCopied` counts the entries of collision buckets
 * a write scanned and copied. Keys whose 32-bit hashes collide share one
 * bucket, so a write's cost is the trie depth PLUS its bucket's length, and
 * this counter is what shows the second term.
 */
export interface TrieWork { nodesCopied: number; bucketEntriesCopied: number }

/** A zeroed work record. */
export function emptyTrieWork(): TrieWork {
  return { nodesCopied: 0, bucketEntriesCopied: 0 };
}

/** FNV-1a over the UTF-16 code units of `key`, as an unsigned 32-bit number. */
function hashOf(key: string): number {
  let hash = FNV_OFFSET;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

/** Set bits in `value`. */
function popcount(value: number): number {
  let bits = value - ((value >>> 1) & 0x55555555);
  bits = (bits & 0x33333333) + ((bits >>> 2) & 0x33333333);
  return (((bits + (bits >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/** One level's slot for `hash` at `shift`. */
function slotOf(hash: number, shift: number): number {
  return (hash >>> shift) & LEVEL_MASK;
}

/** The value under `key` in the subtree at `node`, or undefined. */
function lookup<V>(node: TrieNode<V> | undefined, key: string, hash: number, shift: number): V | undefined {
  let current = node;
  let level = shift;
  while (current !== undefined) {
    if (current.kind === "leaf") {
      return current.hash === hash ? current.entries.find(([entryKey]) => entryKey === key)?.[1] : undefined;
    }
    const bit = 1 << slotOf(hash, level);
    if ((current.bitmap & bit) === 0) return undefined;
    current = current.children[popcount(current.bitmap & (bit - 1))];
    level += BITS_PER_LEVEL;
  }
  return undefined;
}

/** A leaf with `key` set to `value`, and whether the key is new. */
function setInLeaf<V>(leaf: Leaf<V>, key: string, value: V, work: TrieWork): { node: Leaf<V>; added: boolean } {
  const index = leaf.entries.findIndex(([entryKey]) => entryKey === key);
  const entries = [...leaf.entries];
  if (index === -1) entries.push([key, value]);
  else entries[index] = [key, value];
  work.nodesCopied += 1;
  work.bucketEntriesCopied += leaf.entries.length;
  return { node: { kind: "leaf", hash: leaf.hash, entries }, added: index === -1 };
}

/** A branch holding `existing` at its own slot, so a second hash can be placed beside it. */
function splitLeaf<V>(existing: Leaf<V>, shift: number, work: TrieWork): Branch<V> {
  work.nodesCopied += 1;
  return { kind: "branch", bitmap: 1 << slotOf(existing.hash, shift), children: [existing] };
}

/** A copy of `node` with `key` set, copying only the path from `node` down. */
function insert<V>(
  node: TrieNode<V> | undefined, key: string, hash: number, shift: number, value: V, work: TrieWork,
): { node: TrieNode<V>; added: boolean } {
  if (node === undefined) {
    work.nodesCopied += 1;
    return { node: { kind: "leaf", hash, entries: [[key, value]] }, added: true };
  }
  if (node.kind === "leaf") {
    if (node.hash === hash || shift >= HASH_BITS) return setInLeaf(node, key, value, work);
    return insert(splitLeaf(node, shift, work), key, hash, shift, value, work);
  }
  const bit = 1 << slotOf(hash, shift);
  const position = popcount(node.bitmap & (bit - 1));
  const occupied = (node.bitmap & bit) !== 0;
  const child = insert(occupied ? node.children[position] : undefined, key, hash, shift + BITS_PER_LEVEL, value, work);
  const children = [...node.children];
  if (occupied) children[position] = child.node;
  else children.splice(position, 0, child.node);
  work.nodesCopied += 1;
  return { node: { kind: "branch", bitmap: node.bitmap | bit, children }, added: child.added };
}

/** A leaf without `key`, or `undefined` when nothing would remain. */
function removeFromLeaf<V>(leaf: Leaf<V>, key: string, work: TrieWork): Leaf<V> | undefined {
  const entries = leaf.entries.filter(([entryKey]) => entryKey !== key);
  work.bucketEntriesCopied += leaf.entries.length;
  if (entries.length === 0) return undefined;
  work.nodesCopied += 1;
  return { kind: "leaf", hash: leaf.hash, entries };
}

/** A branch with the child at `position` replaced, or removed when `child` is undefined. */
function withChild<V>(node: Branch<V>, bit: number, position: number, child: TrieNode<V> | undefined, work: TrieWork): TrieNode<V> | undefined {
  const children = [...node.children];
  if (child !== undefined) {
    children[position] = child;
    work.nodesCopied += 1;
    return { kind: "branch", bitmap: node.bitmap, children };
  }
  children.splice(position, 1);
  if (children.length === 0) return undefined;
  work.nodesCopied += 1;
  return { kind: "branch", bitmap: node.bitmap & ~bit, children };
}

/** A copy of `node` without `key`, copying only the path from `node` down. Absent keys copy nothing. */
function remove<V>(node: TrieNode<V> | undefined, key: string, hash: number, shift: number, work: TrieWork): TrieNode<V> | undefined {
  if (node === undefined) return undefined;
  if (node.kind === "leaf") return node.hash === hash ? removeFromLeaf(node, key, work) : node;
  const bit = 1 << slotOf(hash, shift);
  if ((node.bitmap & bit) === 0) return node;
  const position = popcount(node.bitmap & (bit - 1));
  const child = node.children[position];
  const next = remove(child, key, hash, shift + BITS_PER_LEVEL, work);
  return next === child ? node : withChild(node, bit, position, next, work);
}

/** Every key under `node`. Order is the trie's, not sorted. */
function* keysOf<V>(node: TrieNode<V> | undefined): IterableIterator<string> {
  if (node === undefined) return;
  if (node.kind === "leaf") {
    for (const [key] of node.entries) yield key;
    return;
  }
  for (const child of node.children) yield* keysOf(child);
}

/** An immutable string-keyed map. Every `set` returns a new map; the old one is unchanged. */
export class PersistentMap<V> {
  private constructor(private readonly root: TrieNode<V> | undefined, readonly size: number) {}

  /** The empty map. */
  static empty<V>(): PersistentMap<V> {
    return new PersistentMap<V>(undefined, 0);
  }

  // Generic map read, called directly by four persistent-map unit-test cases and through PersistentMap-typed snapshot
  // fields on the dormant authority-store scoped path: receivers fallow does not resolve to this class.
  // fallow-ignore-next-line unused-class-member
  get(key: string): V | undefined {
    return lookup(this.root, key, hashOf(key), 0);
  }

  /** Every key, in the trie's order. A caller that needs order sorts. */
  // Called directly by two persistent-map unit-test cases and by the scoped access's member listing through a
  // PersistentMap-typed snapshot field: receivers fallow does not resolve to this class.
  // fallow-ignore-next-line unused-class-member
  keys(): IterableIterator<string> {
    return keysOf(this.root);
  }

  /**
   * A new map with every entry of `entries` set. Unchanged subtrees are shared.
   *
   * @param work - Counts the trie nodes this call created.
   */
  setMany(entries: Iterable<readonly [string, V]>, work: TrieWork = emptyTrieWork()): PersistentMap<V> {
    let root = this.root;
    let size = this.size;
    for (const [key, value] of entries) {
      const next = insert(root, key, hashOf(key), 0, value, work);
      root = next.node;
      if (next.added) size += 1;
    }
    return new PersistentMap(root, size);
  }

  /** A new map without `keys`. Absent keys are ignored. Unchanged subtrees are shared. */
  // Called directly by two persistent-map unit-test cases and by the (unconstructed) namespace table through
  // PersistentMap-typed snapshot fields: receivers fallow does not resolve to this class.
  // fallow-ignore-next-line unused-class-member
  deleteMany(keys: Iterable<string>, work: TrieWork = emptyTrieWork()): PersistentMap<V> {
    let root = this.root;
    let size = this.size;
    for (const key of keys) {
      if (lookup(root, key, hashOf(key), 0) === undefined) continue;
      root = remove(root, key, hashOf(key), 0, work);
      size -= 1;
    }
    return new PersistentMap(root, size);
  }
}
