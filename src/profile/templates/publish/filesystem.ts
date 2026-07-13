/**
 * @file src/profile/templates/publish/filesystem.ts
 * @description Read-only filesystem boundary for offline publisher snapshots.
 * It accepts only the fixed static distribution layout, rejects symlinks and
 * special files, binds reads to confined open handles, caps every input, and
 * decodes signed protocol bytes as strict UTF-8.
 */
import { lstat, realpath, readdir } from "node:fs/promises";
import { TextDecoder } from "node:util";
import path from "node:path";
import { openConfinedLeaf, readCappedNoFollowBuffer } from "../../../utils/confined-read.js";
import { sha256DigestHex } from "../signing/protocol.js";

const MAX_INDEX_BYTES = 4 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 2 * 1024 * 1024;
const MAX_KEY_BYTES = 16 * 1024;

/** Canonical paths for a snapshot whose root passed the no-symlink gate. */
export interface DistributionPaths {
  root: string;
  canonicalRoot: string;
  packageDirectory: string;
}

/** Require a real directory selected without a symlink at its root. */
export async function resolveDistributionPaths(directory: string): Promise<DistributionPaths> {
  const root = path.resolve(directory);
  const info = await lstat(root).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink()) {
    throw new Error("distribution root must be a non-symlink directory");
  }
  const canonicalRoot = await realpath(root).catch(() => null);
  if (!canonicalRoot) throw new Error("distribution root cannot be confined");
  return { root, canonicalRoot, packageDirectory: path.join(root, "packages", "sha256") };
}

/** Read and strictly decode the independently selected tap public key. */
export async function readTapPublicKey(file: string): Promise<string> {
  const read = await readCappedNoFollowBuffer(file, MAX_KEY_BYTES);
  if (read.kind !== "ok") {
    throw new Error(`tap key file is unavailable, symlinked, special, or larger than ${MAX_KEY_BYTES} bytes`);
  }
  return decodeUtf8(read.body, "tap key file").trim();
}

/** Read the fixed index leaf through a root-anchored, handle-bound open. */
export function readDistributionIndex(paths: DistributionPaths): Promise<string> {
  return readConfinedUtf8(paths.root, path.join(paths.root, "index.json"), paths.root, MAX_INDEX_BYTES, "index");
}

/** Convert a signed digest to its only permitted content-addressed path. */
function packagePath(paths: DistributionPaths, digest: string): string {
  const hex = sha256DigestHex(digest);
  return path.join(paths.packageDirectory, `${hex}.json`);
}

/** Read one digest-derived package without following any path component. */
export function readDistributionPackage(paths: DistributionPaths, digest: string): Promise<string> {
  return readConfinedUtf8(
    paths.root,
    packagePath(paths, digest),
    paths.packageDirectory,
    MAX_PACKAGE_BYTES,
    "package",
  );
}

/** Require the complete static tree to contain exactly the signed package paths. */
export async function assertExactDistributionTree(paths: DistributionPaths, digests: string[]): Promise<void> {
  const filenames = digests.map((digest) => path.basename(packagePath(paths, digest)));
  if (new Set(filenames).size !== filenames.length) throw new Error("duplicate signed entries alias the same package path");
  await assertDirectory(paths.root, ["index.json", "packages"]);
  await assertRegularLeaf(path.join(paths.root, "index.json"), "index");
  const packages = path.join(paths.root, "packages");
  await assertCanonicalDirectory(paths, packages, "packages directory");
  await assertDirectory(packages, ["sha256"]);
  await assertCanonicalDirectory(paths, paths.packageDirectory, "package digest directory");
  for (const filename of filenames) {
    await assertRegularLeaf(path.join(paths.packageDirectory, filename), "package");
  }
  await assertDirectory(paths.packageDirectory, filenames);
}

async function assertDirectory(directory: string, expectedNames: string[]): Promise<void> {
  let actual: string[];
  try {
    actual = (await readdir(directory)).sort();
  } catch {
    throw new Error("distribution contains a missing, unreadable, or unexpected directory");
  }
  const expected = [...expectedNames].sort();
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw new Error("distribution contains an extra, unreferenced, or unexpected entry");
  }
}

async function assertCanonicalDirectory(paths: DistributionPaths, directory: string, label: string): Promise<void> {
  const info = await lstat(directory).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a non-symlink directory`);
  const canonical = await realpath(directory).catch(() => null);
  const expected = path.join(paths.canonicalRoot, path.relative(paths.root, directory));
  if (canonical !== expected) throw new Error(`${label} is symlinked or escapes confinement`);
}

async function assertRegularLeaf(file: string, label: string): Promise<void> {
  const info = await lstat(file).catch(() => null);
  if (!info) throw new Error(`${label} is missing`);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular file and not a symlink`);
}

async function readConfinedUtf8(
  root: string,
  file: string,
  expectedDirectory: string,
  maxBytes: number,
  label: string,
): Promise<string> {
  const opened = await openConfinedLeaf(root, file, expectedDirectory);
  if (opened.kind !== "confirmed") throw new Error(`${label} is missing, symlinked, or not a regular file`);
  try {
    if (opened.size > maxBytes) throw new Error(`${label} exceeds its bounded size limit`);
    return decodeUtf8(await opened.handle.readFile(), label);
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

function decodeUtf8(bytes: Buffer, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}
