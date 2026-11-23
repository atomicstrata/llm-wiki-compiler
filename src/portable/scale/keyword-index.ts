/**
 * @file src/portable/scale/keyword-index.ts
 * @description A rebuildable, in-memory keyword postings index, partitioned by
 * label set, behind {@link DerivedIndexPort}.
 *
 * It is derived state and nothing else. It is built from what the store hands
 * it, records the catalog root and label epoch it reflects, and can be thrown
 * away and rebuilt with no loss of authority. It never reads the store itself
 * and has no way to write to the catalog or the ledger.
 *
 * AUTHORIZATION HAPPENS BEFORE ANY POSTING IS READ. A query names the label
 * sets its caller is cleared for and the ledger's current label epoch. A
 * partition that is not at that epoch is not opened: no term is looked up in
 * it, nothing counts against the scan budget, nothing can set `truncated` and
 * nothing is ranked. Inside the opened partitions the scan reads postings
 * under the declared budget and says `truncated` when the budget ends it. A
 * common term's postings grow with the project, so no query here is
 * independent of project size.
 */

import type { ContentDigest } from "../contracts.js";
import { labelSetKey } from "./catalog.js";
import type { DerivedIndexPort, IndexAnswer, IndexChange, IndexHit, IndexQuery, ScaleCounters } from "./paged-store.js";

/** Terms shorter than this are not indexed or searched. */
const MIN_TERM_LENGTH = 2;

/** One document's entry in a term's posting list. */
interface Posting { path: string; weight: number }

/** What the index holds about one page: the digest it indexed and each term's weight. */
interface IndexedPage { digest: ContentDigest; weights: ReadonlyMap<string, number> }

/** One label set's postings, with the label epoch they reflect. */
interface IndexPartition {
  epoch: string;
  /** Each list is kept sorted by path, so a truncated scan is deterministic. */
  postings: Map<string, Posting[]>;
  pages: Map<string, IndexedPage>;
}

/**
 * The running state of one bounded scan. `candidates` holds at most `keep` hits,
 * already in final order; `keep` is `Infinity` only for a limit that is not a
 * non-negative integer, where every hit is kept and sorted at the end as before.
 */
interface Scan { remaining: number; postingsRead: number; truncated: boolean; candidates: IndexHit[]; keep: number }

/** Lowercased word terms of `text`. */
function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((term) => term.length >= MIN_TERM_LENGTH);
}

/** The distinct terms a query text names. */
export function queryTerms(text: string): string[] {
  return [...new Set(tokenize(text))];
}

/** Each term of `text` with how often it occurs. */
function termWeights(text: string): Map<string, number> {
  const weights = new Map<string, number>();
  for (const term of tokenize(text)) weights.set(term, (weights.get(term) ?? 0) + 1);
  return weights;
}

/** Insert `posting` into a list sorted by path. Appending in path order is the common case. */
function insertPosting(list: Posting[], posting: Posting): void {
  if (list.length === 0 || list[list.length - 1].path < posting.path) {
    list.push(posting);
    return;
  }
  const index = list.findIndex((entry) => entry.path > posting.path);
  list.splice(index === -1 ? list.length : index, 0, posting);
}

/** Higher score first; equal scores in path order. */
function byScoreThenPath(left: IndexHit, right: IndexHit): number {
  if (left.score !== right.score) return right.score - left.score;
  return left.path < right.path ? -1 : 1;
}

/**
 * Keep `hit` among the best `keep` hits seen so far, `top` staying in final
 * order. It is placed AFTER every retained hit that ranks at or above it, so
 * equal ranks keep scan order exactly as the stable sort they replace did; a
 * hit that would land past `keep` is dropped, and can never re-enter, because
 * every later hit is placed after its equals too. So `top` always equals the
 * first `keep` hits of a stable sort of all hits seen. A binary search finds
 * the place; the insertion moves at most `keep` entries: O(log keep + keep)
 * per hit, O(keep) retained, against O(hits) retained and an O(hits log hits)
 * sort before.
 */
function retainTop(top: IndexHit[], hit: IndexHit, keep: number): void {
  let low = 0;
  let high = top.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (byScoreThenPath(hit, top[middle]!) < 0) high = middle;
    else low = middle + 1;
  }
  if (low >= keep) return;
  top.splice(low, 0, hit);
  if (top.length > keep) top.pop();
}

/** Keyword postings over published pages. Volatile and rebuildable. */
export class KeywordPostingsIndex implements DerivedIndexPort {
  private readonly partitions = new Map<string, IndexPartition>();
  /** Which partition each indexed path currently sits in. */
  private readonly partitionOf = new Map<string, string>();
  private built: { root: string; labelEpoch: string } | null;

  /**
   * @param counters - Where scan work is counted.
   * @param emptyAt - The root and epoch of an EMPTY catalog this index starts current with. Omitted for
   *   an index that reflects nothing, such as one replacing a lost index: that one must be rebuilt.
   */
  constructor(private readonly counters: ScaleCounters, emptyAt: { root: string; labelEpoch: string } | null = null) {
    this.built = emptyAt;
  }

  update(changes: readonly IndexChange[], fromRoot: string, root: string, labelEpoch: string): void {
    // Advancing the epoch is safe ONLY on top of exactly the state the change log starts from.
    if (this.built === null || this.built.root !== fromRoot) {
      throw new Error("the index was not built from this catalog root; rebuild it");
    }
    for (const change of changes) this.apply(change, labelEpoch);
    this.stamp(root, labelEpoch);
  }

  async rebuild(
    entries: AsyncIterable<IndexChange>, root: string, labelEpoch: string, isStillCurrent: () => boolean,
  ): Promise<boolean> {
    this.partitions.clear();
    this.partitionOf.clear();
    // While `built` is null the index reflects nothing and admits no query, however far the traversal has got.
    this.built = null;
    for await (const entry of entries) this.apply(entry, labelEpoch);
    // Stamped only if the inputs did not move underneath the traversal; otherwise it stays unusable.
    if (isStillCurrent()) this.stamp(root, labelEpoch);
    return this.built !== null;
  }

  query(request: IndexQuery): IndexAnswer {
    const terms = queryTerms(request.text);
    // A non-negative integer limit is retained exactly; anything else keeps every hit and slices as before.
    const keep = Number.isInteger(request.limit) && request.limit >= 0 ? request.limit : Infinity;
    const scan: Scan = { remaining: request.scanBudget, postingsRead: 0, truncated: false, candidates: [], keep };
    let fenced = 0;
    const keys = request.labelSets.map(labelSetKey).sort();
    for (const key of keys) {
      // The fence comes first: a partition that is not current is never opened.
      if (this.epochOf(key) !== request.labelEpoch) fenced += 1;
      else this.scanPartition(this.partitions.get(key), terms, scan);
    }
    this.counters.postingsRead += scan.postingsRead;
    const hits = keep === Infinity ? scan.candidates.sort(byScoreThenPath).slice(0, request.limit) : scan.candidates;
    return { hits, truncated: scan.truncated, postingsRead: scan.postingsRead, fenced };
  }

  /**
   * The epoch a label set's postings reflect, or `null` when the index
   * reflects nothing: never built, lost, or part-way through a rebuild. A
   * partition holding half a rebuild is not admitted by its own partial stamp.
   */
  private epochOf(key: string): string | null {
    if (this.built === null) return null;
    return this.partitions.get(key)?.epoch ?? this.built.labelEpoch;
  }

  /** Read one opened partition's postings for `terms` (all must match), under the remaining budget. */
  private scanPartition(partition: IndexPartition | undefined, terms: readonly string[], scan: Scan): void {
    if (partition === undefined || terms.length === 0) return;
    const lists = terms.map((term) => {
      this.counters.indexTermSeeks += 1;
      return partition.postings.get(term) ?? [];
    });
    // Scanning the shortest list makes the cost follow the rarest term's postings.
    const driver = lists.reduce((shortest, list) => (list.length < shortest.length ? list : shortest));
    for (const posting of driver) {
      if (scan.remaining === 0) {
        scan.truncated = true;
        return;
      }
      scan.remaining -= 1;
      scan.postingsRead += 1;
      const page = partition.pages.get(posting.path) as IndexedPage;
      const weights = terms.map((term) => page.weights.get(term));
      if (weights.every((weight) => weight !== undefined)) {
        const score = weights.reduce<number>((sum, weight) => sum + (weight as number), 0);
        const hit = { path: posting.path, digest: page.digest, score };
        if (scan.keep === Infinity) scan.candidates.push(hit);
        else retainTop(scan.candidates, hit, scan.keep);
      }
    }
  }

  /** Replace whatever the index holds for one path with `change`. */
  private apply(change: IndexChange, labelEpoch: string): void {
    this.remove(change.path);
    if (change.digest === null || change.text === null) return;
    const key = labelSetKey(change.labels);
    const partition = this.partitions.get(key) ?? { epoch: labelEpoch, postings: new Map(), pages: new Map() };
    this.partitions.set(key, partition);
    const weights = termWeights(change.text);
    partition.pages.set(change.path, { digest: change.digest, weights });
    this.partitionOf.set(change.path, key);
    for (const [term, weight] of weights) {
      const list = partition.postings.get(term) ?? [];
      partition.postings.set(term, list);
      insertPosting(list, { path: change.path, weight });
    }
  }

  /** Drop one path's postings from the partition it was indexed in. */
  private remove(path: string): void {
    const partition = this.partitions.get(this.partitionOf.get(path) ?? "");
    const page = partition?.pages.get(path);
    if (partition === undefined || page === undefined) return;
    for (const term of page.weights.keys()) {
      const kept = (partition.postings.get(term) ?? []).filter((posting) => posting.path !== path);
      if (kept.length > 0) partition.postings.set(term, kept);
      else partition.postings.delete(term);
    }
    partition.pages.delete(path);
    this.partitionOf.delete(path);
  }

  /** Record what the index now reflects, on the index and on every partition. */
  private stamp(root: string, labelEpoch: string): void {
    for (const partition of this.partitions.values()) partition.epoch = labelEpoch;
    this.built = { root, labelEpoch };
  }
}
