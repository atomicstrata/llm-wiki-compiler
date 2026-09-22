/**
 * @file test/capability-providers/identities.test.ts
 * @description Provider V2 identity grammar, duplicate rejection, DTO, and
 * protocol hard-ceiling coverage for the foundational contract layer.
 */
import { describe, expect, it } from "vitest";
import * as ceilings from "../../src/capability-providers/constants.js";
import {
  parseBackendId,
  parseBrokerId,
  parseCapabilityId,
  parseCapabilityContractVersion,
  parseEffectId,
  parseInputId,
  parseInvocationId,
  parseProviderCoordinate,
  parseProviderId,
  parseReceiptId,
  parseRequestId,
  parseSemanticVersion,
  parseSha256Digest,
  snapshotUniqueLogicalIds,
} from "../../src/capability-providers/ids.js";
import {
  PROVIDER_PRINCIPAL_GRANTS,
  PROVIDER_PRINCIPAL_SURFACES,
} from "../../src/capability-providers/types.js";
import type {
  ProviderBoundsV1,
  ProviderCapabilityStatusV1,
  ProviderPinV1,
  ProviderPrincipalV1,
} from "../../src/capability-providers/types.js";
import { parseProviderBounds, parseProviderGrantScope } from "../../src/capability-providers/authority/grants-parse.js";
import { MAX_HTTPS_AGGREGATE_TRANSFER_BYTES } from "../../src/capability-providers/constants.js";

const ID_PARSERS = [
  ["provider", parseProviderId],
  ["capability", parseCapabilityId],
  ["broker", parseBrokerId],
  ["input", parseInputId],
  ["invocation", parseInvocationId],
  ["request", parseRequestId],
  ["effect", parseEffectId],
  ["receipt", parseReceiptId],
  ["backend", parseBackendId],
] as const;

const UNSAFE_IDS = [
  "", "../escape", "two/parts", "back\\slash", "C:drive", "UPPER",
  ".hidden", "trailing-", "two..dots", "line\nbreak", "nul\0byte",
];
const INVALID_COORDINATES = [
  "official/publisher/provider",
  "official/publisher/provider@latest",
  "official/publisher/provider@01.2.3",
  "official/publisher/provider@1.2.3@2.0.0",
  "official/publisher/extra/provider@1.2.3",
  "official/publisher/../provider@1.2.3",
];

const EXPECTED_CEILINGS: Record<string, number> = {
  MAX_SIGNED_PROVIDER_ENVELOPE_BYTES: 4 * 1024 ** 2,
  MAX_COMPRESSED_PLATFORM_ARTIFACT_BYTES: 512 * 1024 ** 2,
  MAX_EXPANDED_PACKAGE_TREE_BYTES: 2 * 1024 ** 3,
  MAX_PACKAGE_ENTRIES: 50_000,
  MAX_PACKAGE_ENTRY_BYTES: 512 * 1024 ** 2,
  MAX_MANIFEST_CAPABILITIES: 256,
  MAX_CAPABILITY_CONTRACT_VERSION_BYTES: 256,
  MAX_PROVIDER_LOGICAL_ID_SNAPSHOT_ITEMS: 4_096,
  MAX_STRUCTURED_INPUT_BYTES: 2 * 1024 ** 2,
  MAX_STRUCTURED_INPUT_DEPTH: 32,
  MAX_STRUCTURED_INPUT_MEMBERS: 4_096,
  MAX_MATERIALIZED_INPUT_FILES: 4_096,
  MAX_MATERIALIZED_INPUT_BYTES: 8 * 1024 ** 3,
  MAX_MATERIALIZED_INPUT_FILE_BYTES: 2 * 1024 ** 3,
  MAX_SCRATCH_BYTES: 16 * 1024 ** 3,
  MAX_SCRATCH_ENTRIES: 8_192,
  MAX_ACCEPTED_OUTPUT_FILES: 2_048,
  MAX_ACCEPTED_OUTPUT_BYTES: 8 * 1024 ** 3,
  MAX_ACCEPTED_OUTPUT_FILE_BYTES: 2 * 1024 ** 3,
  MAX_CUSTODY_SCAN_BYTES: 16 * 1024 ** 3,
  MAX_CUSTODY_WALL_TIME_MS: 30 * 60 * 1_000,
  MAX_PROTOCOL_FRAME_BYTES: 1024 ** 2,
  MAX_PROTOCOL_STREAM_FRAMES: 16_384,
  MAX_PROTOCOL_STREAM_BYTES_PER_DIRECTION: 64 * 1024 ** 2,
  MAX_PROGRESS_MESSAGES: 4_096,
  MAX_PROVIDER_STDERR_RETAINED_BYTES: 8 * 1024 ** 2,
  MAX_PROVIDER_WALL_TIME_MS: 12 * 60 * 60 * 1_000,
  MAX_PROVIDER_CPU_TIME_MS: 48 * 60 * 60 * 1_000,
  MAX_PROVIDER_MEMORY_BYTES: 16 * 1024 ** 3,
  MAX_PROVIDER_PROCESSES: 128,
  MAX_PROVIDER_THREADS: 256,
  MAX_PROVIDER_OPEN_FILES: 512,
  MAX_BROKER_REQUESTS: 4_096,
  MAX_HTTPS_REQUESTS: 2_048,
  MAX_HTTPS_REQUEST_OR_RESPONSE_BYTES: 64 * 1024 ** 2,
  MAX_HTTPS_AGGREGATE_TRANSFER_BYTES: 4 * 1024 ** 3,
  MAX_HTTPS_REDIRECTS_PER_REQUEST: 5,
  MAX_MODEL_CALLS: 2_048,
  MAX_MODEL_AGGREGATE_TOKENS: 20_000_000,
  MAX_MODEL_AGGREGATE_BILLABLE_COST_USD: 100,
  MAX_COMMANDS: 256,
  MAX_COMMAND_WALL_TIME_MS: 2 * 60 * 60 * 1_000,
  MAX_COMMAND_AGGREGATE_ACCEPTED_BYTES: 2 * 1024 ** 3,
  MAX_MUTATING_EFFECTS: 256,
  MAX_MUTATING_EFFECTS_PER_CLASS: 64,
};

const BOUNDS: ProviderBoundsV1 = {
  structuredInputBytes: 1,
  materializedInputFiles: 1,
  materializedInputBytes: 1,
  scratchFiles: 1,
  scratchBytes: 1,
  outputFiles: 1,
  outputBytes: 1,
  custodyScanBytes: 1,
  custodyWallTimeMs: 1,
  protocolFrames: 1,
  protocolBytes: 1,
  brokerRequests: 1,
  mutatingEffects: 1,
  wallTimeMs: 1,
  cpuTimeMs: 1,
  memoryBytes: 1,
  processCount: 1,
};

describe("provider coordinates and digests", () => {
  it("rejects the four broker aggregate maxima as unknown provider-bound keys", () => {
    for (const key of ["httpsTransferBytes", "modelTokens", "modelCostUsd", "commandAcceptedBytes"]) {
      expect(() => parseProviderBounds({ ...BOUNDS, [key]: 1 })).toThrow(/bounds.*invalid/i);
    }
  });

  it("parses tightened per-broker aggregate maxima including decimal model cost", () => {
    const parsed = parseProviderGrantScope({ schemaVersion: 1, authority: [], bounds: BOUNDS,
      brokerMaximums: { httpsTransferBytes: 11, modelTokens: 12, modelCostUsd: 0.25,
        commandAcceptedBytes: 13 } });
    expect(parsed.brokerMaximums).toEqual({
      httpsTransferBytes: 11, modelTokens: 12, modelCostUsd: 0.25, commandAcceptedBytes: 13,
    });
  });

  it("treats an omitted broker aggregate maximum as no tightening", () => {
    const parsed = parseProviderGrantScope({ schemaVersion: 1, authority: [], bounds: BOUNDS });
    expect(parsed.brokerMaximums).toBeUndefined();
  });

  it.each([
    ["httpsTransferBytes", -1], ["modelTokens", 1.5],
    ["modelCostUsd", Number.POSITIVE_INFINITY],
    ["commandAcceptedBytes", Number.MAX_SAFE_INTEGER + 1],
    ["httpsTransferBytes", MAX_HTTPS_AGGREGATE_TRANSFER_BYTES + 1],
    ["unknownBroker", 1],
  ])("rejects invalid per-broker aggregate maximum %s", (key, value) => {
    expect(() => parseProviderGrantScope({ schemaVersion: 1, authority: [], bounds: BOUNDS,
      brokerMaximums: { [key]: value } })).toThrow(/grant.*invalid/i);
  });

  it("parses one exact unambiguous provider coordinate", () => {
    const coordinate = "official/atomic-strata/research-provider@1.2.3-alpha.1+build.5";
    expect(parseProviderCoordinate(coordinate)).toEqual({
      coordinate,
      tap: "official",
      publisher: "atomic-strata",
      providerId: "research-provider",
      providerVersion: "1.2.3-alpha.1+build.5",
    });
    expect(Object.isFrozen(parseProviderCoordinate(coordinate))).toBe(true);
  });

  it.each(INVALID_COORDINATES)("rejects ambiguous or inexact coordinate %s", (coordinate) => {
    expect(() => parseProviderCoordinate(coordinate)).toThrow(/provider coordinate/);
  });

  it("accepts only canonical lowercase SHA-256 digests", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    expect(parseSha256Digest(digest)).toBe(digest);
    expect(() => parseSha256Digest(`sha256:${"A".repeat(64)}`)).toThrow(/SHA-256 digest/);
  });
});

describe("semantic versions and logical IDs", () => {
  it.each(["0.0.0", "1.2.3", "1.2.3-alpha.1+build.5"])("parses exact semantic version %s", (version) => {
    expect(parseSemanticVersion(version)).toBe(version);
  });

  it.each(["1", "1.2", "01.2.3", "1.2.3-01", "v1.2.3", "1.2.3+"])("rejects inexact semantic version %s", (version) => {
    expect(() => parseSemanticVersion(version)).toThrow(/semantic version/);
  });

  it.each(ID_PARSERS)("parses a safe %s ID", (_name, parse) => {
    expect(parse("logical-id-v1")).toBe("logical-id-v1");
  });

  it("accepts generic underscore-separated request tokens", () => {
    const brokerRequest = `brq_${"a".repeat(64)}`;
    expect(parseRequestId(brokerRequest)).toBe(brokerRequest);
    expect(parseRequestId("request_part-2")).toBe("request_part-2");
    expect(() => parseProviderId("provider_part")).toThrow(/required grammar/);
  });

  it.each(["_request", "request_", "request__part", "request-_part", "UPPER_request"])(
    "rejects malformed generic request token %s",
    (requestId) => expect(() => parseRequestId(requestId)).toThrow(/request ID/),
  );

  it.each(ID_PARSERS.flatMap(([name, parse]) => UNSAFE_IDS.map((value) => [name, value, parse] as const)))(
    "rejects unsafe %s ID %s",
    (_name, value, parse) => expect(() => parse(value)).toThrow(/ID/),
  );

  it("snapshots logical IDs instead of blessing caller-owned storage", () => {
    const first = parseInputId("source-one");
    const second = parseRequestId("request_two");
    const callerOwned = [first, second];
    const snapshot = snapshotUniqueLogicalIds(callerOwned, 2);
    callerOwned[1] = first;
    expect(snapshot).toEqual([first, second]);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it("rejects duplicate logical IDs instead of silently deduplicating", () => {
    const inputId = parseInputId("source-one");
    expect(() => snapshotUniqueLogicalIds([inputId, inputId], 2)).toThrow(
      /provider logical ID.*duplicated/,
    );
  });
});

describe("capability contract versions", () => {
  it.each(["1.0.0", "capability-contract-v1", " release\u2028candidate "])(
    "preserves exact opaque version %s",
    (version) => expect(parseCapabilityContractVersion(version)).toBe(version),
  );

  it("does not coerce or normalize rejected versions", () => {
    expect(() => parseCapabilityContractVersion(1)).toThrow(/expected string/);
    expect(() => parseCapabilityContractVersion("")).toThrow(/nonempty/);
  });
});

describe("provider contract DTOs and hard ceilings", () => {
  it("exports every Provider V2 section 26 ceiling with explicit units", () => {
    for (const [name, expected] of Object.entries(EXPECTED_CEILINGS)) {
      expect((ceilings as Record<string, unknown>)[name], name).toBe(expected);
    }
  });

  it("represents exact pins, status, bounds, and principals without ambient authority", () => {
    const pin: ProviderPinV1 = providerPin();
    const principal: ProviderPrincipalV1 = {
      schemaVersion: 1,
      principalId: "sdk-client",
      surface: "sdk",
    };
    const status: ProviderCapabilityStatusV1 = providerStatus(pin);
    expect({ pin, principal, status, bounds: BOUNDS }).toMatchObject({
      principal: { surface: "sdk" },
      status: { state: "ready", problems: [] },
    });
    expect("grants" in principal).toBe(false);
  });

  it("exports frozen closed principal surface and grant vocabularies", () => {
    expect(PROVIDER_PRINCIPAL_SURFACES).toEqual(["cli", "sdk", "mcp"]);
    expect(PROVIDER_PRINCIPAL_GRANTS).toEqual(["provider.inspect", "provider.invoke"]);
    expect(Object.isFrozen(PROVIDER_PRINCIPAL_SURFACES)).toBe(true);
    expect(Object.isFrozen(PROVIDER_PRINCIPAL_GRANTS)).toBe(true);
  });
});

function providerPin(): ProviderPinV1 {
  const parsed = parseProviderCoordinate("official/atomic-strata/research-provider@1.2.3");
  const digest = parseSha256Digest(`sha256:${"a".repeat(64)}`);
  return {
    schemaVersion: 1,
    coordinate: parsed.coordinate,
    providerId: parsed.providerId,
    providerVersion: parsed.providerVersion,
    packageDigest: digest,
    manifestDigest: digest,
    capabilityId: parseCapabilityId("collect-sources"),
    capabilityContractVersion: parseCapabilityContractVersion("capability-contract-v1"),
    capabilitySchemaDigest: digest,
  };
}

function providerStatus(providerPin: ProviderPinV1): ProviderCapabilityStatusV1 {
  return {
    providerPin,
    state: "ready",
    installation: "builtin",
    compatibility: "compatible",
    integrity: "verified",
    revocationEvidence: "not-applicable",
    isolation: "available",
    grants: "satisfied",
    credentials: "present",
    problems: [],
    availableBrokerOperations: [],
    localDevelopment: false,
  };
}
