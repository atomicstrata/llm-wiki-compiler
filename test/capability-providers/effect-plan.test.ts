/**
 * @file test/capability-providers/effect-plan.test.ts
 * @description Immutable exact effect-plan matching, idempotency, and
 * separately-authorized reversal tests for Provider V2 CP-INV-14/31.
 */
import { describe, expect, it } from "vitest";
import {
  effectPlanDigest, matchEffectPlanEntry, parseEffectPlan,
} from "../../src/capability-providers/authority/effect-plan.js";
import { parseEffectId, parseSha256Digest, parseBrokerId, parseSemanticVersion } from "../../src/capability-providers/ids.js";

describe("provider effect plans", () => {
  it("matches only one exact preauthorized mutating request", () => {
    const plan = parseEffectPlan(effectPlan([effectEntry()]));
    const request = effectRequest();
    expect(matchEffectPlanEntry(plan, request)).toMatchObject({
      entry: { effectId: "effect-one", idempotencyKey: "idempotency-one" },
      entryDigest: expect.stringMatching(/^sha256:/),
    });
    expect(effectPlanDigest(plan)).toMatch(/^sha256:/);
  });

  it.each([
    ["targetIdentity", "other-target"], ["requestDigest", `sha256:${"e".repeat(64)}`],
    ["idempotencyKey", "other-key"], ["brokerContractVersion", "2.0.0"],
  ] as const)("refuses a request whose %s differs", (field, value) => {
    const plan = parseEffectPlan(effectPlan([effectEntry()]));
    expect(() => matchEffectPlanEntry(plan, { ...effectRequest(), [field]: value }))
      .toThrow(/effect is not approved/i);
  });

  it("requires a reversal to be a separate entry with a new identity and idempotency key", () => {
    const reversal = {
      ...effectEntry(), effectId: "effect-two", idempotencyKey: "idempotency-two",
      requestDigest: `sha256:${"e".repeat(64)}`, reversesEffectId: "effect-one",
    };
    const plan = parseEffectPlan(effectPlan([effectEntry(), reversal]));
    expect(plan.entries[1]).toMatchObject({ effectId: "effect-two", reversesEffectId: "effect-one" });
    expect(() => parseEffectPlan(effectPlan([
      effectEntry(), { ...reversal, idempotencyKey: "idempotency-one" },
    ]))).toThrow(/idempotency.*duplicate/i);
  });

  it("snapshots entries and rejects unknown fields", () => {
    const entry = effectEntry();
    const plan = parseEffectPlan(effectPlan([entry]));
    entry.targetIdentity = "changed";
    expect(plan.entries[0].targetIdentity).toBe("remote-target");
    expect(() => parseEffectPlan(effectPlan([{ ...effectEntry(), extra: true }])))
      .toThrow(/effect plan is invalid/i);
  });

  it("allows zero expected ceilings", () => {
    expect(parseEffectPlan(effectPlan([
      { ...effectEntry(), expectedBounds: { requests: 0 } },
    ])).entries[0].expectedBounds.requests).toBe(0);
  });

  it("refuses 65 effects in one effect class", () => {
    const entries = Array.from({ length: 65 }, (_, index) => ({
      ...effectEntry(), effectId: `effect-${index}`, idempotencyKey: `idempotency-${index}`,
    }));
    expect(() => parseEffectPlan(effectPlan(entries))).toThrow(/effect plan is invalid/i);
  });
});

function effectPlan(entries: readonly unknown[]) {
  return { schemaVersion: 1, bounds: bounds(100), entries };
}

function effectEntry() {
  return {
    effectId: "effect-one", effectClass: "remote-write", brokerId: "remote-broker",
    brokerContractVersion: "1.0.0", targetIdentity: "remote-target",
    requestDigest: `sha256:${"d".repeat(64)}`, idempotencyKey: "idempotency-one",
    expectedBounds: { requests: 1, bytes: 1024 }, requiredConfirmationClass: "operator",
    rollbackSemantics: "follow-up-effect-only", reversesEffectId: null,
  };
}

function effectRequest() {
  return {
    effectId: parseEffectId("effect-one"), effectClass: "remote-write",
    brokerId: parseBrokerId("remote-broker"), brokerContractVersion: parseSemanticVersion("1.0.0"),
    targetIdentity: "remote-target", requestDigest: parseSha256Digest(`sha256:${"d".repeat(64)}`),
    idempotencyKey: "idempotency-one", expectedBounds: { requests: 1, bytes: 1024 },
    requiredConfirmationClass: "operator", rollbackSemantics: "follow-up-effect-only" as const,
    reversesEffectId: null,
  };
}

function bounds(maximum: number) {
  return { structuredInputBytes: maximum, materializedInputFiles: maximum,
    materializedInputBytes: maximum, scratchFiles: maximum, scratchBytes: maximum,
    outputFiles: maximum, outputBytes: maximum, custodyScanBytes: maximum,
    custodyWallTimeMs: maximum, protocolFrames: maximum, protocolBytes: maximum,
    brokerRequests: maximum, mutatingEffects: maximum, wallTimeMs: maximum,
    cpuTimeMs: maximum, memoryBytes: maximum, processCount: maximum };
}
