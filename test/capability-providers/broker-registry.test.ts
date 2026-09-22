/**
 * @file test/capability-providers/broker-registry.test.ts
 * @description Closed broker-registry, request-envelope, and host-minted
 * receipt grammar tests for Provider V2 Task 6.
 */
import { describe, expect, it } from "vitest";
import { canonicalDigest } from "../../src/profile/templates/signing/canonical.js";
import {
  createHostBrokerRegistry, listHostBrokerContracts, resolveHostBrokerContract,
} from "../../src/capability-providers/brokers/registry.js";
import {
  deriveExternalEffectId, externalEffectReceiptDigest, mintExternalEffectReceipt,
} from "../../src/capability-providers/brokers/receipts.js";
import { parseBrokerRequestEnvelope } from "../../src/capability-providers/brokers/types.js";
import {
  parseBrokerId, parseEffectId, parseInvocationId, parseSha256Digest, parseSemanticVersion,
} from "../../src/capability-providers/ids.js";

const EXPECTED_BROKERS = [
  "https", "model", "repository", "command", "scheduler", "email", "remote-effect",
] as const;

describe("closed host broker registry", () => {
  it("contains exactly the seven reviewed Provider V2 broker contracts", () => {
    const contracts = listHostBrokerContracts(createHostBrokerRegistry());
    expect(contracts.map((entry) => entry.brokerId)).toEqual(EXPECTED_BROKERS);
    expect(contracts.every((entry) => entry.brokerContractVersion === "1.0.0")).toBe(true);
    expect(Object.isFrozen(contracts)).toBe(true);
    expect(contracts.every(Object.isFrozen)).toBe(true);
  });

  it("has no caller registration seam and fails closed for unknown contracts", () => {
    const registry = createHostBrokerRegistry();
    expect(Object.keys(registry)).toEqual([]);
    expect(resolveHostBrokerContract(registry, "unknown", "1.0.0")).toBeUndefined();
    expect(resolveHostBrokerContract(registry, "https", "2.0.0")).toBeUndefined();
    expect(resolveHostBrokerContract(registry, "https", "1.0.0")).toMatchObject({
      brokerId: "https", grantKind: "network.https", access: "conditional",
    });
  });
});

describe("broker request envelope grammar", () => {
  it("captures the exact request envelope and rejects receipt smuggling", () => {
    const request = brokerRequest();
    const parsed = parseBrokerRequestEnvelope(request);
    request.payload.path = "/mutated";
    expect(parsed).toMatchObject({ requestId: "request-one", brokerId: "https" });
    expect(parsed.payload).toEqual({ method: "GET", path: "/v1/items" });
    expect(() => parseBrokerRequestEnvelope({ ...brokerRequest(), receipt: receiptInput() }))
      .toThrow(/broker request is invalid/i);
  });

  it("rejects unknown broker IDs, contract versions, proxies, and accessors", () => {
    expect(() => parseBrokerRequestEnvelope({ ...brokerRequest(), brokerId: "UPPER" }))
      .toThrow(/broker request is invalid/i);
    expect(() => parseBrokerRequestEnvelope({ ...brokerRequest(), brokerContractVersion: "latest" }))
      .toThrow(/broker request is invalid/i);
    expect(() => parseBrokerRequestEnvelope(new Proxy(brokerRequest(), {})))
      .toThrow(/broker request is invalid/i);
    const request = brokerRequest() as Record<string, unknown>;
    Object.defineProperty(request, "payload", { get: () => ({}) });
    expect(() => parseBrokerRequestEnvelope(request)).toThrow(/broker request is invalid/i);
  });

  it("rejects aggregate envelope bytes before request digesting", () => {
    const oversizedPart = "x".repeat(600 * 1024);
    expect(() => parseBrokerRequestEnvelope({
      ...brokerRequest(), payload: { first: oversizedPart, second: oversizedPart },
    })).toThrow(/broker request is invalid/i);
  });

  it("rejects canonical envelope syntax that pushes captured content over one MiB", () => {
    const payload = Object.fromEntries(Array.from({ length: 4_096 }, (_value, index) => [
      `${String(index).padStart(4, "0")}${"k".repeat(246)}`, "",
    ]));
    expect(() => parseBrokerRequestEnvelope({ ...brokerRequest(), payload }))
      .toThrow(/broker request is invalid/i);
  });
});

describe("host-minted external effect receipts", () => {
  it("derives effect IDs from preparation, invocation, and request index", () => {
    const base = deriveExternalEffectId("preparation-one", "invocation-one", 0);
    expect(base).toMatch(/^effect-[0-9a-f]{64}$/);
    expect(deriveExternalEffectId("preparation-two", "invocation-one", 0)).not.toBe(base);
    expect(deriveExternalEffectId("preparation-one", "invocation-two", 0)).not.toBe(base);
    expect(deriveExternalEffectId("preparation-one", "invocation-one", 1)).not.toBe(base);
  });

  it("mints an immutable canonical receipt from matched host facts", () => {
    const receipt = mintExternalEffectReceipt(receiptInput());
    expect(receipt).toMatchObject({
      schemaVersion: 1, effectId: "effect-one", brokerId: "remote-effect",
      outcome: "applied", sensitiveFieldsOmitted: true,
    });
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(externalEffectReceiptDigest(receipt)).toBe(digest(canonicalDigest(receipt).slice(7)));
  });

  it("rejects mismatched request facts, secret-shaped extras, and invalid unknown outcomes", () => {
    expect(() => mintExternalEffectReceipt({ ...receiptInput(), requestDigest: digest("b") }))
      .toThrow(/effect receipt is invalid/i);
    expect(() => mintExternalEffectReceipt({ ...receiptInput(), authorization: "secret" } as never))
      .toThrow(/effect receipt is invalid/i);
    expect(() => mintExternalEffectReceipt({ ...receiptInput(), outcome: "rolled-back" } as never))
      .toThrow(/effect receipt is invalid/i);
  });
});

function brokerRequest() {
  return {
    schemaVersion: 1, requestId: "request-one", brokerId: "https",
    brokerContractVersion: "1.0.0", payload: { method: "GET", path: "/v1/items" },
    effect: null,
  };
}

function receiptInput() {
  return {
    effectId: parseEffectId("effect-one"), invocationId: parseInvocationId("invocation-one"),
    providerPinDigest: digest("1"), grantSnapshotDigest: digest("2"),
    effectPlanEntryDigest: digest("3"), brokerId: parseBrokerId("remote-effect"),
    brokerContractVersion: parseSemanticVersion("1.0.0"), effectClass: "remote-write",
    targetIdentity: "remote-target", requestDigest: digest("a"),
    approvedRequestDigest: digest("a"), idempotencyKey: "idempotency-one",
    startedAt: "2026-07-18T12:00:00.000Z", completedAt: "2026-07-18T12:00:01.000Z",
    outcome: "applied" as const, observedExternalIdentity: "external-one",
    responseDigest: digest("4"), rollbackSemantics: "none" as const,
  };
}

function digest(characterOrHex: string) {
  const hex = characterOrHex.length === 64 ? characterOrHex : characterOrHex.repeat(64);
  return parseSha256Digest(`sha256:${hex}`);
}
