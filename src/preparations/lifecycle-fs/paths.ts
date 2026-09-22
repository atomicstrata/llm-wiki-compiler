/**
 * @file src/preparations/lifecycle-fs/paths.ts
 * @description Lifecycle unit paths derived only from a captured namespace.
 *
 * Callers choose a validated unit id but cannot supply a project root,
 * registry root, or cleanup destination. The existing path-schema module
 * remains the one grammar owner for unit components and fixed leaf names.
 */

import {
  preparationKeyFile,
  preparationPruneUnitPaths,
  preparationQuarantineUnitPaths,
  type PruneUnitPaths,
  type QuarantineUnitPaths,
} from "../paths.js";
import { assertPreparationLifecycleNamespaceBrand } from "./namespace.js";
import type { PreparationLifecycleNamespaceV1 } from "./types.js";

/** Derive the exact preparation-key leaf beneath the namespace authority. */
export function lifecyclePreparationKeyFile(
  namespace: PreparationLifecycleNamespaceV1,
): string {
  assertPreparationLifecycleNamespaceBrand(namespace);
  return preparationKeyFile(namespace.root.realPath);
}

/** Derive one quarantine/reset unit beneath the namespace's canonical root. */
export function lifecycleQuarantineUnitPaths(
  namespace: PreparationLifecycleNamespaceV1,
  unitId: string,
): QuarantineUnitPaths {
  assertPreparationLifecycleNamespaceBrand(namespace);
  return preparationQuarantineUnitPaths(namespace.root.realPath, unitId);
}

/** Derive one prune/sweep unit beneath the namespace's canonical root. */
export function lifecyclePruneUnitPaths(
  namespace: PreparationLifecycleNamespaceV1,
  unitId: string,
): PruneUnitPaths {
  assertPreparationLifecycleNamespaceBrand(namespace);
  return preparationPruneUnitPaths(namespace.root.realPath, unitId);
}
