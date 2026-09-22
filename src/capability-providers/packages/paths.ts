/**
 * @file src/capability-providers/packages/paths.ts
 * @description Provider-specific operator-state paths and the filesystem
 * authorization boundary that turns computed roots into opaque, re-checkable
 * owner-private roots. Unverified root strings never reach a provider store.
 */
import path from "node:path";
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, stat } from "node:fs/promises";
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
    await assertOwnedDirectory(current, entry.uid, entry.mode);
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
  await assertAuthorizedProviderDirectory(paths, parent);
  if (path.dirname(target) !== parent.path) throw rootError();
  const parentReal = await authorizedProviderDirectoryRealPath(paths, parent);
  const expectedReal = path.join(parentReal, path.basename(target));
  const identity = await captureExactDirectory(target, expectedReal);
  await assertAuthorizedProviderDirectory(paths, parent);
  return bindDirectory(target, identity);
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
  const identity = authorizedDirectories.get(directory);
  if (!identity || directory.path !== identity.path) throw rootError();
  await assertAuthorizedProviderPaths(paths);
  await assertIdentity(identity);
  if (!inside(await realpath(directory.path), paths.providerCacheRoot)) throw rootError();
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
  await validateAncestorChain(configRoot);
  await validateAncestorChain(cacheRoot);
  const configParent = await captureNearestAncestor(configRoot);
  const cacheParent = await captureNearestAncestor(cacheRoot);
  await options.afterAncestorCheckForTest?.();
  await createPrivateRoot(configRoot, configParent);
  await createPrivateRoot(cacheRoot, cacheParent);
  await validateAncestorChain(configRoot);
  await validateAncestorChain(cacheRoot);
  const config = await captureNearestAncestor(await realpath(configRoot));
  const cache = await captureNearestAncestor(await realpath(cacheRoot));
  const providerCachePath = path.join(cache.path, "providers");
  await createPrivateRoot(providerCachePath, cache);
  const providerCache = await captureNearestAncestor(await realpath(providerCachePath));
  const paths = providerPaths(config.path, cache.path, providerCache.path);
  authorizedIdentities.set(paths, { config, cache, providerCache, nowForTest: options.nowForTest });
  return paths;
}

async function validateAncestorChain(target: string): Promise<void> {
  const absolute = path.resolve(target);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const component of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const entry = await lstat(current).catch((error) => absentOrThrow(error));
    if (entry === null) return;
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw rootError();
    await assertOwnedDirectory(current, entry.uid, entry.mode);
  }
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
      await assertOwnedDirectory(current, entry.uid, entry.mode);
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
    await assertOwnedDirectory(resolved, opened.uid, opened.mode);
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
  await assertOwnedDirectory(target, entry.uid, entry.mode);
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
  await assertOwnedDirectory(expected.path, current.uid, current.mode);
}

async function assertOwnedDirectory(target: string, uid: number, mode: number): Promise<void> {
  if (process.platform === "win32" || typeof process.getuid !== "function") return;
  const current = process.getuid();
  const stickyWorldDirectory = (mode & 0o1000) !== 0;
  if (uid !== current && uid !== 0) throw rootError();
  if ((mode & 0o022) !== 0 && !stickyWorldDirectory) throw rootError();
  if ((await realpath(target)).length === 0) throw rootError();
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
