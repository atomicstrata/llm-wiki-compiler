/**
 * @file src/profile/templates/taps/cache.ts
 * @description Non-authoritative confined cache for verified indexes and packages.
 */
import path from "node:path";
import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { readdir, unlink } from "node:fs/promises";
import { atomicWrite } from "../../../utils/atomic-write.js";
import { readConfinedLeaf } from "../../../utils/confined-read.js";
import type { TapPaths } from "./paths.js";
import { ensurePrivateRoot } from "./private-root.js";

const MAX_CACHED_INDEX_BYTES = 4 * 1024 * 1024;
const MAX_CACHED_PACKAGE_BYTES = 2 * 1024 * 1024;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Write one verified index snapshot; callers must verify before invoking. */
export async function writeIndexCache(paths: TapPaths, tap: string, sequence: number, text: string): Promise<void> {
  const leaf = indexCachePath(paths, tap, sequence);
  await writeCache(paths, leaf, text, MAX_CACHED_INDEX_BYTES);
}

/** Read one cached index as evidence, never as authority. */
export async function readIndexCache(paths: TapPaths, tap: string, sequence: number): Promise<string> {
  return readCache(paths, indexCachePath(paths, tap, sequence), MAX_CACHED_INDEX_BYTES);
}

/** Best-effort removal of superseded non-authoritative index evidence. */
async function removeIndexCache(paths: TapPaths, tap: string, sequence: number): Promise<void> {
  const leaf = indexCachePath(paths, tap, sequence);
  const read = await readConfinedLeaf(paths.cacheRoot, leaf, path.dirname(leaf), MAX_CACHED_INDEX_BYTES);
  if (read.kind === "absent") return;
  if (read.kind !== "ok") throw new Error("template cache evidence is unavailable");
  await unlink(leaf);
}

/** Best-effort removal of every superseded regular index-cache leaf. */
export async function pruneIndexCaches(paths: TapPaths, tap: string, keepSequence: number): Promise<void> {
  const directory = path.join(paths.cacheRoot, "indexes", tap);
  const entries = await readCacheDirectory(directory);
  const stale = entries.filter((entry) => entry.isFile() && indexSequence(entry.name) !== keepSequence);
  await Promise.all(stale.map(async (entry) => {
    const sequence = indexSequence(entry.name);
    if (sequence !== null) await removeIndexCache(paths, tap, sequence).catch(() => {});
  }));
}

/** Write a fully verified package envelope by signed payload digest. */
export async function writePackageCache(paths: TapPaths, coordinate: string, digest: string, text: string): Promise<void> {
  await writeCache(paths, packageCachePath(paths, coordinate, digest), text, MAX_CACHED_PACKAGE_BYTES);
}

/** Read a cached package envelope for complete re-verification. */
export async function readPackageCache(paths: TapPaths, coordinate: string, digest: string): Promise<string | null> {
  return readOptionalCache(paths, packageCachePath(paths, coordinate, digest), MAX_CACHED_PACKAGE_BYTES);
}

function indexCachePath(paths: TapPaths, tap: string, sequence: number): string {
  if (!SLUG.test(tap) || !Number.isSafeInteger(sequence) || sequence < 0) throw new Error("invalid index cache identity");
  return path.join(paths.cacheRoot, "indexes", tap, `${sequence}.json`);
}

function packageCachePath(paths: TapPaths, coordinate: string, digest: string): string {
  const hex = /^sha256:([0-9a-f]{64})$/.exec(digest)?.[1];
  if (!hex || Buffer.byteLength(coordinate) > 4096) throw new Error("invalid package cache identity");
  const identity = createHash("sha256").update(coordinate).update("\0").update(digest).digest("hex");
  return path.join(paths.cacheRoot, "packages", "envelopes", `${identity}.json`);
}

function indexSequence(name: string): number | null {
  const match = /^(0|[1-9][0-9]*)\.json$/.exec(name);
  const value = match ? Number(match[1]) : Number.NaN;
  return Number.isSafeInteger(value) ? value : null;
}

async function readCacheDirectory(directory: string): Promise<Dirent[]> {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function writeCache(paths: TapPaths, leaf: string, text: string, maxBytes: number): Promise<void> {
  if (Buffer.byteLength(text) > maxBytes) throw new Error("template cache entry exceeds its byte cap");
  await ensurePrivateRoot(paths.cacheRoot);
  await atomicWrite(leaf, text, { confineRoot: paths.cacheRoot, durable: true, mode: 0o600 });
}

async function readCache(paths: TapPaths, leaf: string, maxBytes: number): Promise<string> {
  const expectedDir = path.dirname(leaf);
  const read = await readConfinedLeaf(paths.cacheRoot, leaf, expectedDir, maxBytes);
  if (read.kind !== "ok") throw new Error("template cache evidence is unavailable");
  return read.body;
}

async function readOptionalCache(paths: TapPaths, leaf: string, maxBytes: number): Promise<string | null> {
  const read = await readConfinedLeaf(paths.cacheRoot, leaf, path.dirname(leaf), maxBytes);
  if (read.kind === "absent") return null;
  if (read.kind !== "ok") throw new Error("template cache evidence is unavailable");
  return read.body;
}
