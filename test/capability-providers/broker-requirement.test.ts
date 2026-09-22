/**
 * @file test/capability-providers/broker-requirement.test.ts
 * @description Round-trips a signed capability broker requirement through
 * package parsing, the Task 5 grant resolver, and grant intersection so the
 * parsed per-broker maximum is enforced end-to-end rather than bypassed.
 */
import { describe, expect, it } from "vitest";
import { parseCapabilityProviderPackage } from "../../src/capability-providers/packages/protocol.js";
import { resolveEffectiveProviderGrant } from "../../src/capability-providers/authority/grants-resolve.js";
import {
  payloadWithBrokerRequirements, providerDistribution, RESEARCH_BROKER_REQUIREMENT,
} from "../fixtures/capability-provider-package.js";
import { brokerAtom, prepareBrokerAuthority, useBrokerFixtures } from "./broker-fixture.js";

const trackFixture = useBrokerFixtures();

describe("signed broker requirement round-trip", () => {
  it("enforces a parsed requirement maximum through the resolver and intersection", async () => {
    const payload = payloadWithBrokerRequirements(providerDistribution(), [RESEARCH_BROKER_REQUIREMENT]);
    const requirement = parseCapabilityProviderPackage(payload).manifest.capabilities[0].brokerRequirements[0];
    const fixture = trackFixture(await prepareBrokerAuthority({
      authority: [brokerAtom({ kind: "network.https", brokerId: "https",
        operation: "fetch-sources", target: "https://api.example.test", method: "GET" })],
      brokerMaximumOverrides: { action: requirement.maximums },
    }));
    const grant = await resolveEffectiveProviderGrant(fixture.package.paths, fixture.request);
    expect(grant.brokerMaximums.httpsTransferBytes).toBe(requirement.maximums.httpsTransferBytes);
  });
});
