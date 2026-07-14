/**
 * @file src/profile/templates/taps/operator-lock.ts
 * @description Tap-state binding for the generic exclusive file lock.
 */
import { withExclusiveLock } from "../../../utils/exclusive-lock.js";
import type { TapPaths } from "./paths.js";

/** Run one authoritative read-modify-write while holding the operator lock. */
export async function withTapStateLock<T>(
  paths: TapPaths,
  operation: () => Promise<T>,
  timeoutMs?: number,
): Promise<T> {
  return withExclusiveLock({ root: paths.configRoot, lockFile: paths.lockFile }, operation, timeoutMs);
}
