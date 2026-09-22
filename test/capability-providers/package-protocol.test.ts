/**
 * @file test/capability-providers/package-protocol.test.ts
 * @description Provider-specific package grammar and identity tests. Template
 * envelopes must not cross this trust boundary even though signing primitives
 * are shared.
 */
import { describe, expect, it } from "vitest";
import {
  parseCapabilityProviderPackage, parseProviderPackageEnvelope,
} from "../../src/capability-providers/packages/protocol.js";
import { parseSignedTapIndex } from "../../src/profile/templates/signing/protocol.js";
import { emptyPublisherPinState } from "../../src/profile/templates/signing/continuity.js";
import { verifyProviderDistribution } from "../../src/capability-providers/packages/verify.js";
import {
  payloadWithBrokerRequirements, payloadWithDuplicateHostArtifact, providerDistribution,
  providerIndex, RESEARCH_BROKER_REQUIREMENT, rotatedProviderDistribution, TAP,
} from "../fixtures/capability-provider-package.js";

describe("provider package protocol", () => {
  it("rejects a template payload at the provider envelope boundary", () => {
    const envelope = {
      schemaVersion: 1,
      coordinate: "official/atomicstrata/research@1.0.0",
      payload: { schemaVersion: 1, templateId: "research" },
      payloadDigest: `sha256:${"a".repeat(64)}`,
      publisherSignature: { keyId: "publisher-1", algorithm: "ed25519", value: "AA==" },
    };
    expect(() => parseProviderPackageEnvelope(JSON.stringify(envelope))).toThrow(/packageKind/);
  });
});

describe("provider package verification", () => {
  it("parses and verifies a provider-specific signed envelope", () => {
    const fixture = providerDistribution();
    const envelope = parseProviderPackageEnvelope(JSON.stringify(fixture.envelope));
    const verified = verifyProviderDistribution({
      envelope,
      index: parseSignedTapIndex(JSON.stringify(fixture.index)),
      expectedTap: "official",
      trustedTapKey: TAP.publicKey,
      priorPins: emptyPublisherPinState("official"),
      currentVersion: "1.1.0",
      now: new Date("2026-07-17T12:00:00Z"),
    });
    expect(verified.payload.providerId).toBe("research");
    expect(verified.manifest.capabilities[0].capabilityId).toBe("discover");
  });

  it("refuses coordinate substitution even with otherwise valid signed bytes", () => {
    const fixture = providerDistribution();
    const envelope = { ...fixture.envelope, coordinate: "official/atomicstrata/other@1.0.0" };
    const parsed = parseProviderPackageEnvelope(JSON.stringify(envelope));
    expect(() => verifyProviderDistribution({
      envelope: parsed,
      index: parseSignedTapIndex(JSON.stringify(fixture.index)),
      expectedTap: "official",
      trustedTapKey: TAP.publicKey,
      priorPins: emptyPublisherPinState("official"),
      currentVersion: "1.1.0",
      now: new Date("2026-07-17T12:00:00Z"),
    })).toThrow(/coordinate|signature|identity/);
  });
});

describe("provider package continuity", () => {
  it("rejects expired indexes before accepting package provenance", () => {
    const fixture = providerDistribution();
    const expired = { ...fixture, index: providerIndex(String(fixture.envelope.payloadDigest), {
      expiresAt: "2026-07-17T01:00:00Z",
    }) };
    expect(() => verifyFixture(expired, emptyPublisherPinState("official"))).toThrow(/expired/);
  });

  it("rejects rollback and immutable-coordinate forks", () => {
    const first = providerDistribution();
    const accepted = verifyFixture(first, emptyPublisherPinState("official")).pins;
    expect(() => verifyFixture(first, accepted)).toThrow(/rollback|replay/);
    const fork = providerDistribution({ "package/bin/provider": "different" });
    const forked = { ...fork, index: providerIndex(String(fork.envelope.payloadDigest), { sequence: 2 }) };
    expect(() => verifyFixture(forked, accepted)).toThrow(/remapped/);
  });

  it("accepts a dual-signed publisher rotation then enforces revocation", () => {
    const first = providerDistribution();
    const pins = verifyFixture(first, emptyPublisherPinState("official")).pins;
    const rotated = rotatedProviderDistribution();
    const accepted = verifyFixture(rotated, pins);
    const revoked = providerDistribution();
    const revokedIndex = providerIndex(String(revoked.envelope.payloadDigest), {
      sequence: 3, publishers: rotated.index.publishers, rotations: rotated.index.rotations,
      revocations: [{ kind: "package", value: String(revoked.envelope.payloadDigest), reason: "test", revokedAt: "2026-07-17T11:00:00Z" }],
    });
    expect(() => verifyFixture({ ...revoked, index: revokedIndex, envelope: rotated.envelope }, accepted.pins)).toThrow(/revoked/);
  });
});

describe("provider package universal manifest rules", () => {
  it("rejects payload-manifest identity disagreement for every source type", () => {
    const fixture = providerDistribution();
    const payload = structuredClone(fixture.payload);
    payload.manifest = { ...(payload.manifest as object), providerId: "other" };
    expect(() => parseCapabilityProviderPackage(payload)).toThrow(/identity/);
  });

  it("parses a signed capability broker requirement against the host grammar", () => {
    const payload = payloadWithBrokerRequirements(providerDistribution(), [RESEARCH_BROKER_REQUIREMENT]);
    const parsed = parseCapabilityProviderPackage(payload);
    expect(parsed.manifest.capabilities[0].brokerRequirements).toEqual([{
      brokerId: "https", brokerContractVersion: "1.0.0", operations: ["fetch-sources"],
      effectClass: "read", access: "read-only", requiredCredentialSlots: ["api-token"],
      exposedInputKinds: ["retained-source"],
      targetConstraints: { allowedOrigins: ["https://api.example.test"] },
      maximums: { httpsTransferBytes: 1024 },
    }]);
  });

  it.each([
    ["unknown broker id", { brokerId: "unknown-broker" }],
    ["unregistered contract version", { brokerContractVersion: "9.9.9" }],
    ["a non-token operation", { operations: ["bad op!"] }],
    ["unknown target-constraint key", { targetConstraints: { arbitrary: ["x"] } }],
    ["a maximum key the broker does not offer", { maximums: { modelTokens: 1 } }],
    ["a maximum that widens the host ceiling", { maximums: { httpsTransferBytes: 8 * 1024 ** 3 } }],
  ])("rejects a broker requirement with %s", (_label, override) => {
    const payload = payloadWithBrokerRequirements(providerDistribution(),
      [{ ...RESEARCH_BROKER_REQUIREMENT, ...override }]);
    expect(() => parseCapabilityProviderPackage(payload)).toThrow(/broker requirement is invalid/);
  });

  it("rejects mutating access declared for a read-only broker", () => {
    const readOnlyModel = {
      brokerId: "model", brokerContractVersion: "1.0.0", operations: ["complete"],
      effectClass: "read", access: "mutating", requiredCredentialSlots: [],
      exposedInputKinds: [], targetConstraints: { allowedServices: ["svc"] },
      maximums: { modelTokens: 100 },
    };
    const payload = payloadWithBrokerRequirements(providerDistribution(), [readOnlyModel]);
    expect(() => parseCapabilityProviderPackage(payload)).toThrow(/broker requirement is invalid/);
  });

  it("rejects two artifact IDs for the same platform tuple", () => {
    const fixture = providerDistribution();
    expect(() => parseCapabilityProviderPackage(
      payloadWithDuplicateHostArtifact(fixture),
    )).toThrow(/artifact.*platform|platform.*artifact|duplicate/);
  });
});

function verifyFixture(fixture: ReturnType<typeof providerDistribution>, priorPins: ReturnType<typeof emptyPublisherPinState>) {
  return verifyProviderDistribution({
    envelope: parseProviderPackageEnvelope(JSON.stringify(fixture.envelope)),
    index: parseSignedTapIndex(JSON.stringify(fixture.index)), expectedTap: "official",
    trustedTapKey: TAP.publicKey, priorPins, currentVersion: "1.1.0",
    now: new Date("2026-07-17T12:00:00Z"),
  });
}
