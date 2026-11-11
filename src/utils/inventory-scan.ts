/**
 * Shared no-follow inventory primitives. Store-specific classification, traversal
 * limits and policy remain with each scanner; this module grants no authority.
 */
import { opendir } from "node:fs/promises";
import { lstat, realpath } from "./fs-metadata.js";
import { openConfinedLeaf, resolveExpectedReal } from "./confined-read.js";

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

/** Distinguish a missing directory from one whose confinement cannot be proved. */
async function directoryIsConfined(state: { root: string }, dir: string): Promise<boolean | "absent"> {
  const metadata = await lstat(dir).catch((error: NodeJS.ErrnoException) =>
    error.code === "ENOENT" ? null : error);
  if (metadata === null) return "absent";
  if (metadata instanceof Error || !metadata.isDirectory() || metadata.isSymbolicLink()) return false;
  const expected = await resolveExpectedReal(state.root, dir);
  if (expected === null) return false;
  return await realpath(dir).catch(() => null) === expected;
}

/** Why a confined directory was not opened. Each is decided BEFORE any entry is seen. */
type InventoryDirectoryRefusal = "absent" | "unavailable" | "unlistable";

/** Open one confined directory for listing, or say which refusal stopped short of it. Names no store and notes nothing. */
async function openConfinedDirectory(state: { root: string }, dir: string) {
  const confined = await directoryIsConfined(state, dir);
  if (confined === "absent") return "absent" as const;
  if (!confined) return "unavailable" as const;
  return opendir(dir).catch(() => "unlistable" as const);
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

/** Traverse an open directory while the caller's store-specific budget permits. */
async function walkInventoryEntries<T>(
  entries: AsyncIterable<T> & { close(): Promise<void> }, take: () => boolean, inspect: (entry: T) => Promise<void>,
): Promise<void> {
  try {
    for await (const entry of entries) {
      if (!take()) break;
      await inspect(entry);
    }
  } finally {
    await entries.close().catch(() => {});
  }
}

/**
 * Visit one confined directory under the caller's visitor, or say why it was
 * not opened: the confined opener, then the bounded entry loop. It names no
 * store: the caller words its own problem. A refusal is returned
 * only before any entry is seen; a failure during iteration rejects.
 */
export async function visitInventoryDirectory(
  root: string, directory: string,
  visitor: { take(): boolean; inspect(entry: import("node:fs").Dirent): Promise<void> },
): Promise<"visited" | InventoryDirectoryRefusal> {
  const opened = await openConfinedDirectory({ root }, directory);
  if (typeof opened === "string") return opened;
  await walkInventoryEntries(opened, visitor.take, visitor.inspect);
  return "visited";
}

/** One leaf's size and identity as its opened handle reported them, or why it could not be opened. */
type InventoryLeafObservation =
  | { kind: "confirmed"; size: number; dev: number; ino: number }
  | { kind: "absent" }
  | { kind: "unavailable" };

/**
 * Observe one leaf through the no-follow confined open ({@link openConfinedLeaf}),
 * copy its size and identity FROM THE HANDLE, and close the handle before
 * answering. Nothing stays open on any path.
 */
export async function observeInventoryLeaf(root: string, file: string, parent: string): Promise<InventoryLeafObservation> {
  const opened = await openConfinedLeaf(root, file, parent);
  if (opened.kind !== "confirmed") return opened;
  await opened.handle.close().catch(() => {});
  return { kind: "confirmed", size: opened.size, dev: opened.dev, ino: opened.ino };
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
}

/**
 * THE leaf capture both stores share: observe (an unconfirmed leaf is a
 * `leaf-unavailable` problem and nothing else), classify, the optional pre-cap
 * check, the cap, keep the observation, then an `unknown` kind is a problem.
 */
export async function captureInventoryLeaf<C extends { kind: string; protocolAlias?: "writing" | "tmp" }>(
  observeLeaf: (file: string, parent: string) => Promise<InventoryLeafObservation>,
  file: string, parent: string, policy: InventoryLeafPolicy<C>,
): Promise<void> {
  const observed = await observeLeaf(file, parent);
  if (observed.kind !== "confirmed") {
    policy.problem("leaf-unavailable", `${policy.label} leaf is ${observed.kind}`, file);
    return;
  }
  const classified = policy.classify(file);
  policy.beforeCap?.(file);
  policy.noteCap(classified.kind, observed.size, file);
  policy.record({ ...classified, ...inventoryLeafMetadata(file, classified.protocolAlias, observed) });
  if (classified.kind === "unknown") policy.problem(`${policy.label}-entry`, `unknown ${policy.label} leaf`, file);
}
