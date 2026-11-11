/**
 * Shared no-follow inventory primitives. Store-specific classification, traversal
 * limits and policy remain with each scanner; this module grants no authority.
 */
import { opendir } from "node:fs/promises";
import path from "node:path";
import { lstat, realpath } from "./fs-metadata.js";
import { expectedRealMatching, openConfinedLeaf } from "./confined-read.js";
import type { ScannedLeafBytes } from "./scanned-leaf-bytes.js";

/** Reject unbounded or fractional scan requests before any traversal. */
export function positiveScanEntryLimit(requested: number, store: string): number {
  if (!Number.isSafeInteger(requested) || requested < 1) {
    throw new Error(`${store} inventory entry bound must be a positive safe integer`);
  }
  return requested;
}

/** Split only the fixed aliases owned by durable create-only writes. */
export function durableAlias(name: string): { base: string; alias?: "tmp" | "writing" } {
  if (name.endsWith(".writing")) return { base: name.slice(0, -8), alias: "writing" };
  if (name.endsWith(".tmp")) return { base: name.slice(0, -4), alias: "tmp" };
  return { base: name };
}

/** Convert an unchecked identity segment to a verified value or null. */
export function verified<T>(read: () => T): T | null {
  try { return read(); } catch { return null; }
}

/**
 * Distinguish a missing directory from one whose confinement cannot be proved.
 * The realpath must be the canonical in-root path, which no symlink at `dir` can
 * produce; a non-directory there is refused when it is opened for listing. Only
 * a failed realpath is lstat'd, to tell nothing there (absent) from a dangling
 * link or a fault (unavailable).
 */
async function directoryIsConfined(state: { root: string }, dir: string): Promise<boolean | "absent"> {
  const observed = await realpath(dir).catch((error: NodeJS.ErrnoException) => error);
  if (observed instanceof Error) {
    if (observed.code !== "ENOENT") return false;
    return lstat(dir).then(() => false, (error: NodeJS.ErrnoException) => error.code === "ENOENT" ? "absent" as const : false);
  }
  return await expectedRealMatching(state.root, path.resolve(dir), observed) !== null;
}

/** Why a confined directory was not opened. Each is decided BEFORE any entry is seen. */
type InventoryDirectoryRefusal = "absent" | "unavailable" | "unlistable";

/** Open one confined directory for listing, or say which refusal stopped short of it. Names no store and notes nothing. */
async function openConfinedDirectory(state: { root: string }, dir: string) {
  const confined = await directoryIsConfined(state, dir);
  if (confined === "absent") return "absent" as const;
  if (!confined) return "unavailable" as const;
  return opendir(dir).catch(listingRefusal);
}

/**
 * Build metadata from the open handle, never from a second path lookup. PURE:
 * it reads three numbers and a path. A caller holding an observation taken
 * from a handle that is already closed may use it too.
 */
function inventoryLeafMetadata(
  relativePath: string, alias: "writing" | "tmp" | undefined,
  opened: { size: number; dev: number; ino: number },
) {
  const suffix = alias === "writing" ? ".writing" : alias === "tmp" ? ".tmp" : "";
  return {
    relativePath, logicalRelativePath: suffix === "" ? relativePath : relativePath.slice(0, -suffix.length),
    bytes: opened.size, dev: opened.dev, ino: opened.ino,
  };
}

/**
 * Traverse an open directory while the caller's store-specific budget permits.
 *
 * Bun opens a directory lazily on Linux: `opendir` succeeds on a directory the
 * process may not list, and the refusal (`EACCES`) arrives with the first read.
 * A failure before any entry is seen is therefore the same refusal a failed open
 * is, and is answered the same way; a failure after an entry was seen rejects.
 */
async function walkInventoryEntries<T>(
  entries: AsyncIterable<T> & { close(): Promise<void> }, take: () => boolean, inspect: (entry: T) => Promise<void>,
): Promise<"visited" | InventoryDirectoryRefusal> {
  let seen = false;
  try {
    for await (const entry of entries) {
      seen = true;
      if (!take()) break;
      await inspect(entry);
    }
    return "visited";
  } catch (error) {
    if (seen) throw error;
    return listingRefusal(error as NodeJS.ErrnoException);
  } finally {
    await entries.close().catch(() => {});
  }
}

/** A confined path that is not a directory is unavailable; any other failure to list is unlistable. */
function listingRefusal(error: NodeJS.ErrnoException): InventoryDirectoryRefusal {
  return error.code === "ENOTDIR" ? "unavailable" : "unlistable";
}

/**
 * Visit one confined directory under the caller's visitor, or say why it was
 * not opened: the confined opener, then the bounded entry loop. It names no
 * store: the caller words its own problem. A refusal is returned
 * only before any entry is seen (including a lazy open's first read); a
 * failure after an entry was seen rejects.
 */
export async function visitInventoryDirectory(
  root: string, directory: string,
  visitor: { take(): boolean; inspect(entry: import("node:fs").Dirent): Promise<void> },
): Promise<"visited" | InventoryDirectoryRefusal> {
  const opened = await openConfinedDirectory({ root }, directory);
  if (typeof opened === "string") return opened;
  return walkInventoryEntries(opened, visitor.take, visitor.inspect);
}

/** One leaf's size and identity as its opened handle reported them, or why it could not be opened. */
type InventoryLeafObservation =
  | { kind: "confirmed"; size: number; dev: number; ino: number }
  | { kind: "absent" }
  | { kind: "unavailable" };

/**
 * How a store's walk observes one leaf: its size and identity from the opened
 * leaf, nothing open afterwards. `retainUpToBytes` is passed only for a leaf
 * the inventory goes on to read: the provider MAY keep that leaf's verified
 * bytes, within that cap, for its own reader later in the pass. The answer is
 * the same either way.
 */
export type InventoryLeafObserver = (file: string, parent: string, retainUpToBytes?: number) => Promise<InventoryLeafObservation>;

/** Where an observation may leave the leaf's bytes, and the most it may read. */
interface InventoryLeafRetention { into: ScannedLeafBytes; maxBytes: number }

/** A confined open the walk confirmed, still holding its handle. */
type ConfirmedInventoryLeaf = Extract<Awaited<ReturnType<typeof openConfinedLeaf>>, { kind: "confirmed" }>;

/** Whether the handle's `fstat` after the read still shows the file the open's `fstat` saw, version included. */
function handleUnchanged(opened: ConfirmedInventoryLeaf, after: import("node:fs").Stats): boolean {
  return after.isFile() && after.dev === opened.dev && after.ino === opened.ino && after.nlink === opened.nlink
    && after.size === opened.size && after.mtimeMs === opened.mtimeMs && after.ctimeMs === opened.ctimeMs;
}

/**
 * Read a confirmed leaf's bytes for the pass's holder, or null, and close the
 * handle. ONE read of one byte more than the handle's size: a leaf that grew
 * returns too many and is not held, and the handle's `fstat` afterwards must
 * show the same file, version included. The PATH half of the post-read checks
 * (parent realpath, canonical identity) is NOT asked here: no held byte is
 * returned to anyone until the reader asks exactly those of the leaf, against
 * this open's identity and version (`durable-leaf.ts`), so asking them here too
 * would only repeat them.
 */
async function readForHolder(opened: ConfirmedInventoryLeaf): Promise<Buffer | null> {
  try {
    const buffer = Buffer.alloc(opened.size + 1);
    const { bytesRead } = await opened.handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== opened.size || !handleUnchanged(opened, await opened.handle.stat())) return null;
    return buffer.subarray(0, bytesRead);
  } catch {
    return null;
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

/**
 * Observe one leaf through the no-follow confined open ({@link openConfinedLeaf}),
 * copy its size and identity FROM THE HANDLE, and close the handle before
 * answering. Nothing stays open on any path.
 *
 * With `retain`, a leaf within `retain.maxBytes` that still fits the holder is
 * also read from that same handle ({@link readForHolder}) and its bytes held
 * with the identity, version and canonical paths the open proved. Reading
 * never changes the observation: a failed read only means nothing is held.
 */
export async function observeInventoryLeaf(
  root: string, file: string, parent: string, retain?: InventoryLeafRetention,
): Promise<InventoryLeafObservation> {
  const opened = await openConfinedLeaf(root, file, parent);
  if (opened.kind !== "confirmed") return opened;
  const observation = { kind: "confirmed" as const, size: opened.size, dev: opened.dev, ino: opened.ino };
  if (retain === undefined || opened.size > retain.maxBytes || !retain.into.hasRoomFor(opened.size)) {
    await opened.handle.close().catch(() => {});
    return observation;
  }
  const body = await readForHolder(opened);
  if (body !== null) {
    retain.into.hold({
      root: path.resolve(root), leaf: file, ownedDirectory: path.resolve(parent), expectedReal: opened.expectedReal,
      canonicalLeaf: opened.canonicalLeaf, dev: opened.dev, ino: opened.ino, nlink: opened.nlink,
      size: opened.size, mtimeMs: opened.mtimeMs, ctimeMs: opened.ctimeMs, body,
    });
  }
  return observation;
}

/** The two stores that walk an inventory tree; the label is the first word of every problem they record. */
type InventoryStoreLabel = "operation" | "preparation";

/** What the bounded walk needs of a store's scan state: whether it is exhausted, and its directory visit. */
interface InventoryWalkState<E> {
  exhausted: boolean;
  reads: { visitDirectory(dir: string, visitor: { take(): boolean; inspect(entry: E): Promise<void> }): Promise<string> };
}

/**
 * One store's bounded-walk policy: its label, depth bound, problem recorder and its
 * own entry bound and inspector. Each callback takes the store's scan state first,
 * so a store hands over its own functions unwrapped.
 */
export interface InventoryWalkPolicy<S, E> {
  label: InventoryStoreLabel;
  maxDepth: number;
  /** Record one problem against a store-relative path, the store's own way. */
  problem(state: S, dimension: string, detail: string, relative: string): void;
  /** Consume one unit of the store's entry bound for `dir`; false when exhausted. */
  takeEntry(state: S, dir: string): boolean;
  /** Inspect one entry of `dir`, which is at `depth`. */
  inspectEntry(state: S, entry: E, dir: string, depth: number): Promise<void>;
}

/**
 * THE bounded walk both stores share: stop once exhausted; past the depth bound,
 * record the depth problem and exhaust; otherwise visit `dir` under the entry
 * bound and inspect each entry; then record an unavailable or unlistable
 * directory. Every word is the store's (`<label> …`).
 */
export async function walkInventoryTree<S extends InventoryWalkState<E>, E>(
  state: S, dir: string, depth: number, policy: InventoryWalkPolicy<S, E>,
): Promise<void> {
  if (state.exhausted) return;
  if (depth > policy.maxDepth) {
    policy.problem(state, "directory-depth", `${policy.label} inventory depth exceeded`, dir);
    state.exhausted = true;
    return;
  }
  const visit = await state.reads.visitDirectory(dir, {
    take: () => !state.exhausted && policy.takeEntry(state, dir),
    inspect: (entry) => policy.inspectEntry(state, entry, dir, depth),
  });
  if (visit === "unavailable") policy.problem(state, "directory-unavailable", `${policy.label} directory is unavailable`, dir);
  if (visit === "unlistable") policy.problem(state, "directory-unavailable", `${policy.label} directory cannot be listed`, dir);
}

/** One store's leaf-capture policy: its label, problem recorder, classifier, cap check and leaf sink. */
export interface InventoryLeafPolicy<C extends { kind: string; protocolAlias?: "writing" | "tmp" }> {
  label: InventoryStoreLabel;
  problem(dimension: string, detail: string, relative: string): void;
  /** Classify one leaf from its store-relative path alone. */
  classify(file: string): C;
  /** The operation store's quarantine dot-entry check, run before the cap; the preparation store has none. */
  beforeCap?(file: string): void;
  /** Refuse a recognized leaf whose observed size exceeds its kind's cap. */
  noteCap(kind: C["kind"], bytes: number, file: string): void;
  /** Keep the classified observation. */
  record(leaf: C & ReturnType<typeof inventoryLeafMetadata>): void;
  /**
   * The cap under which the walk may keep this leaf's bytes for the pass's later
   * authenticated read of it, or undefined to keep none. Only leaves a scan
   * goes on to read are worth keeping.
   */
  retainUpTo?(classified: C): number | undefined;
}

/**
 * THE leaf capture both stores share: classify (from the path alone), observe
 * (an unconfirmed leaf is a `leaf-unavailable` problem and nothing else), the
 * optional pre-cap check, the cap, keep the observation, then an `unknown` kind
 * is a problem. The observer is asked to keep the bytes only of a leaf the
 * policy names, so every other leaf is observed exactly as before.
 */
export async function captureInventoryLeaf<C extends { kind: string; protocolAlias?: "writing" | "tmp" }>(
  observeLeaf: InventoryLeafObserver,
  file: string, parent: string, policy: InventoryLeafPolicy<C>,
): Promise<void> {
  const classified = policy.classify(file);
  const retainUpToBytes = policy.retainUpTo?.(classified);
  const observed = await (retainUpToBytes === undefined ? observeLeaf(file, parent) : observeLeaf(file, parent, retainUpToBytes));
  if (observed.kind !== "confirmed") {
    policy.problem("leaf-unavailable", `${policy.label} leaf is ${observed.kind}`, file);
    return;
  }
  policy.beforeCap?.(file);
  policy.noteCap(classified.kind, observed.size, file);
  policy.record({ ...classified, ...inventoryLeafMetadata(file, classified.protocolAlias, observed) });
  if (classified.kind === "unknown") policy.problem(`${policy.label}-entry`, `unknown ${policy.label} leaf`, file);
}
