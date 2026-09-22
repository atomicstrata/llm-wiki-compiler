/**
 * Pure inventory arithmetic shared by independently authorized durable stores.
 * Callers retain their own limits, error identities, scanning and health policy.
 */

/** Return the first exceeded or invalid dimension in declaration order. */
export function capacityViolation<T>(
  projection: T, entries: ReadonlyArray<[keyof T, number, string]>,
): string | undefined {
  for (const [field, limit, dimension] of entries) {
    const value = projection[field];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > limit) return dimension;
  }
  return undefined;
}

/** Count physical bytes once even when a durable hard-link alias remains. */
export function uniqueInventoryBytes(leaves: readonly { dev: number; ino: number; bytes: number }[]): number {
  const seen = new Set<string>();
  let bytes = 0;
  for (const leaf of leaves) {
    const identity = `${leaf.dev}:${leaf.ino}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    bytes += leaf.bytes;
  }
  return bytes;
}

/** Select committed manifests without treating protocol aliases as authorities. */
export function authoritativeManifests<T extends { kind: string; protocolAlias?: string }>(leaves: readonly T[]): T[] {
  return leaves.filter((leaf) => leaf.kind === "manifest" && leaf.protocolAlias === undefined);
}

/** Check that a manifest names a committed run in its own workspace. */
export function hasAuthoritativeRun(
  leaves: readonly { kind: string; workspaceId?: string; runId?: string; protocolAlias?: string }[],
  manifest: { workspaceId: string; runId: string },
): boolean {
  return leaves.some((leaf) => leaf.kind === "run" && leaf.workspaceId === manifest.workspaceId
    && leaf.runId === manifest.runId && leaf.protocolAlias === undefined);
}

/** Missing-key initialization is safe only for a healthy empty inventory. */
export function inventoryHasRetainedState(
  epoch: readonly { count: number; bytes: number; health: string }[],
  quarantine: { count: number; bytes: number },
): boolean {
  return epoch.some((entry) => entry.count !== 0 || entry.bytes !== 0 || entry.health !== "ok")
    || quarantine.count !== 0 || quarantine.bytes !== 0;
}
