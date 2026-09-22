/**
 * @file test/capability-providers/logical-id-snapshot.test.ts
 * @description Adversarial Provider logical-ID snapshot capture coverage for
 * bounded indexed copying, caller-controlled iteration, and fixed refusals.
 */
import { describe, expect, it } from "vitest";
import * as limits from "../../src/capability-providers/constants.js";
import {
  parseInputId,
  parseRequestId,
  snapshotUniqueLogicalIds,
} from "../../src/capability-providers/ids.js";
import type { ProviderLogicalIdV1 } from "../../src/capability-providers/types.js";

const HOST_MAXIMUM = 4_096;
const SNAPSHOT_ERROR = "invalid provider logical ID snapshot";
const HOSTILE_CEILINGS = hostileCeilings();

describe("Provider logical-ID indexed snapshots", () => {
  it("exports the host snapshot ceiling", () => {
    expect((limits as Record<string, unknown>).MAX_PROVIDER_LOGICAL_ID_SNAPSHOT_ITEMS).toBe(
      HOST_MAXIMUM,
    );
  });

  it("never invokes a caller-owned iterator", () => {
    const values = [parseInputId("source-one"), parseRequestId("request_two")];
    Object.defineProperty(values, Symbol.iterator, {
      value: () => { throw new Error("SECRET_ITERATOR_CANARY"); },
    });
    expect(snapshotUniqueLogicalIds(values, 2)).toEqual(["source-one", "request_two"]);
  });

  it("does not let a growing iterator widen the captured range", () => {
    const first = parseInputId("source-one");
    const second = parseInputId("source-two");
    const values = [first];
    Object.defineProperty(values, Symbol.iterator, {
      value: function* () { values.push(second); yield first; yield second; },
    });
    expect(snapshotUniqueLogicalIds(values, 1)).toEqual([first]);
    expect(values).toHaveLength(1);
  });

  it("does not let a shrinking iterator narrow the captured range", () => {
    const values = [parseInputId("source-one"), parseInputId("source-two")];
    Object.defineProperty(values, Symbol.iterator, {
      value: function* () { values.pop(); yield values[0]; },
    });
    expect(snapshotUniqueLogicalIds(values, 2)).toEqual(["source-one", "source-two"]);
    expect(values).toHaveLength(2);
  });

  it("requires an actual array rather than an iterable lookalike", () => {
    const value = parseInputId("source-one");
    const lookalike = {
      0: value,
      length: 1,
      *[Symbol.iterator]() { yield value; },
    } as unknown as readonly ProviderLogicalIdV1[];
    expect(snapshotError(lookalike, 1)).toBe(SNAPSHOT_ERROR);
  });

  it("refuses holes before treating inherited storage as input", () => {
    const values = new Array(2) as ProviderLogicalIdV1[];
    values[0] = parseInputId("source-one");
    expect(snapshotError(values, 2)).toBe(SNAPSHOT_ERROR);
  });

  it("refuses indexed accessors without invoking them", () => {
    const values = [parseInputId("source-one")];
    let reads = 0;
    Object.defineProperty(values, 0, {
      configurable: true,
      get: () => { reads += 1; throw new Error("SECRET_INDEX_CANARY"); },
    });
    expect(snapshotError(values, 1)).toBe(SNAPSHOT_ERROR);
    expect(reads).toBe(0);
  });

  it("translates changing or throwing proxy reads to the fixed refusal", () => {
    const value = parseInputId("source-one");
    const changing = new Proxy([value], {
      get: (target, key, receiver) => {
        if (key === "length") throw new Error("SECRET_LENGTH_CANARY");
        return Reflect.get(target, key, receiver);
      },
    });
    expect(snapshotError(changing, 1)).toBe(SNAPSHOT_ERROR);
  });

  it("translates a revoked array proxy to the fixed refusal", () => {
    const revocable = Proxy.revocable([parseInputId("source-one")], {});
    revocable.revoke();
    expect(snapshotError(revocable.proxy, 1)).toBe(SNAPSHOT_ERROR);
  });

  it("checks the context ceiling before any indexed read", () => {
    const values = new Array(2) as ProviderLogicalIdV1[];
    let reads = 0;
    Object.defineProperty(values, 0, { get: () => { reads += 1; return "source-one"; } });
    expect(snapshotError(values, 1)).toBe(SNAPSHOT_ERROR);
    expect(reads).toBe(0);
  });
});

describe("Provider logical-ID snapshot ceilings", () => {
  it("accepts the zero and one item boundaries", () => {
    const empty = snapshotUniqueLogicalIds([], 0);
    const one = snapshotUniqueLogicalIds([parseInputId("source-one")], 1);
    expect(empty).toEqual([]);
    expect(one).toEqual(["source-one"]);
    expect(Object.isFrozen(empty) && Object.isFrozen(one)).toBe(true);
  });

  it("accepts exactly 4,096 unique identities", () => {
    const values = logicalIds(HOST_MAXIMUM);
    expect(snapshotUniqueLogicalIds(values, HOST_MAXIMUM)).toEqual(values);
  });

  it("rejects 4,097 identities before copying", () => {
    expect(snapshotError(logicalIds(HOST_MAXIMUM + 1), HOST_MAXIMUM)).toBe(SNAPSHOT_ERROR);
  });

  it.each([-1, 4_097, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "1", undefined])(
    "rejects invalid caller ceiling %s",
    (ceiling) => expect(snapshotWithUnknownCeiling([], ceiling)).toBe(SNAPSHOT_ERROR),
  );

  it.each(HOSTILE_CEILINGS)(
    "refuses $name before caller hooks or array observation",
    ({ ceiling, hookReads }) => {
      const observed = observedArray();
      expect(snapshotWithUnknownCeiling(observed.values, ceiling)).toBe(SNAPSHOT_ERROR);
      expect(hookReads()).toBe(0);
      expect(observed.reads()).toBe(0);
    },
  );
});

interface HostileCeiling {
  readonly name: string;
  readonly ceiling: unknown;
  readonly hookReads: () => number;
}

function hostileCeilings(): readonly HostileCeiling[] {
  const primitive = countedCeiling(Symbol.toPrimitive);
  const valueOf = countedCeiling("valueOf");
  const boxed = countedBoxedNumber();
  const proxy = countedProxyCeiling();
  const revoked = Proxy.revocable({ valueOf: () => 1 }, {});
  revoked.revoke();
  return [
    { name: "throwing Symbol.toPrimitive object", ...primitive },
    { name: "throwing valueOf object", ...valueOf },
    { name: "symbol", ceiling: Symbol("ceiling"), hookReads: () => 0 },
    { name: "bigint", ceiling: 1n, hookReads: () => 0 },
    { name: "boxed number", ...boxed },
    { name: "transparent proxy", ...proxy },
    { name: "revoked proxy", ceiling: revoked.proxy, hookReads: () => 0 },
    { name: "long numeric string", ceiling: "9".repeat(1_000_000), hookReads: () => 0 },
  ];
}

function countedCeiling(key: "valueOf" | typeof Symbol.toPrimitive) {
  let reads = 0;
  return {
    ceiling: { [key]: () => { reads += 1; throw new Error("SECRET_CEILING_CANARY"); } },
    hookReads: () => reads,
  };
}

function countedBoxedNumber() {
  let reads = 0;
  const ceiling = new Number(1);
  ceiling.valueOf = () => { reads += 1; throw new Error("SECRET_BOXED_CEILING"); };
  return { ceiling, hookReads: () => reads };
}

function countedProxyCeiling() {
  let reads = 0;
  const ceiling = new Proxy({ valueOf: () => 1 }, {
    get: (target, key, receiver) => { reads += 1; return Reflect.get(target, key, receiver); },
  });
  return { ceiling, hookReads: () => reads };
}

function observedArray() {
  let reads = 0;
  const values = new Proxy([] as ProviderLogicalIdV1[], {
    get: (target, key, receiver) => { reads += 1; return Reflect.get(target, key, receiver); },
    getOwnPropertyDescriptor: (target, key) => {
      reads += 1;
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  return { values, reads: () => reads };
}

function logicalIds(count: number): ProviderLogicalIdV1[] {
  return Array.from({ length: count }, (_, index) => parseInputId(`source-${index}`));
}

function snapshotError(values: readonly ProviderLogicalIdV1[], ceiling: number): string {
  try {
    snapshotUniqueLogicalIds(values, ceiling);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected logical-ID snapshot refusal");
}

function snapshotWithUnknownCeiling(
  values: readonly ProviderLogicalIdV1[],
  ceiling: unknown,
): string {
  const snapshot = snapshotUniqueLogicalIds as unknown as (
    input: readonly ProviderLogicalIdV1[],
    maximumItems: unknown,
  ) => readonly ProviderLogicalIdV1[];
  try {
    snapshot(values, ceiling);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected invalid snapshot ceiling refusal");
}
