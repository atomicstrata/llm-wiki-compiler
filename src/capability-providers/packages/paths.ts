/**
 * @file src/capability-providers/packages/paths.ts
 * @description Provider-specific operator-state paths and the filesystem
 * authorization boundary that turns computed roots into opaque, re-checkable
 * owner-private roots. Unverified root strings never reach a provider store.
 */
import path from "node:path";
import { constants as fsConstants } from "node:fs";
import { chmod, mkdir, open } from "node:fs/promises";
import { lstat, realpath, stat } from "../../utils/fs-metadata.js";
import { resolveLlmwikiOperatorRoots } from "../../operator-state/paths.js";

declare const authorizedProviderPathsBrand: unique symbol;
const authorizedIdentities = new WeakMap<object, {
  config: DirectoryIdentity; cache: DirectoryIdentity; providerCache: DirectoryIdentity;
  nowForTest?: () => Date;
}>();
const authorizedDirectories = new WeakMap<object, DirectoryIdentity>();
const testAuthorizedPaths = new WeakSet<object>();

/** Paths whose config/cache roots passed provider filesystem authorization. */
export interface AuthorizedProviderPaths {
  readonly verification: "authorized-provider-roots";
  readonly configRoot: string;
  readonly cacheRoot: string;
  readonly sourcesFile: string;
  readonly installsFile: string;
  readonly lockFile: string;
  readonly providerCacheRoot: string;
  readonly packagesRoot: string;
  readonly downloadsRoot: string;
  readonly [authorizedProviderPathsBrand]: true;
}

declare const authorizedProviderDirectoryBrand: unique symbol;

/** One cache directory bound to the inode checked before provider I/O. */
export interface AuthorizedProviderDirectory {
  readonly verification: "authorized-provider-directory";
  readonly path: string;
  readonly [authorizedProviderDirectoryBrand]: true;
}

/** Test-only authorization controls; production callers cannot select roots. */
export interface ProviderPathTestInputs {
  readonly configRoot: string;
  readonly cacheRoot: string;
  readonly projectRoot?: string;
  readonly afterAncestorCheckForTest?: () => Promise<void>;
  readonly nowForTest?: () => Date;
}

/**
 * Resolve and authorize production host roots without caller path inputs.
 *
 * `llmwiki product status` is its first production caller: a readiness review
 * has to ask the OPERATOR's real credential registry what is configured, so it
 * resolves the host roots rather than being handed roots by its caller.
 */
export async function resolveAuthorizedProviderPaths(): Promise<AuthorizedProviderPaths> {
  const roots = resolveLlmwikiOperatorRoots();
  return authorizeRoots(roots.configRoot, roots.cacheRoot);
}

/** @internal Authorize isolated roots for filesystem/race tests only. */
export async function authorizeProviderPathsForTest(
  inputs: ProviderPathTestInputs,
): Promise<AuthorizedProviderPaths> {
  const paths = await authorizeRoots(inputs.configRoot, inputs.cacheRoot, inputs);
  testAuthorizedPaths.add(paths);
  return paths;
}

/** @internal Reject test-only authority minting for production path objects. */
export async function assertTestAuthorizedProviderPaths(
  paths: AuthorizedProviderPaths,
): Promise<void> {
  await assertAuthorizedProviderPaths(paths);
  if (!testAuthorizedPaths.has(paths)) throw rootError();
}

/** Revalidate an opaque path object and both root inode bindings before I/O. */
export async function assertAuthorizedProviderPaths(paths: AuthorizedProviderPaths): Promise<void> {
  const identities = authorizedIdentities.get(paths) ?? await adoptCanonicalPaths(paths);
  await assertIdentity(identities.config);
  await assertIdentity(identities.cache);
  await assertIdentity(identities.providerCache);
}

/**
 * Recognize the canonical operator paths across a BUNDLE boundary.
 *
 * Authorization is recorded in a module-level WeakMap, and `dist/cli.js` and
 * `dist/index.js` are separate bundles with separate copies of this module — so
 * a paths object authorized by an operator's module (which imports the library)
 * was refused by the CLI it was handed to, before any launch. Every test
 * imports repository source and has ONE copy, which is why the defect existed
 * only in the shipped artifact.
 *
 * ADOPTION IS NOT A BYPASS, on two grounds:
 *
 * - Nothing is taken on trust: this bundle runs its own FULL authorization of
 *   the canonical operator roots — the same ancestor validation, private-root
 *   creation, and identity capture as `resolveAuthorizedProviderPaths` — and
 *   only then compares.
 * - Only the CANONICAL object is adoptable: every field of the supplied object
 *   must equal this bundle's own freshly authorized result. An object naming
 *   any other root, or the canonical roots with one doctored file path, still
 *   throws. Nothing is grantable this way that `resolveAuthorizedProviderPaths`
 *   would not hand the same caller directly.
 *
 * The supplied object is then REGISTERED, so later synchronous reads (the
 * test-clock lookup, directory brands) see it exactly as if this bundle had
 * authorized it.
 */
async function adoptCanonicalPaths(
  paths: AuthorizedProviderPaths,
): Promise<NonNullable<ReturnType<typeof authorizedIdentities.get>>> {
  let canonical: AuthorizedProviderPaths;
  try {
    canonical = await resolveAuthorizedProviderPaths();
  } catch {
    throw rootError();
  }
  const fields: readonly (keyof AuthorizedProviderPaths & string)[] = [
    "verification", "configRoot", "cacheRoot", "sourcesFile", "installsFile",
    "lockFile", "providerCacheRoot", "packagesRoot", "downloadsRoot",
  ];
  if (fields.some((field) => paths[field] !== canonical[field])) throw rootError();
  const identities = authorizedIdentities.get(canonical);
  if (!identities) throw rootError();
  authorizedIdentities.set(paths, identities);
  return identities;
}

/** @internal Return the host clock; only test-authorized roots can override it. */
export function providerClockNow(paths: AuthorizedProviderPaths): Date {
  const authorization = authorizedIdentities.get(paths);
  if (!authorization) throw rootError();
  const observed = authorization.nowForTest?.() ?? new Date();
  if (!Number.isFinite(observed.getTime())) throw rootError();
  return new Date(observed.getTime());
}

/** Create a real owner-private directory below the authorized provider cache. */
export async function ensureAuthorizedProviderDirectory(
  paths: AuthorizedProviderPaths,
  target: string,
): Promise<AuthorizedProviderDirectory> {
  await assertAuthorizedProviderPaths(paths);
  assertProviderCacheTarget(paths, target);
  const relative = path.relative(paths.providerCacheRoot, target);
  let current = paths.providerCacheRoot;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    await mkdir(current, { mode: 0o700 }).catch((error) => existsOrThrow(error));
    const entry = await lstat(current);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw rootError();
    assertOwnedDirectory(entry.uid, entry.mode);
    if (process.platform !== "win32") await chmod(current, 0o700);
  }
  await assertAuthorizedProviderPaths(paths);
  const resolved = await realpath(target);
  if (!inside(resolved, paths.providerCacheRoot)) throw rootError();
  const identity = await captureNearestAncestor(resolved);
  if (identity.path !== resolved) throw rootError();
  return bindDirectory(target, identity);
}

/** Bind one existing direct child to its exact authorized parent and inode. */
export async function bindAuthorizedProviderChildDirectory(
  paths: AuthorizedProviderPaths,
  parent: AuthorizedProviderDirectory,
  target: string,
): Promise<AuthorizedProviderDirectory> {
  const identity = await captureChildDirectory(paths, parent, target);
  await assertAuthorizedProviderDirectory(paths, parent);
  return bindDirectory(target, identity);
}

/**
 * {@link bindAuthorizedProviderChildDirectory} followed by
 * {@link authorizedProviderDirectoryRealPath} on the child, with the parent's
 * and the child's rechecks made under ONE root revalidation: the two checks
 * were back to back, so the second revalidation of the same roots proved
 * nothing the first had not.
 */
export async function bindAuthorizedProviderChildDirectoryRealPath(
  paths: AuthorizedProviderPaths,
  parent: AuthorizedProviderDirectory,
  target: string,
): Promise<{ readonly directory: AuthorizedProviderDirectory; readonly realPath: string }> {
  const identity = await captureChildDirectory(paths, parent, target);
  const directory = bindDirectory(target, identity);
  await assertAuthorizedProviderDirectories(paths, parent, directory);
  return { directory, realPath: identity.path };
}

/** Capture a direct child's identity below the parent's revalidated, inode-bound real path. */
async function captureChildDirectory(
  paths: AuthorizedProviderPaths,
  parent: AuthorizedProviderDirectory,
  target: string,
): Promise<DirectoryIdentity> {
  if (path.dirname(target) !== parent.path) throw rootError();
  // One revalidation, then the parent's inode-bound real path: the same proof
  // `authorizedProviderDirectoryRealPath` makes, without repeating it back to back.
  const parentReal = await authorizedProviderDirectoryRealPath(paths, parent);
  return captureExactDirectory(target, path.join(parentReal, path.basename(target)));
}

/** Bind an existing cache directory without creating it during a read operation. */
export async function bindExistingAuthorizedProviderDirectory(
  paths: AuthorizedProviderPaths,
  target: string,
): Promise<AuthorizedProviderDirectory> {
  await assertAuthorizedProviderPaths(paths);
  assertProviderCacheTarget(paths, target);
  const providerRoot = await realpath(paths.providerCacheRoot);
  const expectedReal = path.join(providerRoot, path.relative(paths.providerCacheRoot, target));
  const identity = await captureExactDirectory(target, expectedReal);
  await assertAuthorizedProviderPaths(paths);
  return bindDirectory(target, identity);
}

/** Change and sync a bound cache directory without following a replacement. */
export async function setAuthorizedProviderDirectoryMode(
  paths: AuthorizedProviderPaths,
  directory: AuthorizedProviderDirectory,
  mode: number,
): Promise<void> {
  if (process.platform === "win32") return;
  const expected = authorizedDirectories.get(directory);
  if (!expected) throw rootError();
  await assertAuthorizedProviderDirectory(paths, directory);
  const handle = await openDirectoryNoFollow(directory.path);
  try {
    const opened = await handle.stat();
    if (!opened.isDirectory() || opened.dev !== expected.dev || opened.ino !== expected.ino) throw rootError();
    await handle.chmod(mode); await handle.sync();
  } finally {
    await handle.close();
  }
  await assertAuthorizedProviderDirectory(paths, directory);
}

/** Recheck that a bound cache directory still names the same inode. */
export async function assertAuthorizedProviderDirectory(
  paths: AuthorizedProviderPaths,
  directory: AuthorizedProviderDirectory,
): Promise<void> {
  await assertAuthorizedProviderDirectories(paths, directory);
}

/**
 * Recheck several bound cache directories that are checked back to back: the
 * roots ONCE, then each directory's inode and confinement, in order. The same
 * checks as {@link assertAuthorizedProviderDirectory} on each, less the repeat
 * root revalidations that had no I/O between them.
 */
export async function assertAuthorizedProviderDirectories(
  paths: AuthorizedProviderPaths,
  ...directories: readonly AuthorizedProviderDirectory[]
): Promise<void> {
  const identities = directories.map((directory) => {
    const identity = authorizedDirectories.get(directory);
    if (!identity || directory.path !== identity.path) throw rootError();
    return identity;
  });
  await assertAuthorizedProviderPaths(paths);
  for (const identity of identities) {
    await assertIdentity(identity);
    if (!inside(await realpath(identity.path), paths.providerCacheRoot)) throw rootError();
  }
}

/** @internal Return the inode-bound canonical path after revalidation. */
export async function authorizedProviderDirectoryRealPath(
  paths: AuthorizedProviderPaths,
  directory: AuthorizedProviderDirectory,
): Promise<string> {
  await assertAuthorizedProviderDirectory(paths, directory);
  const identity = authorizedDirectories.get(directory);
  if (!identity) throw rootError();
  return identity.path;
}

async function authorizeRoots(
  configRoot: string,
  cacheRoot: string,
  options: Pick<ProviderPathTestInputs, "projectRoot" | "afterAncestorCheckForTest" | "nowForTest"> = {},
): Promise<AuthorizedProviderPaths> {
  assertRootStrings(configRoot, cacheRoot, options.projectRoot);
  const configParent = await validateAncestorChain(configRoot);
  const cacheParent = await validateAncestorChain(cacheRoot);
  await options.afterAncestorCheckForTest?.();
  await createPrivateRoot(configRoot, configParent);
  await createPrivateRoot(cacheRoot, cacheParent);
  const configChain = await validateAncestorChain(configRoot);
  const cacheChain = await validateAncestorChain(cacheRoot);
  const config = await canonicalRootIdentity(configRoot, configChain);
  const cache = await canonicalRootIdentity(cacheRoot, cacheChain);
  const providerCachePath = path.join(cache.path, "providers");
  await createPrivateRoot(providerCachePath, cache);
  const providerCache = await captureNearestAncestor(await realpath(providerCachePath));
  const paths = providerPaths(config.path, cache.path, providerCache.path);
  authorizedIdentities.set(paths, { config, cache, providerCache, nowForTest: options.nowForTest });
  return paths;
}

/**
 * Check every existing component of `target`'s path, root first, stopping at
 * the first absent one, and return the identity of the deepest one that
 * exists: the nearest existing ancestor (or `target` itself), from the same
 * lstat that just checked it rather than a second look.
 */
async function validateAncestorChain(target: string): Promise<DirectoryIdentity> {
  const absolute = path.resolve(target);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  let deepest: DirectoryIdentity | null = null;
  for (const component of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const entry = await lstat(current).catch((error) => absentOrThrow(error));
    if (entry === null) break;
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw rootError();
    assertOwnedDirectory(entry.uid, entry.mode);
    deepest = { path: current, dev: entry.dev, ino: entry.ino };
  }
  return deepest ?? captureNearestAncestor(parsed.root);
}

/**
 * The identity of a created root at its real path. When the path has no alias,
 * the chain check just made already lstat'ed that exact directory; otherwise
 * the real path is captured afresh.
 */
async function canonicalRootIdentity(target: string, chain: DirectoryIdentity): Promise<DirectoryIdentity> {
  const real = await realpath(target);
  return chain.path === real ? chain : captureNearestAncestor(real);
}

interface DirectoryIdentity { readonly path: string; readonly dev: number; readonly ino: number }

/** Mint one opaque directory binding only after the caller captured its inode identity. */
function bindDirectory(target: string, identity: DirectoryIdentity): AuthorizedProviderDirectory {
  const binding = Object.freeze({ verification: "authorized-provider-directory", path: target }) as AuthorizedProviderDirectory;
  authorizedDirectories.set(binding, identity);
  return binding;
}

/** Refuse a requested cache leaf outside the one authorized provider cache root. */
function assertProviderCacheTarget(paths: AuthorizedProviderPaths, target: string): void {
  const relative = path.relative(paths.providerCacheRoot, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw rootError();
}

async function captureNearestAncestor(target: string): Promise<DirectoryIdentity> {
  for (let current = target; ; current = path.dirname(current)) {
    const entry = await lstat(current).catch((error) => absentOrThrow(error));
    if (entry !== null) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw rootError();
      assertOwnedDirectory(entry.uid, entry.mode);
      return { path: current, dev: entry.dev, ino: entry.ino };
    }
    if (path.dirname(current) === current) throw rootError();
  }
}

async function captureExactDirectory(target: string, expectedReal: string): Promise<DirectoryIdentity> {
  const handle = await openDirectoryNoFollow(target);
  try {
    const opened = await handle.stat();
    const current = await lstat(target);
    const resolved = await realpath(target);
    if (!opened.isDirectory() || !current.isDirectory() || current.isSymbolicLink()
      || opened.dev !== current.dev || opened.ino !== current.ino || resolved !== expectedReal) throw rootError();
    assertOwnedDirectory(opened.uid, opened.mode);
    return { path: resolved, dev: opened.dev, ino: opened.ino };
  } finally {
    await handle.close();
  }
}

async function openDirectoryNoFollow(target: string) {
  const noFollow = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;
  const directory = "O_DIRECTORY" in fsConstants ? fsConstants.O_DIRECTORY : 0;
  try {
    return await open(target, fsConstants.O_RDONLY | noFollow | directory);
  } catch {
    throw rootError();
  }
}

async function createPrivateRoot(target: string, ancestor: DirectoryIdentity): Promise<void> {
  await assertIdentity(ancestor);
  await mkdir(target, { recursive: true, mode: 0o700 });
  await assertIdentity(ancestor);
  const entry = await lstat(target);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw rootError();
  assertOwnedDirectory(entry.uid, entry.mode);
  if (process.platform !== "win32") await chmod(target, 0o700);
  const handle = await open(target, "r");
  try {
    const opened = await handle.stat();
    const current = await stat(await realpath(target));
    if (opened.dev !== current.dev || opened.ino !== current.ino) throw rootError();
  } finally {
    await handle.close().catch(() => {});
  }
}

async function assertIdentity(expected: DirectoryIdentity): Promise<void> {
  const current = await lstat(expected.path);
  if (!current.isDirectory() || current.isSymbolicLink()
    || current.dev !== expected.dev || current.ino !== expected.ino) throw rootError();
  assertOwnedDirectory(current.uid, current.mode);
}

/**
 * Refuse a directory not owned by this user (or root), or writable by others
 * without the sticky bit. Pure over the metadata the caller JUST read (lstat or
 * the open handle's stat), so it makes no filesystem call of its own.
 */
function assertOwnedDirectory(uid: number, mode: number): void {
  if (process.platform === "win32" || typeof process.getuid !== "function") return;
  const current = process.getuid();
  const stickyWorldDirectory = (mode & 0o1000) !== 0;
  if (uid !== current && uid !== 0) throw rootError();
  if ((mode & 0o022) !== 0 && !stickyWorldDirectory) throw rootError();
}

function assertRootStrings(configRoot: string, cacheRoot: string, projectRoot?: string): void {
  if (!path.isAbsolute(configRoot) || !path.isAbsolute(cacheRoot)
    || inside(configRoot, cacheRoot) || inside(cacheRoot, configRoot)) throw rootError();
  if (projectRoot && (inside(configRoot, projectRoot) || inside(cacheRoot, projectRoot))) throw rootError();
}

function providerPaths(configRoot: string, cacheRoot: string, providerCacheRoot: string): AuthorizedProviderPaths {
  return Object.freeze({
    verification: "authorized-provider-roots",
    configRoot,
    cacheRoot,
    sourcesFile: path.join(configRoot, "provider-sources.json"),
    installsFile: path.join(configRoot, "provider-installs.json"),
    lockFile: path.join(configRoot, "provider-state.lock"),
    providerCacheRoot,
    packagesRoot: path.join(providerCacheRoot, "packages", "sha256"),
    downloadsRoot: path.join(providerCacheRoot, "downloads"),
  }) as AuthorizedProviderPaths;
}

function inside(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function absentOrThrow(error: unknown): null {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
  throw rootError();
}

function existsOrThrow(error: unknown): void {
  if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw rootError();
}

function rootError(): Error {
  return new Error("provider operator root is unavailable or unauthorized");
}

/**
 * Create (or re-verify) one owner-private directory outside any project, under
 * the same ancestor-ownership and no-symlink rules the provider roots use.
 *
 * Exported for host-authoritative state that is NOT a provider store but needs
 * the same guarantee: every existing ancestor is a real directory owned by this
 * user (or root) and not writable by others, and the leaf is `0700`.
 *
 * @param target - Absolute path of the directory to create or verify.
 * @returns The directory's real path.
 */
export async function ensureOwnerPrivateDirectory(target: string): Promise<string> {
  if (!path.isAbsolute(target)) throw rootError();
  await createPrivateRoot(target, await validateAncestorChain(target));
  await validateAncestorChain(target);
  return realpath(target);
}
