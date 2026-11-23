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

/**
 * How long a provider authority mutation waits to ACQUIRE the shared provider-state lock.
 *
 * Every provider authority mutation serializes on this one lock: source add and refresh, remote, builtin and
 * local installs, removal, credentials, pricing and grants. A holder performs durable (fsynced) writes inside
 * it, so on slow storage one ordinary holder can keep the lock well beyond the generic five-second wait, and a
 * concurrent mutation was refused as busy although nothing was wrong. Provider callers therefore wait up to
 * this bound instead; all of them can now wait longer before a busy refusal.
 *
 * The bound limits acquisition waiting only, checked between awaited lock polls. It is not an end-to-end
 * deadline, does not cancel a holder, and does not promise that every package publishes within it. Template
 * taps and the publisher keep the generic five-second wait; ownership, fsync, stale-owner reclaim and root
 * authorization are unchanged.
 */
const PROVIDER_STATE_LOCK_TIMEOUT_MS = 120_000;

/** Accept only a whole, positive acquisition wait no longer than the provider default. */
function validProviderLockTimeout(timeoutMs: number): number {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > PROVIDER_STATE_LOCK_TIMEOUT_MS) {
    throw new RangeError(`provider lock wait must be a whole number of milliseconds from 1 to ${PROVIDER_STATE_LOCK_TIMEOUT_MS}`);
  }
  return timeoutMs;
}

/**
 * Serialize one provider authority mutation under the shared operator lock.
 *
 * @param paths - Authorized provider roots; re-checked before and after the operation.
 * @param operation - The read-modify-write to run while holding the lock.
 * @param timeoutMs - Acquisition wait; defaults to the provider bound and may only be shorter.
 *   It is validated before any filesystem work.
 */
export async function withProviderStateLock<Result>(
  paths: AuthorizedProviderPaths,
  operation: () => Promise<Result>,
  timeoutMs: number = PROVIDER_STATE_LOCK_TIMEOUT_MS,
): Promise<Result> {
  const waitMs = validProviderLockTimeout(timeoutMs);
  await assertAuthorizedProviderPaths(paths);
  return withExclusiveLock({ root: paths.configRoot, lockFile: paths.lockFile }, async () => {
    await assertAuthorizedProviderPaths(paths);
    const result = await operation();
    await assertAuthorizedProviderPaths(paths);
    return result;
  }, waitMs);
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
