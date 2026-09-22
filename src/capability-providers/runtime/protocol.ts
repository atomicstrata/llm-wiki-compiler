/**
 * @file src/capability-providers/runtime/protocol.ts
 * @description Host-driven Provider V2 protocol session. It builds outbound
 * host frames with monotonic sequencing, validates every inbound provider frame
 * against the exact invocation identity, strict per-direction sequence, the
 * handshake echo, broker-request correlation, and the terminal-state rules, and
 * fails closed with a typed violation on any deviation.
 */
import { MAX_BROKER_REQUESTS, MAX_PROGRESS_MESSAGES } from "../constants.js";
import type { InvocationIdV1, RequestIdV1, Sha256Digest } from "../types.js";
import { encodeFrame } from "./framing.js";
import { parseProviderFrame, ProviderProtocolError } from "./protocol-parse.js";
import {
  PROVIDER_PROTOCOL_VERSION_V1, type ProviderEventV1, type RuntimeExpectedIdentityV1,
  type RuntimeInputTokenDescriptorV1, type RuntimeJsonObjectV1, type RuntimeJsonValueV1,
} from "./types.js";

export { ProviderProtocolError } from "./protocol-parse.js";

/** Immutable identity and nonce a session binds before any frame flows. */
export interface ProviderProtocolSessionOptionsV1 {
  readonly invocationId: InvocationIdV1;
  readonly nonce: string;
  readonly expectedIdentity: RuntimeExpectedIdentityV1;
}

/** Non-secret handshake payload the host reveals with the initialize frame. */
export interface InitializeFrameInputV1 {
  readonly grantSnapshotDigest: Sha256Digest;
  readonly grantSummary: RuntimeJsonObjectV1;
  readonly inputTokens: readonly RuntimeInputTokenDescriptorV1[];
  readonly effectPlanEntryDigests: readonly Sha256Digest[];
}

/** One host-driven protocol session for exactly one provider invocation. */
export class ProviderProtocolSessionV1 {
  private outboundSequence = 0;
  private expectedInboundSequence = 0;
  private initializeSent = false;
  private initialized = false;
  private invokeSent = false;
  private cancelSent = false;
  private terminal: ProviderEventV1 | null = null;
  private readonly outstanding = new Set<string>();
  private progressCount = 0;
  private brokerRequestCount = 0;
  private lastCompleted = 0;
  private lastTotal = 0;

  constructor(private readonly options: ProviderProtocolSessionOptionsV1) {}

  /** Build the initialize frame; valid exactly once as the first host frame. */
  buildInitialize(input: InitializeFrameInputV1): Buffer {
    if (this.initializeSent) throw new ProviderProtocolError("initialize was already sent");
    this.initializeSent = true;
    return this.frame("initialize", {
      nonce: this.options.nonce, expectedIdentity: this.options.expectedIdentity,
      grantSnapshotDigest: input.grantSnapshotDigest, grantSummary: input.grantSummary,
      inputTokens: input.inputTokens, effectPlanEntryDigests: input.effectPlanEntryDigests,
    });
  }

  /** Build the invoke frame; valid only after the handshake and once. */
  buildInvoke(input: RuntimeJsonValueV1, operationContext: RuntimeJsonObjectV1): Buffer {
    if (!this.initialized || this.invokeSent || this.terminal) {
      throw new ProviderProtocolError("invoke is not permitted in the current state");
    }
    this.invokeSent = true;
    return this.frame("invoke", { input, operationContext });
  }

  /** Build a broker-response frame correlated to an outstanding broker request. */
  buildBrokerResponse(requestId: RequestIdV1, response: RuntimeJsonObjectV1): Buffer {
    if (this.terminal || !this.outstanding.has(requestId)) {
      throw new ProviderProtocolError("broker-response does not correlate to an outstanding request");
    }
    this.outstanding.delete(requestId);
    return this.frame("broker-response", { response }, requestId);
  }

  /** Build a cooperative cancel frame; a reserved control frame before terminal. */
  buildCancel(): Buffer {
    if (!this.initializeSent || this.cancelSent || this.terminal) {
      throw new ProviderProtocolError("cancel is not permitted in the current state");
    }
    this.cancelSent = true;
    return this.frame("cancel", {});
  }

  /** Validate one inbound decoded frame and return its typed event. */
  ingest(value: unknown): ProviderEventV1 {
    const frame = parseProviderFrame(value);
    this.assertEnvelope(frame.protocolVersion, frame.invocationId, frame.sequence);
    this.applyEvent(frame.event);
    this.expectedInboundSequence += 1;
    return frame.event;
  }

  get terminalEvent(): ProviderEventV1 | null { return this.terminal; }
  get isTerminal(): boolean { return this.terminal !== null; }
  get outstandingBrokerCount(): number { return this.outstanding.size; }
  /** Total broker requests observed this invocation, including read-only calls. */
  get observedBrokerRequestCount(): number { return this.brokerRequestCount; }

  private assertEnvelope(protocolVersion: string, invocationId: InvocationIdV1, sequence: number): void {
    if (this.terminal) throw new ProviderProtocolError("no inbound frame is valid after a terminal frame");
    if (protocolVersion !== PROVIDER_PROTOCOL_VERSION_V1) {
      throw new ProviderProtocolError("inbound frame uses an unsupported protocol version");
    }
    if (invocationId !== this.options.invocationId) {
      throw new ProviderProtocolError("inbound frame names a different invocation");
    }
    if (sequence !== this.expectedInboundSequence) {
      throw new ProviderProtocolError("inbound frame breaks strict per-direction sequencing");
    }
  }

  private applyEvent(event: ProviderEventV1): void {
    switch (event.type) {
      case "initialized": return this.applyInitialized(event);
      case "progress": return this.applyProgress(event);
      case "broker-request": return this.applyBrokerRequest(event);
      case "cancel-ack": return this.applyCancelAck();
      case "checkpoint": return this.requireRunning("checkpoint");
      case "result": return this.applyResult(event);
      case "error": return this.applyError(event);
    }
  }

  private applyInitialized(event: Extract<ProviderEventV1, { type: "initialized" }>): void {
    if (!this.initializeSent || this.initialized) throw new ProviderProtocolError("unexpected initialized frame");
    if (event.selectedProtocolVersion !== PROVIDER_PROTOCOL_VERSION_V1
      || event.nonce !== this.options.nonce
      || event.declaredCapabilityId !== this.options.expectedIdentity.capabilityId
      || !identityEquals(event.echoedIdentity, this.options.expectedIdentity)) {
      throw new ProviderProtocolError("handshake echo does not match the expected identity");
    }
    this.initialized = true;
  }

  private applyProgress(event: Extract<ProviderEventV1, { type: "progress" }>): void {
    this.requireRunning("progress");
    this.progressCount += 1;
    if (this.progressCount > MAX_PROGRESS_MESSAGES) throw new ProviderProtocolError("progress frame ceiling exceeded");
    if (event.completed < this.lastCompleted || event.total < this.lastTotal || event.completed > event.total) {
      throw new ProviderProtocolError("progress counts regressed or overflowed their total");
    }
    this.lastCompleted = event.completed;
    this.lastTotal = event.total;
  }

  private applyBrokerRequest(event: Extract<ProviderEventV1, { type: "broker-request" }>): void {
    this.requireRunning("broker-request");
    this.brokerRequestCount += 1;
    if (this.brokerRequestCount > MAX_BROKER_REQUESTS) throw new ProviderProtocolError("broker request ceiling exceeded");
    if (this.outstanding.has(event.requestId)) throw new ProviderProtocolError("duplicate outstanding broker request id");
    this.outstanding.add(event.requestId);
  }

  private applyCancelAck(): void {
    if (!this.cancelSent) throw new ProviderProtocolError("unsolicited cancel acknowledgement");
  }

  private applyResult(event: Extract<ProviderEventV1, { type: "result" }>): void {
    this.requireRunning("result");
    if (this.outstanding.size > 0) throw new ProviderProtocolError("result while a broker request is outstanding");
    this.terminal = event;
  }

  private applyError(event: Extract<ProviderEventV1, { type: "error" }>): void {
    if (!this.initialized) throw new ProviderProtocolError("error frame before the handshake completed");
    this.terminal = event;
  }

  private requireRunning(kind: string): void {
    if (!this.initialized || !this.invokeSent) {
      throw new ProviderProtocolError(`${kind} frame before invocation started`);
    }
  }

  private frame(type: string, body: RuntimeJsonObjectV1 | Record<string, unknown>, requestId?: RequestIdV1): Buffer {
    const sequence = this.outboundSequence;
    this.outboundSequence += 1;
    return encodeFrame({
      protocolVersion: PROVIDER_PROTOCOL_VERSION_V1, invocationId: this.options.invocationId,
      requestId: requestId ?? outboundRequestId(sequence), sequence, type, ...body,
    });
  }
}

/** Deterministic per-frame request id for host->provider frames. */
function outboundRequestId(sequence: number): string {
  return `host-${sequence}`;
}

/** Compare two expected-identity records field-by-field. */
function identityEquals(left: RuntimeExpectedIdentityV1, right: RuntimeExpectedIdentityV1): boolean {
  return left.providerPinDigest === right.providerPinDigest
    && left.packageDigest === right.packageDigest
    && left.manifestDigest === right.manifestDigest
    && left.artifactDigest === right.artifactDigest
    && left.capabilityId === right.capabilityId
    && left.capabilitySchemaDigest === right.capabilitySchemaDigest;
}
