/**
 * @file test/capability-providers/problem-codes.test.ts
 * @description Exhaustive Provider V2 stable-problem serialization, runtime
 * immutability, and hostile bounded-refusal coverage.
 */
import { describe, expect, it, vi } from "vitest";
import {
  parseProviderProblemCode,
  PROVIDER_PROBLEM_CODES,
} from "../../src/capability-providers/problems.js";

const EXPECTED_CODES = [
  "provider-not-installed",
  "provider-package-missing",
  "provider-package-integrity-invalid",
  "provider-signature-invalid",
  "provider-revoked",
  "provider-revocation-evidence-stale",
  "provider-local-unverified",
  "provider-host-incompatible",
  "provider-protocol-incompatible",
  "provider-platform-incompatible",
  "provider-isolation-unavailable",
  "provider-broker-unavailable",
  "provider-grant-missing",
  "provider-credential-missing",
  "provider-credential-unreadable",
  "provider-bounds-invalid",
  "provider-protocol-invalid",
  "provider-output-invalid",
  "provider-timed-out",
  "provider-resource-exhausted",
  "provider-cancelled",
  "provider-terminated",
  "provider-failed",
  "provider-partial",
  "provider-drift",
  "provider-effect-not-approved",
  "provider-effect-outcome-unknown",
  "provider-store-unavailable",
] as const;
const FUTURE_CODE = "provider-future-failure";
const FIXED_OBJECT_REFUSAL = "unknown provider problem code: expected string; received object";
const VOCABULARY_MUTATIONS = [
  ["add", (codes: string[]) => codes.push(FUTURE_CODE)],
  ["remove", (codes: string[]) => codes.pop()],
  ["replace", (codes: string[]) => { codes[0] = FUTURE_CODE; }],
  ["reorder", (codes: string[]) => codes.reverse()],
] as const;

describe("Provider V2 problem codes", () => {
  it("exports the complete stable taxonomy in normative order", () => {
    expect(PROVIDER_PROBLEM_CODES).toEqual(EXPECTED_CODES);
    expect(Object.isFrozen(PROVIDER_PROBLEM_CODES)).toBe(true);
  });

  it.each(VOCABULARY_MUTATIONS)("cannot %s a code or diverge from parser membership", (_name, mutate) => {
    const observation = observeVocabularyMutation(mutate);
    expect(observation.error).toBeInstanceOf(TypeError);
    expect(observation.enumerated).toEqual(EXPECTED_CODES);
    expect(observation.accepted).toEqual(observation.enumerated);
  });

  it.each(EXPECTED_CODES)("round-trips %s through JSON without drift", (code) => {
    const serialized = JSON.stringify({ code });
    const parsed = JSON.parse(serialized) as { code: unknown };
    expect(parseProviderProblemCode(parsed.code)).toBe(code);
  });

  it("rejects an unknown code instead of converting it to provider-failed", () => {
    expect(() => parseProviderProblemCode("provider-future-failure")).toThrow(/unknown provider problem code/);
  });
});

describe("Provider V2 problem-code refusal diagnostics", () => {
  it("bounds an oversized refusal without reflecting hostile bytes", () => {
    const hostile = `/private/key\u2028\u2029\u202e${"x".repeat(2_000)}SENSITIVE-END`;
    const message = problemError(hostile);
    expect(message).toBe("unknown provider problem code: unrecognized string");
    const unsafeFragments = ["/private/key", "\u2028", "\u2029", "\u202e", "SENSITIVE-END"];
    expect(unsafeFragments.filter((fragment) => message.includes(fragment))).toEqual([]);
    expect(Buffer.byteLength(message, "utf8")).toBeLessThanOrEqual(512);
  });

  it("prefilters huge unknown codes before UTF-8 scanning", () => {
    const hostile = `SECRET-${"x".repeat(1_000_000)}`;
    const byteLength = vi.spyOn(Buffer, "byteLength");
    try {
      expect(problemError(hostile)).toBe("unknown provider problem code: unrecognized string");
      expect(byteLength.mock.calls.some(([value]) => value === hostile)).toBe(false);
    } finally {
      byteLength.mockRestore();
    }
  });

  it("refuses a null-prototype object with only its fixed type marker", () => {
    expect(problemError(Object.create(null))).toBe(FIXED_OBJECT_REFUSAL);
  });

  it("does not invoke caller coercion or iteration hooks", () => {
    let interactions = 0;
    const hostile = coercionTrap(() => { interactions += 1; });
    expect(problemError(hostile)).toBe(FIXED_OBJECT_REFUSAL);
    expect(interactions).toBe(0);
  });

  it("refuses a revoked proxy without touching it", () => {
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    expect(problemError(revocable.proxy)).toBe(FIXED_OBJECT_REFUSAL);
  });
});

function observeVocabularyMutation(mutate: (codes: string[]) => unknown) {
  const mutable = PROVIDER_PROBLEM_CODES as unknown as string[];
  const original = [...mutable];
  let error: unknown;
  try {
    mutate(mutable);
  } catch (caught) {
    error = caught;
  }
  const enumerated = [...mutable];
  const accepted = parserMembership([...EXPECTED_CODES, FUTURE_CODE]);
  if (JSON.stringify(mutable) !== JSON.stringify(original)) mutable.splice(0, mutable.length, ...original);
  return { error, enumerated, accepted };
}

function parserMembership(candidates: readonly string[]): string[] {
  return candidates.filter((candidate) => {
    try {
      parseProviderProblemCode(candidate);
      return true;
    } catch {
      return false;
    }
  });
}

function coercionTrap(observe: () => void) {
  return {
    toString() { observe(); return FUTURE_CODE; },
    valueOf() { observe(); return FUTURE_CODE; },
    [Symbol.toPrimitive]() { observe(); return FUTURE_CODE; },
    [Symbol.iterator]() { observe(); return [][Symbol.iterator](); },
  };
}

function problemError(value: unknown): string {
  try {
    parseProviderProblemCode(value);
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return (error as Error).message;
  }
  throw new Error("expected provider problem-code refusal");
}
