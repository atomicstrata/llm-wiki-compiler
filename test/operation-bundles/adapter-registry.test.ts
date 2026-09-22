/**
 * @file test/operation-bundles/adapter-registry.test.ts
 * @description Task 1 contract tests for the closed operation adapter registry.
 * Exactly the seven mutation kinds register, a slot/kind mismatch and unknown or
 * missing kinds fail closed, the registry is closed to post-construction
 * mutation, and the fault injector defines compensate + cancel-safe boundaries.
 */

import { describe, expect, it } from "vitest";
import {
  createOperationAdapterRegistry,
  OPERATION_MUTATION_KINDS,
  requireOperationAdapter,
  type OperationAdapterMap,
  type OperationAdapterSet,
} from "../../src/operation-bundles/adapter-registry.js";
import {
  defineOperationStoreAdapter,
  type AdapterContext,
  type OperationFaultInjector,
  type OperationStoreAdapter,
} from "../../src/operation-bundles/adapter-types.js";
import type { OperationMutation } from "../../src/operation-bundles/types.js";

/** A no-op adapter that declares one kind and never touches a store. */
function stubAdapter(kind: OperationMutation["kind"]): OperationStoreAdapter {
  return defineOperationStoreAdapter({
    kind,
    async preflight() { return { status: "ready" }; },
    async observe() { return { outcome: "not-applied" }; },
    async apply() { return { status: "unavailable", detail: "stub" }; },
    async verify() { return { status: "unavailable", detail: "stub" }; },
  });
}

/** A complete, well-formed adapter set covering every mutation kind. */
function fullSet(): OperationAdapterSet {
  return Object.fromEntries(
    OPERATION_MUTATION_KINDS.map((kind) => [kind, stubAdapter(kind)]),
  ) as OperationAdapterSet;
}

describe("createOperationAdapterRegistry", () => {
  it("registers exactly the seven mutation kinds", () => {
    const registry = createOperationAdapterRegistry(fullSet());
    expect(registry.size).toBe(7);
    expect([...registry.keys()].sort()).toEqual([...OPERATION_MUTATION_KINDS].sort());
  });

  it("rejects an adapter whose declared kind mismatches its slot", () => {
    const set = fullSet() as Record<string, OperationStoreAdapter>;
    set.page = stubAdapter("relation");
    expect(() => createOperationAdapterRegistry(set as OperationAdapterSet)).toThrow(/page/);
  });

  it("fails closed when a kind is missing", () => {
    const set = fullSet() as Record<string, OperationStoreAdapter | undefined>;
    delete set.projection;
    expect(() => createOperationAdapterRegistry(set as OperationAdapterSet)).toThrow(/projection/);
  });

  it("rejects an unknown extra kind in the adapter set", () => {
    const set = fullSet() as Record<string, OperationStoreAdapter>;
    set.bogus = stubAdapter("page");
    expect(() => createOperationAdapterRegistry(set as OperationAdapterSet)).toThrow(/bogus|unknown/);
  });

  it("is closed to post-construction mutation", () => {
    const registry = createOperationAdapterRegistry(fullSet());
    const mutable = registry as Map<OperationMutation["kind"], OperationStoreAdapter>;
    expect(() => mutable.set("page", stubAdapter("page"))).toThrow();
  });
});

describe("requireOperationAdapter", () => {
  it("fails closed on an unknown adapter kind lookup", () => {
    const registry: OperationAdapterMap = createOperationAdapterRegistry(fullSet());
    expect(() => requireOperationAdapter(registry, "nonexistent" as OperationMutation["kind"])).toThrow();
  });
});

describe("defineOperationStoreAdapter", () => {
  it("guards an adapter against a foreign mutation kind at call time", () => {
    const adapter = stubAdapter("page");
    const foreign = { mutation: { kind: "relation" } } as unknown as AdapterContext;
    expect(() => adapter.observe(foreign)).toThrow(/page/);
  });
});

describe("OperationFaultInjector", () => {
  it("defines compensate and cancel-safe-point boundaries", () => {
    const fault: OperationFaultInjector = {
      async beforeCompensate() {}, async afterCompensate() {}, async atCancelSafePoint() {},
    };
    expect(typeof fault.atCancelSafePoint).toBe("function");
  });
});
