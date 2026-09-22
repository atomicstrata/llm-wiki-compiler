/**
 * @file test/preparations/task7-capture-invariant.test.ts
 * @description The SYSTEMIC invariant behind the Wave O3 Task 7 remediation.
 * The capture discipline is only worth what its least-careful entry point
 * applies, so this enumerates every exported entry point of the five
 * host-authority modules and asserts each one REFUSES an accessor on any input
 * field, a proxied input, and an array-like in place of any container. A future
 * entry point that skips the canonical capture — or that ships unclassified —
 * fails here rather than at a later adversarial review.
 */

import { describe, expect, it } from "vitest";
import {
  CAPTURE_EXEMPT, ENTRY_PROBES, TASK7_MODULES, type EntryProbe,
} from "./task7-entry-points.js";

/** An array-like that answers every collection method with its own items. */
function arrayLike(items: readonly unknown[]): unknown {
  return {
    ...Object.fromEntries(items.map((item, index) => [String(index), item])),
    length: items.length,
    map: (fn: (item: unknown, index: number) => unknown) => items.map(fn),
    filter: (fn: (item: unknown) => boolean) => items.filter(fn),
    flatMap: (fn: (item: unknown) => unknown[]) => items.flatMap(fn),
    some: (fn: (item: unknown) => boolean) => items.some(fn),
    reduce: (fn: (total: unknown, item: unknown) => unknown, initial: unknown) =>
      items.reduce(fn, initial),
    [Symbol.iterator]: function* () { yield* items; },
  };
}

/** Replace one field with an own accessor that returns the same value. */
function withAccessor(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  const clone: Record<string, unknown> = { ...record };
  delete clone[key];
  Object.defineProperty(clone, key, { get: () => value, enumerable: true, configurable: true });
  return clone;
}

/** Replace one container field with an equivalent array-like. */
function withArrayLike(record: Record<string, unknown>, key: string): Record<string, unknown> {
  return { ...record, [key]: arrayLike(record[key] as readonly unknown[]) };
}

/** Every function this module exports that is not an error constructor. */
function exportedEntryPoints(module: Record<string, unknown>): readonly string[] {
  return Object.entries(module)
    .filter(([, value]) => typeof value === "function")
    .filter(([, value]) => !((value as { prototype?: unknown }).prototype instanceof Error))
    .map(([name]) => name);
}

const probeNames = new Set(ENTRY_PROBES.map((probe) => probe.name));

describe("every Task 7 entry point is classified", () => {
  it("lists each exported entry point as a capture probe or an explicit exemption", () => {
    const unclassified: string[] = [];
    for (const [moduleName, module] of Object.entries(TASK7_MODULES)) {
      for (const name of exportedEntryPoints(module)) {
        if (probeNames.has(name) || name in CAPTURE_EXEMPT) continue;
        unclassified.push(`${moduleName}.${name}`);
      }
    }
    expect(unclassified).toEqual([]);
  });

  it("keeps the probe table honest about what it actually exercises", () => {
    for (const probe of ENTRY_PROBES) {
      expect(probe.record === undefined).not.toBe(probe.container === undefined);
      if (probe.record !== undefined) expect(probe.containerFields).toBeDefined();
    }
    expect(ENTRY_PROBES.length).toBeGreaterThan(20);
  });
});

/** Assert one probe accepts its well-formed input, so refusals mean something. */
function expectBaselineAccepted(probe: EntryProbe): void {
  const input = probe.record === undefined ? probe.container!() : probe.record();
  expect(() => probe.invoke(input)).not.toThrow();
}

describe("every Task 7 entry point captures its inputs", () => {
  it.each(ENTRY_PROBES.map((probe) => [probe.name, probe] as const))(
    "%s accepts its well-formed input", (_name, probe) => {
      expectBaselineAccepted(probe);
    });

  it.each(ENTRY_PROBES.filter((probe) => probe.record !== undefined)
    .map((probe) => [probe.name, probe] as const))(
    "%s refuses an accessor on any input field", (_name, probe) => {
      const base = probe.record!();
      for (const key of Object.keys(base)) {
        expect(() => probe.invoke(withAccessor(base, key))).toThrow();
      }
    });

  it.each(ENTRY_PROBES.map((probe) => [probe.name, probe] as const))(
    "%s refuses a proxied input", (_name, probe) => {
      const input = probe.record === undefined ? probe.container!() : probe.record();
      expect(() => probe.invoke(new Proxy(input as object, {}))).toThrow();
    });

  it.each(ENTRY_PROBES.map((probe) => [probe.name, probe] as const))(
    "%s refuses an array-like in place of a container", (_name, probe) => {
      if (probe.container !== undefined) {
        const container = probe.container;
        expect(() => probe.invoke(arrayLike(container()))).toThrow();
        return;
      }
      const base = probe.record!();
      for (const field of probe.containerFields ?? []) {
        expect(() => probe.invoke(withArrayLike(base, field))).toThrow();
      }
    });
});
