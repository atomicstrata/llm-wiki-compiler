/**
 * @file test/capability-providers/protocol-identity-fixture.ts
 * @description Shared handshake identity fixture for the protocol and
 * invocation-lifecycle suites, so both bind the same expected-identity digests
 * and nonce rather than duplicating the construction.
 */
import { parseCapabilityId, parseSha256Digest } from "../../src/capability-providers/ids.js";
import type { RuntimeExpectedIdentityV1 } from "../../src/capability-providers/runtime/types.js";

/** Build a distinct canonical digest string from a seed byte. */
export function digest(seed: number): ReturnType<typeof parseSha256Digest> {
  return parseSha256Digest(`sha256:${seed.toString(16).padStart(2, "0").repeat(32)}`);
}

/** The single pinned capability id every fixture handshake declares. */
const FIXTURE_CAPABILITY_ID = "analyze-sources";

/** The exact expected identity both suites echo during the handshake. */
export const PROTOCOL_IDENTITY: RuntimeExpectedIdentityV1 = Object.freeze({
  providerPinDigest: digest(1), packageDigest: digest(2), manifestDigest: digest(3),
  artifactDigest: digest(4), capabilityId: parseCapabilityId(FIXTURE_CAPABILITY_ID),
  capabilitySchemaDigest: digest(5),
});
