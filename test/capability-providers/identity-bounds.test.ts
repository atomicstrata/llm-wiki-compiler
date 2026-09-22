/**
 * @file test/capability-providers/identity-bounds.test.ts
 * @description Provider V2 hostile-identity byte ceilings, Windows device
 * exclusions, and bounded non-coercing diagnostic coverage.
 */
import { describe, expect, it, vi } from "vitest";
import * as limits from "../../src/capability-providers/constants.js";
import * as ids from "../../src/capability-providers/ids.js";
import { parseProviderId } from "../../src/capability-providers/ids.js";
import type { ProviderLogicalIdV1 } from "../../src/capability-providers/types.js";

type IdParser = (value: unknown) => string;
const PATH_ID_PARSERS: readonly [string, IdParser][] = [
  ["provider", parseProviderId],
  ["capability", ids.parseCapabilityId],
  ["broker", ids.parseBrokerId],
  ["input", ids.parseInputId],
  ["invocation", ids.parseInvocationId],
  ["request", ids.parseRequestId],
  ["effect", ids.parseEffectId],
  ["receipt", ids.parseReceiptId],
  ["backend", ids.parseBackendId],
];

const WINDOWS_DEVICE_BASENAMES = [
  "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5",
  "com6", "com7", "com8", "com9", "lpt1", "lpt2", "lpt3", "lpt4",
  "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

const IDENTITY_LIMITS: Record<string, number> = {
  MAX_PROVIDER_COORDINATE_COMPONENT_BYTES: 128,
  MAX_CAPABILITY_CONTRACT_VERSION_BYTES: 256,
  MAX_PROVIDER_LOGICAL_ID_BYTES: 128,
  MAX_PROVIDER_LOGICAL_ID_SNAPSHOT_ITEMS: 4_096,
  MAX_PROVIDER_SEMANTIC_VERSION_BYTES: 256,
  MAX_PROVIDER_COORDINATE_BYTES: 1_024,
};

describe("Provider V2 identity byte ceilings", () => {
  it("exports every dated identity ceiling as a named constant", () => {
    for (const [name, expected] of Object.entries(IDENTITY_LIMITS)) {
      expect((limits as Record<string, unknown>)[name], name).toBe(expected);
    }
  });

  it.each(PATH_ID_PARSERS)("accepts 127/128 ASCII bytes and rejects 129 for %s IDs", (_kind, parse) => {
    expect(parse("a".repeat(127))).toBe("a".repeat(127));
    expect(parse("a".repeat(128))).toBe("a".repeat(128));
    expect(() => parse("a".repeat(129))).toThrow(/exceeds 128 UTF-8 bytes/);
  });

  it.each(PATH_ID_PARSERS)("checks multibyte %s ID bytes before grammar evaluation", (_kind, parse) => {
    expect(() => parse("é".repeat(63))).toThrow(/required grammar/);
    expect(() => parse("é".repeat(64))).toThrow(/required grammar/);
    expect(() => parse("é".repeat(65))).toThrow(/exceeds 128 UTF-8 bytes/);
  });

  it("enforces 128 bytes on every provider coordinate component", () => {
    for (const component of ["tap", "publisher", "provider"] as const) {
      expect(componentCoordinate(component, 127)).toMatchObject(componentValue(component, 127));
      expect(componentCoordinate(component, 128)).toMatchObject(componentValue(component, 128));
      expect(() => componentCoordinate(component, 129)).toThrow(/exceeds 128 UTF-8 bytes/);
    }
  });

  it.each(["tap", "publisher", "provider"] as const)(
    "checks multibyte %s component bytes before grammar evaluation",
    (component) => {
      expect(() => componentCoordinateValue(component, "é".repeat(63))).toThrow(/required grammar/);
      expect(() => componentCoordinateValue(component, "é".repeat(64))).toThrow(/required grammar/);
      expect(() => componentCoordinateValue(component, "é".repeat(65))).toThrow(/exceeds 128 UTF-8 bytes/);
    },
  );

  it("accepts 255/256-byte SemVer and rejects 257 before its regex", () => {
    expect(ids.parseSemanticVersion(buildVersion(255))).toBe(buildVersion(255));
    expect(ids.parseSemanticVersion(buildVersion(256))).toBe(buildVersion(256));
    expect(() => ids.parseSemanticVersion(buildVersion(257))).toThrow(/exceeds 256 UTF-8 bytes/);
  });

  it("checks multibyte SemVer bytes at the 256-byte edge before its regex", () => {
    expect(() => ids.parseSemanticVersion("é".repeat(127))).toThrow(/required grammar/);
    expect(() => ids.parseSemanticVersion("é".repeat(128))).toThrow(/required grammar/);
    expect(() => ids.parseSemanticVersion("é".repeat(129))).toThrow(/exceeds 256 UTF-8 bytes/);
  });

  it("preserves 256 opaque contract-version bytes and rejects 257", () => {
    expect(ids.parseCapabilityContractVersion("v".repeat(256))).toBe("v".repeat(256));
    expect(() => ids.parseCapabilityContractVersion("v".repeat(257))).toThrow(
      /exceeds 256 UTF-8 bytes/,
    );
  });

  it("measures bounded multibyte contract versions exactly", () => {
    expect(ids.parseCapabilityContractVersion("é".repeat(128))).toBe("é".repeat(128));
    expect(() => ids.parseCapabilityContractVersion("é".repeat(129))).toThrow(
      /exceeds 256 UTF-8 bytes/,
    );
  });

  it("enforces the complete-coordinate ceiling before structural parsing", () => {
    expect(errorMessage(() => ids.parseProviderCoordinate("a".repeat(1_023)))).not.toMatch(/exceeds 1024/);
    expect(errorMessage(() => ids.parseProviderCoordinate("a".repeat(1_024)))).not.toMatch(/exceeds 1024/);
    expect(() => ids.parseProviderCoordinate("a".repeat(1_025))).toThrow(/exceeds 1024 UTF-8 bytes/);
  });

  it("counts multibyte complete-coordinate input at the 1,024-byte edge", () => {
    expect(errorMessage(() => ids.parseProviderCoordinate("é".repeat(511)))).not.toMatch(/exceeds 1024/);
    expect(errorMessage(() => ids.parseProviderCoordinate("é".repeat(512)))).not.toMatch(/exceeds 1024/);
    expect(() => ids.parseProviderCoordinate("é".repeat(513))).toThrow(/exceeds 1024 UTF-8 bytes/);
  });
});

describe("Provider V2 cross-platform path-facing identity safety", () => {
  it.each(PATH_ID_PARSERS.flatMap(([kind, parse]) =>
    WINDOWS_DEVICE_BASENAMES.map((value) => [value, kind, parse] as const)
  ))("rejects Windows device basename %s for %s ID", (value, _kind, parse) => {
    expect(() => parse(value)).toThrow(/reserved Windows device basename/);
  });

  it.each(WINDOWS_DEVICE_BASENAMES.flatMap((value) =>
    (["tap", "publisher", "provider"] as const).map((component) => [value, component] as const)
  ))("rejects Windows device basename %s in coordinate %s", (value, component) => {
    expect(() => componentCoordinateValue(component, value)).toThrow(/reserved Windows device basename/);
  });
});

describe("Provider V2 identity diagnostics", () => {
  it("does not coerce a rejected coordinate input", () => {
    let coerced = false;
    const hostile = {
      toString() {
        coerced = true;
        return "official/publisher/provider@1.2.3";
      },
    };
    expect(() => ids.parseProviderCoordinate(hostile)).toThrow(/expected string; received object/);
    expect(coerced).toBe(false);
  });

  it("returns a bounded refusal without reflecting hostile coordinate bytes", () => {
    const hostile = `/secret/path\u2028\u202e${"x".repeat(1_100)}SENSITIVE-END`;
    const message = errorMessage(() => ids.parseProviderCoordinate(hostile));
    for (const forbidden of ["/secret/path", "\u2028", "\u202e", "SENSITIVE-END"]) {
      expect(message).not.toContain(forbidden);
    }
    expect(message).toContain("exceeds 1024 UTF-8 bytes");
    expect(Buffer.byteLength(message, "utf8")).toBeLessThan(320);
  });

  it.each([
    ["logical ID", ids.parseProviderId],
    ["semantic version", ids.parseSemanticVersion],
    ["digest", ids.parseSha256Digest],
  ] as const)("prefilters huge %s refusals before UTF-8 scanning", (_name, parse) => {
    const hostile = "SECRET-" + "x".repeat(1_000_000);
    const byteLength = vi.spyOn(Buffer, "byteLength");
    try {
      expect(() => parse(hostile)).toThrow();
      expect(byteLength.mock.calls.some(([value]) => value === hostile)).toBe(false);
    } finally {
      byteLength.mockRestore();
    }
  });
});

describe("Provider V2 logical-ID uniqueness boundary", () => {
  it.each([
    ["grammar", "../escape", /required grammar/],
    ["Windows device", "con", /reserved Windows device basename/],
  ])("runtime-revalidates unsafe-cast %s input", (_name, value, expected) => {
    expect(() => ids.snapshotUniqueLogicalIds(unsafeLogicalIds(value), 1)).toThrow(expected);
  });

  it("bounds an oversized unsafe-cast refusal without reflecting it", () => {
    const hostile = `SECRET\u2028\u202e${"x".repeat(1_000)}SENSITIVE-END`;
    const message = logicalGuardError(unsafeLogicalIds(hostile, hostile));
    expect(message).toContain("invalid provider logical ID");
    expect(message).toContain("exceeds 128 UTF-8 bytes");
    for (const forbidden of ["SECRET", "\u2028", "\u202e", "SENSITIVE-END"]) {
      expect(message).not.toContain(forbidden);
    }
    expect(Buffer.byteLength(message, "utf8")).toBeLessThanOrEqual(512);
  });

  it("uses a bounded fixed diagnostic for a validated duplicate", () => {
    const value = ids.parseInputId("a".repeat(128));
    const message = logicalGuardError([value, value]);
    expect(message).toMatch(/invalid provider logical ID: .*duplicated/);
    expect(message).not.toContain(value);
    expect(Buffer.byteLength(message, "utf8")).toBeLessThanOrEqual(512);
  });

  it("does not coerce an unsafe-cast hostile object", () => {
    let coerced = false;
    const hostile = { toString() { coerced = true; return "safe-id"; } };
    expect(logicalGuardError(unsafeLogicalIds(hostile))).toMatch(/expected string; received object/);
    expect(coerced).toBe(false);
  });

  it("refuses an unsafe-cast null-prototype object", () => {
    expect(logicalGuardError(unsafeLogicalIds(Object.create(null)))).toMatch(
      /expected string; received object/,
    );
  });

  it("refuses an unsafe-cast revoked proxy without touching it", () => {
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    expect(logicalGuardError(unsafeLogicalIds(revocable.proxy))).toMatch(/expected string; received object/);
  });
});

function buildVersion(totalBytes: number): string {
  return `1.2.3+${"a".repeat(totalBytes - 6)}`;
}

function componentCoordinate(component: "tap" | "publisher" | "provider", bytes: number) {
  return componentCoordinateValue(component, "a".repeat(bytes));
}

function componentCoordinateValue(component: "tap" | "publisher" | "provider", value: string) {
  let coordinate = `official/publisher/${value}@1.2.3`;
  if (component === "tap") coordinate = `${value}/publisher/provider@1.2.3`;
  if (component === "publisher") coordinate = `official/${value}/provider@1.2.3`;
  return ids.parseProviderCoordinate(coordinate);
}

function componentValue(component: "tap" | "publisher" | "provider", bytes: number) {
  const field = component === "provider" ? "providerId" : component;
  return { [field]: "a".repeat(bytes) };
}

function errorMessage(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return (error as Error).message;
  }
  throw new Error("expected identity parser failure");
}

function unsafeLogicalIds(...values: unknown[]): readonly ProviderLogicalIdV1[] {
  return values as readonly ProviderLogicalIdV1[];
}

function logicalGuardError(values: readonly ProviderLogicalIdV1[]): string {
  return errorMessage(() => ids.snapshotUniqueLogicalIds(values, values.length));
}
