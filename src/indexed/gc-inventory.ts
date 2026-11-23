/**
 * @file src/indexed/gc-inventory.ts
 * @description The INVENTORY a segment collection plans and re-checks: every
 * store under `.llmwiki/indexed`, which of its leaves are referenced (by the
 * current manifest or by a pin), which are deletion CANDIDATES, and anything
 * that makes the inventory untrustworthy (a BLOCKER).
 *
 * A candidate is exactly a leaf named like a segment this build writes
 * (`r<run>-<n>-<hex>.seg`) that no current or pinned manifest references and
 * that is a regular single-link file, bound by its exact identity (size,
 * device, inode, nanosecond mtime). Nothing else is ever a candidate: the
 * manifest, atomic writers' scratch leaves and unknown names are RETAINED and
 * counted. Blockers: an unlistable directory, an unexpected entry where a
 * store should be, an unreadable or invalid manifest, segment leaves beside
 * an ABSENT manifest (a lost manifest is evidence, never garbage), a
 * referenced or pinned segment missing from disk or not a regular
 * single-link file, and any other segment-named leaf that is not one. The inventory reads manifests WITHOUT a reader
 * lease and opens no segment.
 */

import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { INDEXED_DIR, MANIFEST_LEAF, MAX_INDEXED_STORE_ENTRIES, STORE_NAME_PATTERN } from "../segments/contracts.js";
import { sha256Hex } from "../segments/format.js";
import { readManifestLeaf } from "../segments/io.js";
import { parseManifest, SEGMENT_NAME_PATTERN } from "../segments/manifest.js";
import { listConfinedDirBounded } from "../utils/confined-dir.js";

/** Most indexed entries an inventory lists. */
export const MAX_STORES = MAX_INDEXED_STORE_ENTRIES;
/** Most leaves an inventory lists per store. */
export const MAX_LEAVES = 1_000_000;
/** Retained leaf names kept as a sample. */
const SAMPLE = 5;

/** A deletion candidate, bound by its exact identity. */
export interface CandidateIdentityV1 {
  readonly name: string;
  readonly size: string;
  readonly dev: string;
  readonly ino: string;
  readonly mtimeNs: string;
}

/** One store's inventory. */
export interface StoreInventoryV1 {
  readonly store: string;
  /** SHA-256 of the current manifest bytes, or null when absent. */
  readonly manifestSha256: string | null;
  readonly referencedSegments: number;
  readonly candidates: readonly CandidateIdentityV1[];
  readonly candidateBytes: number;
  /** Binds the exact candidate set. */
  readonly candidateDigest: string;
  /** Leaves never deleted: scratch and unknown names. */
  readonly retainedOther: { readonly count: number; readonly sample: readonly string[] };
  readonly blockers: readonly string[];
}

/** The real directory of `store`, which must be the confined in-root path. */
export async function storeDirectory(root: string, store: string): Promise<string> {
  const lexical = path.join(root, INDEXED_DIR, store);
  const real = await realpath(lexical);
  if (real !== path.join(await realpath(root), INDEXED_DIR, store)) throw new Error(`store ${store} directory is redirected`);
  return real;
}

/** The store names under `.llmwiki/indexed`, with a blocker per unexpected entry. */
export async function listStores(root: string): Promise<{ stores: string[]; blockers: string[] }> {
  const listing = await listConfinedDirBounded(root, INDEXED_DIR, MAX_STORES);
  if (listing.kind === "absent") return { stores: [], blockers: [] };
  if (listing.kind !== "ok") return { stores: [], blockers: [`${INDEXED_DIR} cannot be listed in full`] };
  const stores: string[] = [];
  const blockers: string[] = [];
  for (const entry of listing.entries) {
    if (entry.kind === "directory" && STORE_NAME_PATTERN.test(entry.name)) stores.push(entry.name);
    else blockers.push(`unexpected entry ${entry.name.slice(0, 80)} in ${INDEXED_DIR}`);
  }
  return { stores: stores.sort(), blockers };
}

/** The current manifest's sha and referenced names, or a blocker. */
async function currentReferences(root: string, store: string): Promise<{ sha: string | null; names: Set<string> }> {
  const read = await readManifestLeaf(root, store);
  if (read.kind === "absent") return { sha: null, names: new Set() };
  const names = new Set<string>();
  for (const run of parseManifest(read.bytes, store).runs) for (const segment of run.segments) names.add(segment.name);
  return { sha: sha256Hex(read.bytes), names };
}

/** Blockers for referenced or pinned names: each must be on disk as a regular single-link file. */
async function protectedLeafBlockers(dir: string, store: string, names: ReadonlySet<string>, present: ReadonlySet<string>, what: string): Promise<string[]> {
  const blockers: string[] = [];
  for (const name of names) {
    if (!present.has(name)) { blockers.push(`store ${store}: ${what} segment ${name} is missing`); continue; }
    const identity = await identityOf(dir, name);
    if (typeof identity === "string") blockers.push(`store ${store}: ${what} ${identity}`);
  }
  return blockers;
}

/** The exact identity of a segment-named leaf, or a blocker message. */
export async function identityOf(dir: string, name: string): Promise<CandidateIdentityV1 | string> {
  const stat = await lstat(path.join(dir, name), { bigint: true }).catch(() => null);
  if (stat === null || !stat.isFile() || stat.nlink !== 1n) return `segment-named leaf ${name} is not a regular single-link file`;
  return { name, size: String(stat.size), dev: String(stat.dev), ino: String(stat.ino), mtimeNs: String(stat.mtimeNs) };
}

/** Digest of a candidate set, in name order. */
export function candidateDigest(candidates: readonly CandidateIdentityV1[]): string {
  const hash = createHash("sha256");
  for (const c of [...candidates].sort((a, b) => (a.name < b.name ? -1 : 1))) hash.update(`${c.name}\t${c.size}\t${c.dev}\t${c.ino}\t${c.mtimeNs}\n`);
  return hash.digest("hex");
}

/** Sort one store's leaves into referenced, candidates, retained and blockers. */
async function classifyLeaves(root: string, store: string, referenced: ReadonlySet<string>, protectedByPins: ReadonlySet<string>): Promise<Omit<StoreInventoryV1, "store" | "manifestSha256" | "referencedSegments" | "candidateDigest">> {
  const listing = await listConfinedDirBounded(root, path.posix.join(INDEXED_DIR, store), MAX_LEAVES);
  if (listing.kind !== "ok") return { candidates: [], candidateBytes: 0, retainedOther: { count: 0, sample: [] }, blockers: [`store ${store} cannot be listed in full`] };
  const dir = await storeDirectory(root, store);
  const candidates: CandidateIdentityV1[] = [];
  const blockers: string[] = [];
  const other: string[] = [];
  const present = new Set<string>();
  for (const { name, kind } of listing.entries) {
    if (name === MANIFEST_LEAF) { if (kind !== "file") blockers.push(`store ${store} manifest is not a regular file`); continue; }
    if (!SEGMENT_NAME_PATTERN.test(name)) { other.push(name); continue; }
    present.add(name);
    if (referenced.has(name) || protectedByPins.has(name)) continue;
    const identity = await identityOf(dir, name);
    if (typeof identity === "string") blockers.push(`store ${store}: ${identity}`); else candidates.push(identity);
  }
  blockers.push(...await protectedLeafBlockers(dir, store, referenced, present, "referenced"));
  blockers.push(...await protectedLeafBlockers(dir, store, new Set([...protectedByPins].filter((name) => !referenced.has(name))), present, "pinned"));
  const candidateBytes = candidates.reduce((sum, c) => sum + Number(c.size), 0);
  return { candidates, candidateBytes, retainedOther: { count: other.length, sample: other.slice(0, SAMPLE) }, blockers };
}

/** Inventory one store against the segment names its pins protect. */
export async function inventoryStore(root: string, store: string, protectedByPins: ReadonlySet<string>): Promise<StoreInventoryV1> {
  let current: { sha: string | null; names: Set<string> };
  try { current = await currentReferences(root, store); } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { store, manifestSha256: null, referencedSegments: 0, candidates: [], candidateBytes: 0, candidateDigest: candidateDigest([]), retainedOther: { count: 0, sample: [] }, blockers: [`store ${store} manifest is unusable: ${reason}`] };
  }
  const leaves = await classifyLeaves(root, store, current.names, protectedByPins);
  const lost = current.sha === null && leaves.candidates.length > 0;
  const blockers = lost ? [...leaves.blockers, `store ${store} has segments but no manifest (lost manifest)`] : leaves.blockers;
  const candidates = lost ? [] : leaves.candidates;
  return {
    store, manifestSha256: current.sha, referencedSegments: current.names.size, ...leaves, candidates,
    candidateBytes: lost ? 0 : leaves.candidateBytes, candidateDigest: candidateDigest(candidates), blockers,
  };
}
