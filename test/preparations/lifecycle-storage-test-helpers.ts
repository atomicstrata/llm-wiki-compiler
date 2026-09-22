/**
 * @file test/preparations/lifecycle-storage-test-helpers.ts
 * @description Shared fixture accessors for lifecycle physical-storage tests
 * spanning both bound quarantine and prune registries.
 */

import type {
  PreparationLifecycleNamespaceV1,
} from "../../src/preparations/lifecycle-fs/types.js";

/** Require one canonical present lifecycle registry path. */
export function lifecycleRegistryRoot(
  namespace: PreparationLifecycleNamespaceV1,
  registry: "quarantine" | "prune",
): string {
  const binding = registry === "quarantine"
    ? namespace.quarantineRegistry
    : namespace.pruneRegistry;
  if (binding.status !== "present") throw new Error(`${registry} registry is absent`);
  return binding.realPath;
}
