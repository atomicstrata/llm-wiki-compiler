/**
 * @file src/indexed/pins.ts
 * @description PINNED SNAPSHOTS of a `local-indexed` project: named, exact
 * copies of every store's manifest, whose segments a collection never
 * deletes.
 *
 * A pin is `.llmwiki/indexed-pins/<label>/`: one `<store>.manifest` per store (the
 * manifest's exact bytes) and a `pin.json` index written LAST, naming each
 * store with its byte length and SHA-256. Pins are written and removed under
 * the project mutation lock, the same lock a collection holds.
 *
 * STRICT. A pin protects only segment names its copied manifests reference,
 * and every copy is parsed by the strict manifest parser, so a pin can name
 * nothing but its own stores' segment leaves: it cannot invent a path. A pin
 * that cannot be fully validated (no `pin.json`, an unexpected leaf, a copy
 * whose bytes disagree with the index, a store that no longer exists) is a
 * BLOCKER: a collection refuses rather than guessing what it protects.
 * Removing a pin deletes its index first, so an interrupted removal leaves an
 * incomplete pin (a blocker) that `unpin` finishes. An interrupted CREATION
 * leaves a reserved publication alias; only an explicit unpin recovers it, with
 * full proof (`./pin-recovery.ts`). The format lives in `./pin-format.ts`.
 */

import { createHash } from "node:crypto";
import path from "node:path";
import { MAX_SEGMENT_MANIFEST_BYTES } from "../segments/contracts.js";
import { sha256Hex } from "../segments/format.js";
import { readManifestLeaf } from "../segments/io.js";
import { parseManifest } from "../segments/manifest.js";
import { atomicWrite } from "../utils/atomic-write.js";
import { readConfinedLeafBuffer } from "../utils/confined-read.js";
import { rmdirConfinedDurable, unlinkConfinedLeafDurable } from "../utils/confined-delete.js";
import { listConfinedDirBounded } from "../utils/confined-dir.js";
import { ensureConfinedDirectory } from "../utils/confined-scaffold.js";
import {
  COPY_SUFFIX, MAX_PIN_STORES, MAX_PINS, PIN_FORMAT, PIN_INDEX, PIN_LABEL_PATTERN, PINS_DIR, PRIVATE_FILE_MODE,
  copyStoreOf, isPinHeader, isPinnedStore, pinDir, type PinnedStore,
} from "./pin-format.js";
import { aliasTargetOf, removeInterruptedPin } from "./pin-recovery.js";

/** The validated pins of a project. */
export interface PinnedSetV1 {
  readonly labels: readonly string[];
  /** Per store, the segment names some pin references. */
  readonly protectedBy: ReadonlyMap<string, ReadonlySet<string>>;
  /** Binds the exact pins: every label, and the store and manifest digest of every copy. */
  readonly digest: string;
  /** Why the pins cannot be trusted; a collection refuses when any. */
  readonly blockers: readonly string[];
}

/** Parse a pin index strictly: exact keys, bounded distinct store entries. */
function parsePinIndex(bytes: Buffer, label: string): PinnedStore[] {
  const value = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
  if (!isPinHeader(value, label)) throw new Error(`pin ${label} has a malformed index`);
  if (!Array.isArray(value.stores) || value.stores.length > MAX_PIN_STORES) throw new Error(`pin ${label} lists no valid stores`);
  if (!value.stores.every(isPinnedStore)) throw new Error(`pin ${label} has a malformed store entry`);
  const stores = value.stores as PinnedStore[];
  if (new Set(stores.map((entry) => entry.store)).size !== stores.length) throw new Error(`pin ${label} names a store twice`);
  return stores;
}

/** Refuse a pin this build could not read back: too many pins or stores, a duplicate store, an index over the read cap. */
async function assertPinFits(root: string, stores: readonly string[]): Promise<void> {
  if (stores.length > MAX_PIN_STORES || new Set(stores).size !== stores.length) throw new Error(`a pin holds at most ${MAX_PIN_STORES} distinct stores`);
  const listing = await listConfinedDirBounded(root, PINS_DIR, MAX_PINS);
  if (listing.kind === "unavailable" || (listing.kind === "ok" && listing.entries.length >= MAX_PINS)) throw new Error(`a project holds at most ${MAX_PINS} pins, and ${PINS_DIR} must be listable`);
}

/** Read one confined pin leaf. */
async function readPinLeaf(root: string, label: string, leaf: string): Promise<Buffer> {
  const dir = path.join(root, pinDir(label));
  const read = await readConfinedLeafBuffer(root, path.join(dir, leaf), dir, MAX_SEGMENT_MANIFEST_BYTES, { requireSingleLink: true });
  if (read.kind !== "ok") throw new Error(`pin ${label} leaf ${leaf} is missing or not a confined regular file`);
  return read.body;
}

/** The validated index of pin `label`, whose leaves must be exactly the index and its copies. */
async function pinIndex(root: string, label: string): Promise<PinnedStore[]> {
  const listing = await listConfinedDirBounded(root, pinDir(label), MAX_PIN_STORES + 1);
  if (listing.kind !== "ok") throw new Error(`pin ${label} cannot be listed`);
  const names = listing.entries.map((entry) => entry.name);
  if (listing.entries.some((entry) => entry.kind !== "file") || !names.includes(PIN_INDEX)) throw new Error(`pin ${label} is incomplete or holds an unexpected entry; run unpin ${label}`);
  const pinned = parsePinIndex(await readPinLeaf(root, label, PIN_INDEX), label);
  const expected = new Set([PIN_INDEX, ...pinned.map((entry) => `${entry.store}${COPY_SUFFIX}`)]);
  if (expected.size !== names.length || names.some((name) => !expected.has(name))) throw new Error(`pin ${label}'s copies disagree with its index`);
  return pinned;
}

/** Validate pin `label` against the project's `stores`, adding the segment names it protects. */
async function readPin(root: string, label: string, stores: ReadonlySet<string>, protectedBy: Map<string, Set<string>>): Promise<PinnedStore[]> {
  const pinned = await pinIndex(root, label);
  for (const entry of pinned) {
    if (!stores.has(entry.store)) throw new Error(`pin ${label} names store ${entry.store}, which no longer exists`);
    const bytes = await readPinLeaf(root, label, `${entry.store}${COPY_SUFFIX}`);
    if (bytes.byteLength !== entry.bytes || sha256Hex(bytes) !== entry.sha256) throw new Error(`pin ${label}'s copy of ${entry.store} does not match its index`);
    const names = protectedBy.get(entry.store) ?? new Set<string>();
    for (const run of parseManifest(bytes, entry.store).runs) for (const segment of run.segments) names.add(segment.name);
    protectedBy.set(entry.store, names);
  }
  return pinned;
}

/** Validate every pin of the project whose stores are `stores`. */
export async function readPins(root: string, stores: ReadonlySet<string>): Promise<PinnedSetV1> {
  const listing = await listConfinedDirBounded(root, PINS_DIR, MAX_PINS);
  const protectedBy = new Map<string, Set<string>>();
  if (listing.kind === "absent") return { labels: [], protectedBy, digest: createHash("sha256").update(JSON.stringify({ labels: [], copies: [] })).digest("hex"), blockers: [] };
  if (listing.kind !== "ok") return { labels: [], protectedBy, digest: "", blockers: [`${PINS_DIR} cannot be listed in full`] };
  const labels = listing.entries.map((entry) => entry.name).sort();
  const bound: string[][] = [];
  const blockers: string[] = [];
  for (const label of labels) {
    try {
      if (!PIN_LABEL_PATTERN.test(label)) throw new Error(`unexpected entry ${label} in ${PINS_DIR}`);
      for (const entry of await readPin(root, label, stores, protectedBy)) bound.push([label, entry.store, entry.sha256]);
    } catch (error) { blockers.push(error instanceof Error ? error.message : String(error)); }
  }
  // Binds every label (an empty pin too) and every copy's store and manifest digest.
  const digest = createHash("sha256").update(JSON.stringify({ labels, copies: bound.sort() })).digest("hex");
  return { labels, protectedBy, digest, blockers };
}

/** Pin the current manifest of each of `stores` as `label`. The caller holds the project mutation lock. */
export async function createPin(root: string, label: string, stores: readonly string[]): Promise<number> {
  if (!PIN_LABEL_PATTERN.test(label)) throw new Error(`invalid pin label ${label}: use lowercase letters, digits and hyphens`);
  await assertPinFits(root, stores);
  if (!(await ensureConfinedDirectory(root, pinDir(label)))) throw new Error(`pin ${label} already exists`);
  const dir = path.join(root, pinDir(label));
  const pinned: PinnedStore[] = [];
  for (const store of stores) {
    const read = await readManifestLeaf(root, store);
    if (read.kind !== "ok") continue;
    parseManifest(read.bytes, store); // a pin copies only a manifest this build can read back
    await atomicWrite(path.join(dir, `${store}${COPY_SUFFIX}`), read.bytes, { confineRoot: root, exactParent: true, createOnly: true, mode: PRIVATE_FILE_MODE });
    pinned.push({ store, sha256: sha256Hex(read.bytes), bytes: read.bytes.byteLength });
  }
  const index = Buffer.from(`${JSON.stringify({ format: PIN_FORMAT, version: 1, label, createdAt: new Date().toISOString(), stores: pinned })}\n`);
  if (index.byteLength > MAX_SEGMENT_MANIFEST_BYTES) throw new Error(`pin ${label}'s index would exceed its read cap; the incomplete pin blocks collection until unpinned`);
  await atomicWrite(path.join(dir, PIN_INDEX), index, { confineRoot: root, exactParent: true, createOnly: true, mode: PRIVATE_FILE_MODE });
  return pinned.length;
}

/**
 * Remove pin `label`, index first. Refuses an entry it did not write. A label
 * holding a reserved publication alias is an interrupted `createPin`, recovered
 * only with full proof by `./pin-recovery.ts`; without one, the incumbent
 * alias-free policy applies unchanged. The caller holds the gated project lock.
 */
export async function removePin(root: string, label: string): Promise<void> {
  if (!PIN_LABEL_PATTERN.test(label)) throw new Error(`invalid pin label ${label}`);
  const dir = path.join(root, pinDir(label));
  // One more physical name than an alias-free pin: an interrupted publication's second link.
  const listing = await listConfinedDirBounded(root, pinDir(label), MAX_PIN_STORES + 2);
  if (listing.kind === "absent") throw new Error(`pin ${label} does not exist`);
  if (listing.kind !== "ok") throw new Error(`pin ${label} cannot be listed`);
  const ours = (name: string) => name === PIN_INDEX || copyStoreOf(name) !== null || aliasTargetOf(name) !== null;
  if (listing.entries.some((entry) => entry.kind !== "file" || !ours(entry.name))) throw new Error(`pin ${label} holds an entry this build did not write; nothing was removed`);
  const names = listing.entries.map((entry) => entry.name);
  if (names.some((name) => aliasTargetOf(name) !== null)) return removeInterruptedPin(root, label, names);
  if (names.length > MAX_PIN_STORES + 1) throw new Error(`pin ${label} cannot be listed`);
  const leaves = names.sort((a, b) => (a === PIN_INDEX ? -1 : b === PIN_INDEX ? 1 : a < b ? -1 : 1));
  for (const leaf of leaves) await unlinkConfinedLeafDurable(root, path.join(dir, leaf), dir);
  await rmdirConfinedDurable(root, dir, path.join(root, PINS_DIR));
}
