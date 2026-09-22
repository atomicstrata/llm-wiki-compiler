/**
 * @file src/operation-bundles/adapter-registry.ts
 * @description The closed operation adapter registry and the core-constructed
 * operation runtime. The registry takes exactly one adapter per literal mutation
 * kind, validates each adapter's declared kind against its slot, and freezes a
 * map that rejects post-construction mutation. There is no `register()` method
 * and no way to derive an adapter from manifest data: every adapter is supplied
 * by core at construction time.
 */

import type { OperationFaultInjector, OperationStoreAdapter } from "./adapter-types.js";
import type { OperationAuthorityProvider } from "./authority.js";
import type { Clock } from "./stage.js";
import type { OperationMutation } from "./types.js";

/** The seven closed authoritative mutation kinds, in creation order. */
export const OPERATION_MUTATION_KINDS = Object.freeze([
  "source-retain", "page", "relation", "lifecycle-transition", "artifact",
  "catalog-record", "projection",
] as const);

export type OperationMutationKind = OperationMutation["kind"];

/** One adapter per literal kind, supplied to the registry constructor. */
export type OperationAdapterSet = { readonly [K in OperationMutationKind]: OperationStoreAdapter };

/** The frozen, closed adapter map keyed by the seven mutation-kind literals. */
export type OperationAdapterMap = ReadonlyMap<OperationMutationKind, OperationStoreAdapter>;

/** The core-constructed, injected runtime the executor and recovery consume. */
export interface OperationRuntime {
  authority: OperationAuthorityProvider;
  adapters: OperationAdapterMap;
  clock: Clock;
  fault?: OperationFaultInjector;
}

/** Replace mutating map methods with a fail-closed guard and freeze the map. */
function closeRegistry(map: Map<OperationMutationKind, OperationStoreAdapter>): OperationAdapterMap {
  const guard = (): never => {
    throw new Error("operation adapter registry is closed to mutation");
  };
  Object.defineProperties(map, {
    set: { value: guard }, delete: { value: guard }, clear: { value: guard },
  });
  return Object.freeze(map);
}

/** Reject any adapter-set key that is not one of the seven closed kinds. */
function assertNoUnknownKinds(adapters: OperationAdapterSet): void {
  const known = new Set<string>(OPERATION_MUTATION_KINDS);
  for (const key of Object.keys(adapters)) {
    if (!known.has(key)) throw new Error(`operation adapter registry has an unknown kind ${key}`);
  }
}

/**
 * Build the closed adapter registry. One adapter is required for each literal
 * kind, each adapter's declared kind must equal its slot, unknown extra kinds
 * fail closed, and the returned map is closed to mutation. There is deliberately
 * no dynamic `register()` seam.
 */
export function createOperationAdapterRegistry(adapters: OperationAdapterSet): OperationAdapterMap {
  const map = new Map<OperationMutationKind, OperationStoreAdapter>();
  for (const kind of OPERATION_MUTATION_KINDS) {
    const adapter = adapters[kind];
    if (adapter === undefined) {
      throw new Error(`operation adapter registry is missing the ${kind} adapter`);
    }
    if (adapter.kind !== kind) {
      throw new Error(`operation adapter for ${kind} declares kind ${adapter.kind}`);
    }
    map.set(kind, adapter);
  }
  assertNoUnknownKinds(adapters);
  return closeRegistry(map);
}

/** Look up one adapter by kind, failing closed on an unknown or mismatched kind. */
export function requireOperationAdapter(
  registry: OperationAdapterMap,
  kind: OperationMutationKind,
): OperationStoreAdapter {
  const adapter = registry.get(kind);
  if (adapter === undefined || adapter.kind !== kind) {
    throw new Error(`no operation adapter is registered for ${kind}`);
  }
  return adapter;
}
