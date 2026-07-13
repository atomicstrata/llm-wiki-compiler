/**
 * @file src/profile/templates/taps/cache.ts
 * @description Non-authoritative confined cache for verified indexes and packages.
 */
import path from "node:path";
import { unlink } from "node:fs/promises";
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
export async function removeIndexCache(paths: TapPaths, tap: string, sequence: number): Promise<void> {
  const leaf = indexCachePath(paths, tap, sequence);
  const read = await readConfinedLeaf(paths.cacheRoot, leaf, path.dirname(leaf), MAX_CACHED_INDEX_BYTES);
  if (read.kind === "absent") return;
  if (read.kind !== "ok") throw new Error("template cache evidence is unavailable");
  await unlink(leaf);
}

/** Write a fully verified package envelope by signed payload digest. */
export async function writePackageCache(paths: TapPaths, digest: string, text: string): Promise<void> {
  await writeCache(paths, packageCachePath(paths, digest), text, MAX_CACHED_PACKAGE_BYTES);
}

/** Read a cached package envelope for complete re-verification. */
export async function readPackageCache(paths: TapPaths, digest: string): Promise<string | null> {
  return readOptionalCache(paths, packageCachePath(paths, digest), MAX_CACHED_PACKAGE_BYTES);
}

function indexCachePath(paths: TapPaths, tap: string, sequence: number): string {
  if (!SLUG.test(tap) || !Number.isSafeInteger(sequence) || sequence < 0) throw new Error("invalid index cache identity");
  return path.join(paths.cacheRoot, "indexes", tap, `${sequence}.json`);
}

function packageCachePath(paths: TapPaths, digest: string): string {
  const hex = /^sha256:([0-9a-f]{64})$/.exec(digest)?.[1];
  if (!hex) throw new Error("invalid package cache digest");
  return path.join(paths.cacheRoot, "packages", "sha256", `${hex}.json`);
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
