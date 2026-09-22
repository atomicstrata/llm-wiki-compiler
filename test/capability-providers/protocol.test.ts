/**
 * @file test/capability-providers/protocol.test.ts
 * @description Provider V2 protocol lifecycle: the handshake echo, strict
 * per-direction sequencing, broker-request correlation, and the terminal-state
 * rules. Every deviation must raise a typed protocol violation rather than
 * advancing an invocation on attacker-shaped frames.
 */
import { describe, expect, it } from "vitest";
import { parseInvocationId, parseRequestId } from "../../src/capability-providers/ids.js";
import {
  ProviderProtocolSessionV1, ProviderProtocolError,
} from "../../src/capability-providers/runtime/protocol.js";
import { PROVIDER_PROTOCOL_VERSION_V1 } from "../../src/capability-providers/runtime/types.js";
import { digest, PROTOCOL_IDENTITY as IDENTITY } from "./protocol-identity-fixture.js";

const INVOCATION = parseInvocationId("invocation-alpha");
const NONCE = "nonce-abc";

/** Construct a fresh host session bound to the shared identity fixture. */
function session(): ProviderProtocolSessionV1 {
  return new ProviderProtocolSessionV1({ invocationId: INVOCATION, nonce: NONCE, expectedIdentity: IDENTITY });
}

/** Assemble one provider->host frame object for `ingest`. */
function frame(type: string, sequence: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocolVersion: PROVIDER_PROTOCOL_VERSION_V1, invocationId: "invocation-alpha",
    requestId: `provider-${sequence}`, sequence, type, ...extra,
  };
}

/** The exact initialized-frame echo the happy path expects. */
function initializedFrame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return frame("initialized", 0, {
    selectedProtocolVersion: PROVIDER_PROTOCOL_VERSION_V1,
    echoedIdentity: {
      providerPinDigest: IDENTITY.providerPinDigest, packageDigest: IDENTITY.packageDigest,
      manifestDigest: IDENTITY.manifestDigest, artifactDigest: IDENTITY.artifactDigest,
      capabilityId: "analyze-sources", capabilitySchemaDigest: IDENTITY.capabilitySchemaDigest,
    },
    nonce: NONCE, declaredCapabilityId: "analyze-sources", ...overrides,
  });
}

/** Drive one session through initialize + handshake + invoke. */
function running(): ProviderProtocolSessionV1 {
  const active = session();
  active.buildInitialize(initializeInput());
  active.ingest(initializedFrame());
  active.buildInvoke({ query: "x" }, {});
  return active;
}

function initializeInput() {
  return {
    grantSnapshotDigest: digest(9), grantSummary: {}, inputTokens: [],
    effectPlanEntryDigests: [],
  };
}

describe("provider protocol handshake", () => {
  it("accepts a correct handshake echo", () => {
    const active = session();
    active.buildInitialize(initializeInput());
    const event = active.ingest(initializedFrame());
    expect(event.type).toBe("initialized");
  });

  it("refuses an initialized frame with a wrong nonce", () => {
    const active = session();
    active.buildInitialize(initializeInput());
    expect(() => active.ingest(initializedFrame({ nonce: "wrong" }))).toThrow(ProviderProtocolError);
  });

  it("refuses an initialized frame that declares an extra capability", () => {
    const active = session();
    active.buildInitialize(initializeInput());
    expect(() => active.ingest(initializedFrame({ declaredCapabilityId: "other-capability" })))
      .toThrow(ProviderProtocolError);
  });

  it("refuses a mismatched identity echo", () => {
    const active = session();
    active.buildInitialize(initializeInput());
    const tampered = initializedFrame();
    (tampered.echoedIdentity as Record<string, unknown>).packageDigest = digest(99);
    expect(() => active.ingest(tampered)).toThrow(ProviderProtocolError);
  });

  it("refuses a cross-invocation id", () => {
    const active = session();
    active.buildInitialize(initializeInput());
    expect(() => active.ingest(initializedFrame({ invocationId: "invocation-beta" })))
      .toThrow(ProviderProtocolError);
  });

  it("refuses invoke before the handshake", () => {
    const active = session();
    active.buildInitialize(initializeInput());
    expect(() => active.buildInvoke({}, {})).toThrow(ProviderProtocolError);
  });
});

describe("provider protocol sequencing and correlation", () => {
  it("refuses a sequence gap", () => {
    const active = running();
    expect(() => active.ingest(frame("progress", 5, { completed: 0, total: 1, note: null })))
      .toThrow(ProviderProtocolError);
  });

  it("refuses replay of an already-consumed sequence", () => {
    const active = running();
    active.ingest(frame("progress", 1, { completed: 0, total: 1, note: null }));
    expect(() => active.ingest(frame("progress", 1, { completed: 1, total: 1, note: null })))
      .toThrow(ProviderProtocolError);
  });

  it("refuses progress that regresses", () => {
    const active = running();
    active.ingest(frame("progress", 1, { completed: 3, total: 5, note: null }));
    expect(() => active.ingest(frame("progress", 2, { completed: 2, total: 5, note: null })))
      .toThrow(ProviderProtocolError);
  });

  it("refuses a result while a broker request is outstanding", () => {
    const active = running();
    active.ingest(frame("broker-request", 1, { request: { schemaVersion: 1, requestId: "r1", brokerId: "https", brokerContractVersion: "1.0.0", payload: {}, effect: null } }));
    expect(() => active.ingest(frame("result", 2, { result: {} }))).toThrow(ProviderProtocolError);
  });

  it("accepts a result after the outstanding broker request is answered", () => {
    const active = running();
    active.ingest(frame("broker-request", 1, { request: { schemaVersion: 1, requestId: "r1", brokerId: "https", brokerContractVersion: "1.0.0", payload: {}, effect: null } }));
    active.buildBrokerResponse(parseRequestId("provider-1"), { status: "ok" });
    const event = active.ingest(frame("result", 2, { result: { outcome: "succeeded" } }));
    expect(event.type).toBe("result");
    expect(active.isTerminal).toBe(true);
  });

  it("refuses a broker-response with no outstanding request", () => {
    const active = running();
    expect(() => active.buildBrokerResponse(parseRequestId("provider-9"), {}))
      .toThrow(ProviderProtocolError);
  });

  it("refuses any inbound frame after a terminal result", () => {
    const active = running();
    active.ingest(frame("result", 1, { result: {} }));
    expect(() => active.ingest(frame("progress", 2, { completed: 1, total: 1, note: null })))
      .toThrow(ProviderProtocolError);
  });

  it("refuses an unsolicited cancel acknowledgement", () => {
    const active = running();
    expect(() => active.ingest(frame("cancel-ack", 1))).toThrow(ProviderProtocolError);
  });

  it("accepts a cancel acknowledgement after the host cancels", () => {
    const active = running();
    active.buildCancel();
    expect(active.ingest(frame("cancel-ack", 1)).type).toBe("cancel-ack");
  });
});

/** One valid bounded checkpoint frame body for lineage/validation fuzzing. */
function checkpointFrame(sequence: number, bytes = "state") {
  return frame("checkpoint", sequence, {
    checkpointBase64: Buffer.from(bytes).toString("base64"), byteCount: bytes.length,
  });
}

describe("provider protocol checkpoint and terminal fuzz", () => {
  it("accepts a bounded, self-consistent checkpoint frame mid-run", () => {
    const active = running();
    expect(active.ingest(checkpointFrame(1)).type).toBe("checkpoint");
  });

  it("refuses a checkpoint before the invocation starts", () => {
    const active = session();
    active.buildInitialize(initializeInput());
    active.ingest(initializedFrame());
    expect(() => active.ingest(checkpointFrame(1))).toThrow(ProviderProtocolError);
  });

  it("refuses a duplicate terminal result frame", () => {
    const active = running();
    active.ingest(frame("result", 1, { result: {} }));
    expect(() => active.ingest(frame("result", 2, { result: {} }))).toThrow(ProviderProtocolError);
  });

  it("refuses a progress count that overflows its total", () => {
    const active = running();
    expect(() => active.ingest(frame("progress", 1, { completed: 5, total: 3, note: null })))
      .toThrow(ProviderProtocolError);
  });

  it("refuses an error frame before the handshake completes", () => {
    const active = session();
    active.buildInitialize(initializeInput());
    expect(() => active.ingest(frame("error", 0, { code: "provider-failed", detail: "x" })))
      .toThrow(ProviderProtocolError);
  });
});
