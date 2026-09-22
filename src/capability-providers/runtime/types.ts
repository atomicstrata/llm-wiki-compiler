/**
 * @file src/capability-providers/runtime/types.ts
 * @description Closed Provider V2 wire-protocol message and event DTOs. Every
 * host->provider and provider->host frame has an exact bounded shape; these
 * records describe the framed lifecycle only and never carry a host path, raw
 * credential, or executable entrypoint value.
 */
import type {
  CapabilityIdV1, InputIdV1, InvocationIdV1, RequestIdV1, Sha256Digest,
} from "../types.js";
import type { ProviderProblemCodeV1 } from "../problems.js";

/** The single accepted protocol-V1 transport/grammar version string. */
export const PROVIDER_PROTOCOL_VERSION_V1 = "provider-framing-v1";

/** Provider->host frame types. */
export const PROVIDER_MESSAGE_TYPES = Object.freeze([
  "initialized", "progress", "broker-request", "cancel-ack", "checkpoint", "result", "error",
] as const);
export type ProviderMessageTypeV1 = (typeof PROVIDER_MESSAGE_TYPES)[number];

/** Exact bounded JSON values accepted inside a protocol message payload. */
export interface RuntimeJsonObjectV1 { readonly [key: string]: RuntimeJsonValueV1 }
export interface RuntimeJsonArrayV1 extends ReadonlyArray<RuntimeJsonValueV1> {}
export type RuntimeJsonValueV1 =
  | null | boolean | number | string | RuntimeJsonArrayV1 | RuntimeJsonObjectV1;

/** Host-computed identity the provider must echo exactly during the handshake. */
export interface RuntimeExpectedIdentityV1 {
  readonly providerPinDigest: Sha256Digest;
  readonly packageDigest: Sha256Digest;
  readonly manifestDigest: Sha256Digest;
  readonly artifactDigest: Sha256Digest;
  readonly capabilityId: CapabilityIdV1;
  readonly capabilitySchemaDigest: Sha256Digest;
}

/** One materialized input the provider addresses only by opaque token. */
export interface RuntimeInputTokenDescriptorV1 {
  readonly inputId: InputIdV1;
  readonly token: string;
  readonly kind: string;
  readonly mediaType: string;
  readonly digest: Sha256Digest;
  readonly byteCount: number;
}

/** provider->host initialized frame; echoes identity and selects the version. */
export interface InitializedEventV1 {
  readonly type: "initialized";
  readonly requestId: RequestIdV1;
  readonly sequence: number;
  readonly selectedProtocolVersion: string;
  readonly echoedIdentity: RuntimeExpectedIdentityV1;
  readonly nonce: string;
  readonly declaredCapabilityId: CapabilityIdV1;
}

/** provider->host advisory progress with monotonic completed/total counts. */
export interface ProgressEventV1 {
  readonly type: "progress";
  readonly requestId: RequestIdV1;
  readonly sequence: number;
  readonly completed: number;
  readonly total: number;
  readonly note: string | null;
}

/** provider->host one typed broker-operation request carried by value. */
export interface BrokerRequestEventV1 {
  readonly type: "broker-request";
  readonly requestId: RequestIdV1;
  readonly sequence: number;
  readonly request: RuntimeJsonObjectV1;
}

/** provider->host cancel acknowledgement; advisory only. */
export interface CancelAckEventV1 {
  readonly type: "cancel-ack";
  readonly requestId: RequestIdV1;
  readonly sequence: number;
}

/** provider->host bounded opaque checkpoint bytes, validated but never trusted. */
export interface CheckpointEventV1 {
  readonly type: "checkpoint";
  readonly requestId: RequestIdV1;
  readonly sequence: number;
  readonly checkpointBase64: string;
  readonly byteCount: number;
}

/** provider->host terminal result frame carrying untrusted output claims. */
export interface ResultEventV1 {
  readonly type: "result";
  readonly requestId: RequestIdV1;
  readonly sequence: number;
  readonly result: RuntimeJsonObjectV1;
}

/** provider->host terminal typed provider failure. */
export interface ErrorEventV1 {
  readonly type: "error";
  readonly requestId: RequestIdV1;
  readonly sequence: number;
  readonly code: ProviderProblemCodeV1;
  readonly detail: string;
}

export type ProviderEventV1 =
  | InitializedEventV1 | ProgressEventV1 | BrokerRequestEventV1 | CancelAckEventV1
  | CheckpointEventV1 | ResultEventV1 | ErrorEventV1;
