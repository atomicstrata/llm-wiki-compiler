/**
 * @file src/capability-providers/packages/state-store.ts
 * @description Confined, capped, durable provider source/install persistence
 * behind the provider-specific operator lock and opaque root authorization.
 */
import { lstat } from "node:fs/promises";
import { atomicWrite } from "../../utils/atomic-write.js";
import { readConfinedLeaf } from "../../utils/confined-read.js";
import { withExclusiveLock } from "../../utils/exclusive-lock.js";
import { assertAuthorizedProviderPaths, type AuthorizedProviderPaths } from "./paths.js";
import {
  MAX_PROVIDER_STATE_BYTES, parseProviderInstallState, parseProviderSourcesState,
} from "./state-parse.js";
import {
  emptyProviderInstallState, emptyProviderSourcesState, type ProviderInstallState,
  type ProviderSourcesState,
} from "./state-types.js";

/** Read source authority; only a genuinely absent leaf means empty state. */
export async function readProviderSourcesState(paths: AuthorizedProviderPaths): Promise<ProviderSourcesState> {
  await assertAuthorizedProviderPaths(paths);
  return readState(paths, paths.sourcesFile, parseProviderSourcesState, emptyProviderSourcesState);
}

/** Read installation authority; unreadable state never becomes no installs. */
export async function readProviderInstallState(paths: AuthorizedProviderPaths): Promise<ProviderInstallState> {
  await assertAuthorizedProviderPaths(paths);
  return readState(paths, paths.installsFile, parseProviderInstallState, emptyProviderInstallState);
}

/** Durably replace provider source authority while the caller holds its lock. */
export async function writeProviderSourcesState(paths: AuthorizedProviderPaths, state: ProviderSourcesState): Promise<void> {
  await writeState(paths, paths.sourcesFile, state, parseProviderSourcesState);
}

/** Durably replace provider install authority while the caller holds its lock. */
export async function writeProviderInstallState(paths: AuthorizedProviderPaths, state: ProviderInstallState): Promise<void> {
  await writeState(paths, paths.installsFile, state, parseProviderInstallState);
}

/** Serialize one provider authority mutation under the shared operator lock. */
export async function withProviderStateLock<Result>(
  paths: AuthorizedProviderPaths,
  operation: () => Promise<Result>,
): Promise<Result> {
  await assertAuthorizedProviderPaths(paths);
  return withExclusiveLock({ root: paths.configRoot, lockFile: paths.lockFile }, async () => {
    await assertAuthorizedProviderPaths(paths);
    const result = await operation();
    await assertAuthorizedProviderPaths(paths);
    return result;
  });
}

async function readState<State>(
  paths: AuthorizedProviderPaths,
  file: string,
  parse: (text: string) => State,
  empty: () => State,
): Promise<State> {
  const root = await lstat(paths.configRoot).catch((error) => absentOrThrow(error));
  if (root === null) return empty();
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("provider store is unavailable");
  const read = await readConfinedLeaf(paths.configRoot, file, paths.configRoot, MAX_PROVIDER_STATE_BYTES);
  if (read.kind === "absent") return empty();
  if (read.kind !== "ok") throw new Error("provider store is unavailable");
  return parse(read.body);
}

async function writeState<State>(
  paths: AuthorizedProviderPaths,
  file: string,
  state: State,
  parse: (text: string) => State,
): Promise<void> {
  await assertAuthorizedProviderPaths(paths);
  const text = `${JSON.stringify(state, null, 2)}\n`;
  if (Buffer.byteLength(text) > MAX_PROVIDER_STATE_BYTES) throw new Error("provider state exceeds its byte cap");
  parse(text);
  await atomicWrite(file, text, { confineRoot: paths.configRoot, durable: true, mode: 0o600 });
}

function absentOrThrow(error: unknown): null {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
  throw error;
}
