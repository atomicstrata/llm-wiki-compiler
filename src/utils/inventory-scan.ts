/**
 * Shared no-follow inventory primitives. Store-specific classification, traversal
 * limits and policy remain with each scanner; this module grants no authority.
 */
import path from "node:path";
import { lstat, realpath, opendir } from "node:fs/promises";
import { openConfinedLeaf, resolveExpectedReal } from "./confined-read.js";

/** Reject unbounded or fractional scan requests before any traversal. */
export function positiveScanEntryLimit(requested: number, store: string): number {
  if (!Number.isSafeInteger(requested) || requested < 1) {
    throw new Error(`${store} inventory entry bound must be a positive safe integer`);
  }
  return requested;
}

/** Record a scan failure without leaking an absolute path into its inventory. */
export function noteInventoryProblem(
  state: { root: string; problems: { dimension: string; detail: string; path?: string }[] },
  dimension: string, detail: string, file?: string,
): void {
  state.problems.push({ dimension, detail, ...(file === undefined ? {} : { path: path.relative(state.root, file) }) });
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

/** Open a confined inventory directory and retain store-specific refusal messages. */
async function openInventoryDirectory(state: Parameters<typeof noteInventoryProblem>[0], dir: string, store: string) {
  const confined = await directoryIsConfined(state, dir);
  if (confined === "absent") return null;
  if (!confined) {
    noteInventoryProblem(state, "directory-unavailable", `${store} directory is unavailable`, dir);
    return null;
  }
  const handle = await opendir(dir).catch(() => null);
  if (handle === null) noteInventoryProblem(state, "directory-unavailable", `${store} directory cannot be listed`, dir);
  return handle;
}

/** Open a no-follow leaf, retaining the store's own diagnostic vocabulary. */
export async function openInventoryLeaf(
  state: Parameters<typeof noteInventoryProblem>[0], file: string, parent: string, store: string,
) {
  const opened = await openConfinedLeaf(state.root, file, parent);
  if (opened.kind === "confirmed") return opened;
  noteInventoryProblem(state, "leaf-unavailable", `${store} leaf is ${opened.kind}`, file);
  return null;
}

/** Build metadata from the open handle, never from a second path lookup. */
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

/** Retain a classified handle observation, then release the handle once. */
export async function recordInventoryLeaf<T extends { protocolAlias?: "writing" | "tmp" }>(
  leaves: Array<T & ReturnType<typeof inventoryLeafMetadata>>,
  classified: T, relativePath: string,
  opened: { size: number; dev: number; ino: number; handle: { close(): Promise<void> } },
): Promise<void> {
  leaves.push({ ...classified, ...inventoryLeafMetadata(relativePath, classified.protocolAlias, opened) });
  await opened.handle.close().catch(() => {});
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

/** Open and traverse one confined directory using the scanner's budget and classifier. */
export async function walkInventoryDirectory(
  state: Parameters<typeof noteInventoryProblem>[0],
  target: { directory: string; store: string },
  visitor: { take(): boolean; inspect(entry: import("node:fs").Dirent): Promise<void> },
): Promise<void> {
  const handle = await openInventoryDirectory(state, target.directory, target.store);
  if (handle === null) return;
  await walkInventoryEntries(handle, visitor.take, visitor.inspect);
}
