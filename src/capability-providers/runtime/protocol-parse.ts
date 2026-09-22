/**
 * @file src/capability-providers/runtime/protocol-parse.ts
 * @description Exact closed grammar for one inbound provider->host frame. Each
 * message type is captured against its precise key set with bounded scalars;
 * the state machine in protocol.ts owns envelope-versus-session checks,
 * sequence monotonicity, correlation, and lifecycle transitions.
 */
import { captureExactRecord, captureOwnDataRecord } from "../../utils/runtime-capture.js";
import { isWellFormedUnicode } from "../../utils/well-formed-unicode.js";
import { captureBrokerJsonObject } from "../brokers/types.js";
import { parseProviderProblemCode } from "../problems.js";
import { parseCapabilityId, parseInvocationId, parseRequestId, parseSha256Digest } from "../ids.js";
import type { InvocationIdV1, RequestIdV1 } from "../types.js";
import {
  PROVIDER_MESSAGE_TYPES, type ProviderEventV1, type ProviderMessageTypeV1,
  type RuntimeExpectedIdentityV1,
} from "./types.js";

const MAX_MESSAGE_STRING_BYTES = 65_536;
const MAX_CHECKPOINT_BASE64_BYTES = 262_144;
const ENVELOPE_KEYS = Object.freeze([
  "protocolVersion", "invocationId", "requestId", "sequence", "type",
] as const);
const IDENTITY_KEYS = Object.freeze([
  "providerPinDigest", "packageDigest", "manifestDigest", "artifactDigest",
  "capabilityId", "capabilitySchemaDigest",
] as const);
const TYPE_EXTRA_KEYS: Readonly<Record<ProviderMessageTypeV1, readonly string[]>> = Object.freeze({
  initialized: ["selectedProtocolVersion", "echoedIdentity", "nonce", "declaredCapabilityId"],
  progress: ["completed", "total", "note"],
  "broker-request": ["request"],
  "cancel-ack": [],
  checkpoint: ["checkpointBase64", "byteCount"],
  result: ["result"],
  error: ["code", "detail"],
});

/** Typed inbound-frame grammar violation raised before any state transition. */
export class ProviderProtocolError extends Error {
  constructor(message = "provider protocol frame is invalid") {
    super(message);
    this.name = "ProviderProtocolError";
  }
}

/** Envelope fields the session validates plus the fully parsed typed event. */
export interface ParsedProviderFrameV1 {
  readonly protocolVersion: string;
  readonly invocationId: InvocationIdV1;
  readonly requestId: RequestIdV1;
  readonly sequence: number;
  readonly event: ProviderEventV1;
}

/** Capture one decoded frame value into its exact envelope and typed event. */
export function parseProviderFrame(value: unknown): ParsedProviderFrameV1 {
  try {
    const record = captureOwnDataRecord(value);
    const type = messageType(record.type);
    const exact = captureExactRecord(record, [...ENVELOPE_KEYS, ...TYPE_EXTRA_KEYS[type]]);
    const requestId = parseRequestId(exact.requestId);
    const sequence = safeCount(exact.sequence);
    return Object.freeze({
      protocolVersion: boundedString(exact.protocolVersion),
      invocationId: parseInvocationId(exact.invocationId),
      requestId, sequence,
      event: parseEvent(type, requestId, sequence, exact),
    });
  } catch (error) {
    if (error instanceof ProviderProtocolError) throw error;
    throw new ProviderProtocolError("provider frame violated the closed message grammar");
  }
}

function parseEvent(
  type: ProviderMessageTypeV1, requestId: RequestIdV1, sequence: number,
  exact: Readonly<Record<string, unknown>>,
): ProviderEventV1 {
  switch (type) {
    case "initialized": return parseInitialized(requestId, sequence, exact);
    case "progress": return parseProgress(requestId, sequence, exact);
    case "broker-request":
      return Object.freeze({ type, requestId, sequence, request: captureBrokerJsonObject(exact.request) });
    case "cancel-ack": return Object.freeze({ type, requestId, sequence });
    case "checkpoint": return parseCheckpoint(requestId, sequence, exact);
    case "result":
      return Object.freeze({ type, requestId, sequence, result: captureBrokerJsonObject(exact.result) });
    case "error": return parseError(requestId, sequence, exact);
  }
}

function parseInitialized(requestId: RequestIdV1, sequence: number, exact: Readonly<Record<string, unknown>>) {
  return Object.freeze({
    type: "initialized" as const, requestId, sequence,
    selectedProtocolVersion: boundedString(exact.selectedProtocolVersion),
    echoedIdentity: parseIdentity(exact.echoedIdentity),
    nonce: boundedString(exact.nonce),
    declaredCapabilityId: parseCapabilityId(exact.declaredCapabilityId),
  });
}

function parseProgress(requestId: RequestIdV1, sequence: number, exact: Readonly<Record<string, unknown>>) {
  return Object.freeze({
    type: "progress" as const, requestId, sequence,
    completed: safeCount(exact.completed), total: safeCount(exact.total),
    note: exact.note === null ? null : boundedString(exact.note),
  });
}

function parseCheckpoint(requestId: RequestIdV1, sequence: number, exact: Readonly<Record<string, unknown>>) {
  const checkpointBase64 = base64Value(exact.checkpointBase64);
  const byteCount = safeCount(exact.byteCount);
  if (Buffer.from(checkpointBase64, "base64").byteLength !== byteCount) {
    throw new ProviderProtocolError("provider checkpoint byte count does not match its bytes");
  }
  return Object.freeze({ type: "checkpoint" as const, requestId, sequence, checkpointBase64, byteCount });
}

function parseError(requestId: RequestIdV1, sequence: number, exact: Readonly<Record<string, unknown>>) {
  return Object.freeze({
    type: "error" as const, requestId, sequence,
    code: problemCode(exact.code), detail: boundedString(exact.detail),
  });
}

function parseIdentity(value: unknown): RuntimeExpectedIdentityV1 {
  const record = captureExactRecord(value, [...IDENTITY_KEYS]);
  return Object.freeze({
    providerPinDigest: parseSha256Digest(record.providerPinDigest),
    packageDigest: parseSha256Digest(record.packageDigest),
    manifestDigest: parseSha256Digest(record.manifestDigest),
    artifactDigest: parseSha256Digest(record.artifactDigest),
    capabilityId: parseCapabilityId(record.capabilityId),
    capabilitySchemaDigest: parseSha256Digest(record.capabilitySchemaDigest),
  });
}

function messageType(value: unknown): ProviderMessageTypeV1 {
  if (!PROVIDER_MESSAGE_TYPES.includes(value as ProviderMessageTypeV1)) {
    throw new ProviderProtocolError("provider frame type is not a provider->host message");
  }
  return value as ProviderMessageTypeV1;
}

function problemCode(value: unknown) {
  try { return parseProviderProblemCode(value); }
  catch { throw new ProviderProtocolError("provider error frame carries an unknown problem code"); }
}

function base64Value(value: unknown): string {
  const text = stringValue(value);
  if (Buffer.byteLength(text) > MAX_CHECKPOINT_BASE64_BYTES || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) {
    throw new ProviderProtocolError("provider checkpoint bytes are not bounded base64");
  }
  return text;
}

function boundedString(value: unknown): string {
  const text = stringValue(value);
  if (text.length === 0 || Buffer.byteLength(text) > MAX_MESSAGE_STRING_BYTES
    || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new ProviderProtocolError("provider frame string is out of bounds");
  }
  return text;
}

function stringValue(value: unknown): string {
  if (typeof value !== "string" || !isWellFormedUnicode(value)) {
    throw new ProviderProtocolError("provider frame expected a well-formed string");
  }
  return value;
}

function safeCount(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ProviderProtocolError("provider frame expected a bounded non-negative integer");
  }
  return value as number;
}
