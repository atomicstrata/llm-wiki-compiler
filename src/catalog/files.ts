/**
 * @file src/catalog/files.ts
 * @description The local-disk facts the catalog is projected from: directory
 * and file stamps, confined file reads, and the full walk a reconciliation
 * makes. Every stat, open, listing and read is counted.
 *
 * CONFINEMENT. A file is stamped and read only through the shared ROOT-
 * ANCHORED, handle-bound leaf open (`openConfinedLeaf`): the leaf is opened
 * no-follow, its parent's realpath must be the canonical in-root directory,
 * and the opened handle must be the in-root leaf. So a linked leaf, a linked
 * or swapped PARENT directory (nested sources included), or a special file is
 * never stamped, projected or returned. A directory is stamped only when its
 * realpath is exactly its canonical in-root path.
 *
 * Only regular `.md` files are catalogued; anything else that looks like one
 * (a link, an over-long name, an oversized file) is reported as uncatalogued.
 * Sources are walked recursively (selection recursion and exclusions are
 * applied when a listing is read); page directories are flat.
 */

import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { MAX_KEY_CHARS } from "../segments/contracts.js";
import type { IoCounters } from "../segments/counters.js";
import { diskStreamingDirectory, type StreamingLocalDirectory } from "../storage/disk-local-reads.js";
import { openConfinedLeaf, readConfinedLeaf, resolveExpectedReal } from "../utils/confined-read.js";
import { SOURCES_DIR } from "../utils/constants.js";
import { CATALOGUED_DIRS, dirKey, PAGE_DIRECTORIES, pageKey, sourceKey, type DirStamp, type FileStamp } from "./contracts.js";

/** Largest file the catalog projects; larger files are uncatalogued. */
export const MAX_CATALOG_FILE_BYTES = 16 * 1024 * 1024;

/** One catalogued entry found by a walk: a file (with its stamp) or a directory (with its stamp, or null when absent). */
export interface WalkedEntry {
  readonly key: string;
  readonly relPath: string;
  readonly stamp: FileStamp | DirStamp | null;
}

/** A full walk's result, sorted by key. */
export interface CatalogWalk {
  readonly entries: WalkedEntry[];
  readonly uncatalogued: string[];
}

/** The stamp of a confined regular file, or `null` when it is absent, linked, escaping or not regular. */
export async function fileStamp(root: string, relPath: string, counters: IoCounters): Promise<FileStamp | null> {
  counters.filesStatted += 1;
  const leaf = path.join(root, relPath);
  const opened = await openConfinedLeaf(root, leaf, path.dirname(leaf));
  if (opened.kind !== "confirmed") return null;
  try {
    const info = await opened.handle.stat({ bigint: true });
    return { size: Number(info.size), mtimeNs: info.mtimeNs.toString(), ino: info.ino.toString() };
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

/** The stamp of a directory whose realpath is exactly its canonical in-root path, or `null`. */
export async function dirStamp(root: string, relDir: string, counters: IoCounters): Promise<DirStamp | null> {
  counters.filesStatted += 1;
  const dir = path.join(root, relDir);
  const expected = await resolveExpectedReal(root, dir);
  if (expected === null || (await realpath(dir).catch(() => null)) !== expected) return null;
  const info = await lstat(dir, { bigint: true }).catch(() => null);
  if (info === null || !info.isDirectory()) return null;
  return { size: Number(info.size), mtimeNs: info.mtimeNs.toString(), ino: info.ino.toString(), capturedAtMs: Date.now() };
}

/** Whether two stamps name the same state (both absent counts as the same). */
export function sameStamp(left: FileStamp | null | undefined, right: FileStamp | null | undefined): boolean {
  if (left == null || right == null) return left == null && right == null;
  return left.size === right.size && left.mtimeNs === right.mtimeNs && left.ino === right.ino;
}

/** The stamps of the top catalogued directories now. */
export async function captureDirStamps(root: string, counters: IoCounters): Promise<Record<string, DirStamp | null>> {
  const stamps: Record<string, DirStamp | null> = {};
  for (const dir of CATALOGUED_DIRS) stamps[dir] = await dirStamp(root, dir, counters);
  return stamps;
}

/** One confined file's text, or `null` when it cannot be read within the cap. */
export async function readCatalogFile(root: string, relPath: string, counters: IoCounters): Promise<string | null> {
  counters.bodiesRead += 1;
  const leaf = path.join(root, relPath);
  const read = await readConfinedLeaf(root, leaf, path.dirname(leaf), MAX_CATALOG_FILE_BYTES);
  return read.kind === "ok" ? read.body : null;
}

/**
 * Where a walk records what it finds. The incumbent full walk collects into
 * arrays and sorts them (`walkCatalogFiles`); a bounded caller (the batch
 * compile) spills each entry into a store keyed by its catalog key instead.
 */
export interface CatalogWalkSink {
  /** Record one catalogued entry. */
  entry(entry: WalkedEntry): Promise<void>;
  /** Record one path that looks catalogued but cannot be (a link, an over-long name, an oversized file). */
  uncatalogued(relPath: string): Promise<void>;
  /** The entry already recorded under `key`, if any. */
  find(key: string): Promise<WalkedEntry | undefined>;
}

/** Record one walked file as catalogued or uncatalogued. */
async function admitFile(root: string, relPath: string, key: string, regular: boolean, counters: IoCounters, out: CatalogWalkSink): Promise<void> {
  if (!relPath.endsWith(".md")) return;
  const stamp = regular && key.length <= MAX_KEY_CHARS ? await fileStamp(root, relPath, counters) : null;
  if (stamp === null || stamp.size > MAX_CATALOG_FILE_BYTES) await out.uncatalogued(relPath);
  else await out.entry({ key, relPath, stamp });
}

/** Stamp one directory BEFORE listing it, and record its row. */
async function admitDir(root: string, relDir: string, counters: IoCounters, out: CatalogWalkSink): Promise<boolean> {
  const key = dirKey(relDir);
  if (key.length > MAX_KEY_CHARS) { await out.uncatalogued(`${relDir}/`); return false; }
  const stamp = await dirStamp(root, relDir, counters);
  await out.entry({ key, relPath: relDir, stamp });
  return stamp !== null;
}

/** Refuse a source directory nested deeper than a bounded walk's limit. */
function assertDepth(prefix: string, depth: number, maxDepth: number | undefined): void {
  if (maxDepth !== undefined && depth > maxDepth) throw new Error(`${SOURCES_DIR}/${prefix} is nested deeper than ${maxDepth} directories; a bounded catalog walk refuses rather than walk it`);
}

/** Walk one source directory (streaming its entries), depth first, stamping each subdirectory before it is listed. */
async function walkSourceDir(root: string, directory: StreamingLocalDirectory, at: { prefix: string; depth: number; maxDepth?: number }, counters: IoCounters, out: CatalogWalkSink): Promise<void> {
  assertDepth(at.prefix, at.depth, at.maxDepth);
  counters.directoriesListed += 1;
  for await (const entry of directory.entries(at.prefix)) {
    const id = at.prefix ? `${at.prefix}/${entry.name}` : entry.name;
    if (entry.kind !== "directory") await admitFile(root, `${SOURCES_DIR}/${id}`, sourceKey(id), entry.kind === "file", counters, out);
    else if (await admitDir(root, `${SOURCES_DIR}/${id}`, counters, out)) await walkSourceDir(root, directory, { ...at, prefix: id, depth: at.depth + 1 }, counters, out);
  }
}

/** Walk the source tree, stamping each directory before it is listed (no deeper than `maxDepth` when given). */
async function walkSources(root: string, counters: IoCounters, out: CatalogWalkSink, maxDepth?: number): Promise<void> {
  if (!(await admitDir(root, SOURCES_DIR, counters, out))) return;
  const directory = await diskStreamingDirectory(root, SOURCES_DIR);
  if (directory !== null) await walkSourceDir(root, directory, { prefix: "", depth: 0, maxDepth }, counters, out);
}

/** Walk the flat page directories, stamping each before it is listed. */
async function walkPages(root: string, counters: IoCounters, out: CatalogWalkSink): Promise<void> {
  for (const [dir, relDir] of PAGE_DIRECTORIES) {
    if (!(await admitDir(root, relDir, counters, out))) continue;
    const directory = await diskStreamingDirectory(root, relDir);
    if (directory === null) continue;
    counters.directoriesListed += 1;
    for await (const entry of directory.entries("")) {
      if (entry.kind === "directory") continue;
      await admitFile(root, `${relDir}/${entry.name}`, pageKey(dir, entry.name.replace(/\.md$/, "")), entry.kind === "file", counters, out);
    }
  }
}

/** One declared entity type to walk: its type name, its directory, and the keys of its rows. */
export interface EntityWalkType {
  readonly type: string;
  readonly relDir: string;
  readonly dirKey: string;
  readonly fileKey: (stem: string) => string;
}

/**
 * Walk the declared entity directories (flat, like page directories): each
 * directory is stamped before it is listed and recorded both as a directory
 * stamp row and as the type's directory row (a missing or invalid directory
 * records a null stamp; its problems are projected later).
 */
async function walkEntities(root: string, types: readonly EntityWalkType[], counters: IoCounters, out: CatalogWalkSink): Promise<void> {
  for (const entity of types) {
    if (!(await recordEntityDir(root, entity, counters, out))) continue;
    const directory = await diskStreamingDirectory(root, entity.relDir);
    if (directory !== null) await walkEntityFiles(root, entity, directory, counters, out);
  }
}

/** Record one entity type's directory rows (stamping it unless already walked); returns whether it can be listed. */
async function recordEntityDir(root: string, entity: EntityWalkType, counters: IoCounters, out: CatalogWalkSink): Promise<boolean> {
  // A directory already walked (an entity type sharing a page directory) keeps its one stamp row.
  const known = await out.find(dirKey(entity.relDir));
  const listable = known === undefined ? await admitDir(root, entity.relDir, counters, out) : known.stamp !== null;
  const stamp = (known ?? (await out.find(dirKey(entity.relDir))))?.stamp ?? null;
  await out.entry({ key: entity.dirKey, relPath: entity.relDir, stamp });
  return listable;
}

/** Admit every `.md` file of one listed entity directory. */
async function walkEntityFiles(root: string, entity: EntityWalkType, directory: StreamingLocalDirectory, counters: IoCounters, out: CatalogWalkSink): Promise<void> {
  counters.directoriesListed += 1;
  for await (const entry of directory.entries("")) {
    if (entry.kind === "directory" || !entry.name.endsWith(".md")) continue;
    await admitFile(root, `${entity.relDir}/${entry.name}`, entity.fileKey(entry.name.slice(0, -3)), entry.kind === "file", counters, out);
  }
}

/**
 * Walk every catalogued tree (and, for a custom profile, its entity
 * directories) into `out`: explicit O(files + directories) maintenance work,
 * one directory entry at a time. A bounded caller passes `maxSourceDepth`, and
 * a source tree nested deeper refuses; the incumbent walk has no limit.
 */
export async function walkCatalogInto(root: string, counters: IoCounters, out: CatalogWalkSink, entityTypes: readonly EntityWalkType[] = [], maxSourceDepth?: number): Promise<void> {
  await walkPages(root, counters, out);
  await walkSources(root, counters, out, maxSourceDepth);
  await walkEntities(root, entityTypes, counters, out);
}

/** Walk every catalogued tree into arrays, sorted by key (the incumbent full walk). */
export async function walkCatalogFiles(root: string, counters: IoCounters, entityTypes: readonly EntityWalkType[] = []): Promise<CatalogWalk> {
  const out: CatalogWalk = { entries: [], uncatalogued: [] };
  await walkCatalogInto(root, counters, {
    entry: async (entry) => { out.entries.push(entry); },
    uncatalogued: async (relPath) => { out.uncatalogued.push(relPath); },
    find: async (key) => out.entries.find((entry) => entry.key === key),
  }, entityTypes);
  out.entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return out;
}
