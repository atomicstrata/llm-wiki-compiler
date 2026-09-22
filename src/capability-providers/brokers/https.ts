/**
 * @file src/capability-providers/brokers/https.ts
 * @description Closed HTTPS broker operations layered on confined-fetch. Host
 * definitions choose every origin, path, method, header class, credential
 * slot, and bound; provider payloads can supply only bounded body bytes and
 * allowlisted inert headers.
 */
import { TextDecoder } from "node:util";
import { captureExactRecord, captureOwnDataRecord } from "../../utils/runtime-capture.js";
import {
  confinedFetchRequest, validateConnectorHeaders, type ConfinedFetchMethod,
  type ConfinedFetchRequest, type ConfinedFetchResult, type ConfinedFetchSeams,
} from "../../connectors/confined-fetch.js";
import { parseBrokerId, parseSha256Digest } from "../ids.js";
import {
  MAX_HTTPS_REDIRECTS_PER_REQUEST, MAX_HTTPS_REQUEST_OR_RESPONSE_BYTES,
} from "../constants.js";
import type { ProviderAuthorityAtomV1 } from "../authority/types.js";
import type { EffectPlanEntryV1 } from "../authority/types.js";
import type {
  BrokerJsonObjectV1, BrokerRequestEnvelopeV1, HostBrokerExecutionContextV1,
  HostBrokerExecutionV1, HostBrokerBudgetV1, PreparedHostBrokerCallV1,
} from "./types.js";
import { brokerFailure, brokerRequestDigest, captureBrokerJsonObject } from "./types.js";
import type { HostInvocationDeadlineV1 } from "./deadline.js";

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });
export const MAX_CREDENTIAL_VISIBLE_BYTES = 4 * 1024 * 1024;
export const MAX_BROKER_CREDENTIAL_BYTES = 2_048;
const FORBIDDEN_HEADERS = new Set([
  "authorization", "cookie", "proxy-authorization", "host", "accept-encoding",
  "connection", "transfer-encoding", "content-length",
]);

export interface HostHttpsOperationV1 {
  readonly operationId: string;
  readonly origin: string;
  readonly path: string;
  readonly method: ConfinedFetchMethod;
  readonly allowedRequestHeaders: readonly string[];
  readonly contentTypes: readonly string[];
  readonly maxRequestHeaderBytes: number;
  readonly maxResponseHeaderBytes: number;
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
  readonly maxRedirects: number;
  readonly timeoutMs: number;
  readonly credential?: {
    readonly slotId: string; readonly headerName: string; readonly valuePrefix: string;
  };
  readonly effect?: {
    readonly effectClass: string;
    readonly targetIdentity: string;
    readonly observationContractId: string;
  };
}

export interface HostHttpsMutationObservationRequestV1 {
  readonly operationId: string;
  readonly targetIdentity: string;
  readonly observationContractId: string;
  readonly idempotencyKey: string;
  readonly finalUrl: string;
  readonly responseDigest: import("../types.js").Sha256Digest;
}

export interface HostHttpsBrokerV1 {
  readonly operations: readonly HostHttpsOperationV1[];
  readonly seams?: ConfinedFetchSeams;
  readonly observeMutation?: (
    request: HostHttpsMutationObservationRequestV1,
  ) => Promise<import("./types.js").HostExternalEffectObservationV1>;
}

/** Capture and prepare one HTTPS operation without dialing the network. */
export function prepareHttpsBroker(
  envelope: BrokerRequestEnvelopeV1,
  broker: HostHttpsBrokerV1 | undefined,
): PreparedHostBrokerCallV1 {
  if (!broker) throw unavailableError();
  const payload = capturePayload(envelope.payload);
  const operation = requireOperation(broker.operations, payload.operation);
  if (operation.effect && !broker.observeMutation) throw unavailableError();
  const headers = captureHeaders(payload.headers, operation.allowedRequestHeaders);
  const body = captureBody(payload.bodyBase64, operation.maxRequestBytes);
  const authority = [networkAuthority(operation), ...effectAuthority(operation)];
  return Object.freeze({
    authority: Object.freeze(authority), credentialSlotId: operation.credential?.slotId ?? null,
    credentialOperation: operation.credential ? operation.operationId : null,
    category: "https", effect: operation.effect ? Object.freeze({
      ...operation.effect, requestDigest: brokerRequestDigest(
        envelope, captureBrokerJsonObject(operation),
      ),
      expectedBounds: Object.freeze({ requests: 1 }),
    }) : null,
    execute: async (secret: Buffer | null, effect: EffectPlanEntryV1 | null,
      context: HostBrokerExecutionContextV1) => executeHttps(
      operation, headers, body, secret, context.budget, broker.seams,
      effect, broker.observeMutation, context.reserve, context.deadline,
    ),
  });
}

interface HttpsPayload {
  readonly operation: string;
  readonly headers: unknown;
  readonly bodyBase64: string | null;
}

function capturePayload(value: BrokerJsonObjectV1): HttpsPayload {
  try {
    const payload = captureExactRecord(value, ["operation", "headers", "bodyBase64"]);
    if (typeof payload.operation !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(payload.operation)) throw new Error();
    if (payload.bodyBase64 !== null && typeof payload.bodyBase64 !== "string") throw new Error();
    return { operation: payload.operation, headers: payload.headers, bodyBase64: payload.bodyBase64 };
  } catch { throw requestError(); }
}

function requireOperation(
  operations: readonly HostHttpsOperationV1[], operationId: string,
): HostHttpsOperationV1 {
  const matches = operations.filter((operation) => operation.operationId === operationId);
  if (matches.length !== 1) throw requestError();
  const operation = matches[0];
  const origin = new URL(operation.origin);
  if (origin.origin !== operation.origin || origin.protocol !== "https:"
    || !operation.path.startsWith("/") || !validOperationBounds(operation)) throw requestError();
  return operation;
}

function validOperationBounds(operation: HostHttpsOperationV1): boolean {
  return bounded(operation.maxRequestBytes, MAX_HTTPS_REQUEST_OR_RESPONSE_BYTES)
    && bounded(operation.maxResponseBytes, MAX_HTTPS_REQUEST_OR_RESPONSE_BYTES)
    && bounded(operation.maxRequestHeaderBytes, MAX_HTTPS_REQUEST_OR_RESPONSE_BYTES)
    && bounded(operation.maxResponseHeaderBytes, MAX_HTTPS_REQUEST_OR_RESPONSE_BYTES)
    && bounded(operation.maxRedirects, MAX_HTTPS_REDIRECTS_PER_REQUEST)
    && Number.isSafeInteger(operation.timeoutMs) && operation.timeoutMs > 0
    && (!operation.effect
      || /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(operation.effect.observationContractId));
}

function captureHeaders(value: unknown, allowed: readonly string[]): Record<string, string> {
  try {
    const record = captureOwnDataRecord(value);
    const normalizedAllowed = new Set(allowed.map((name) => name.toLowerCase()));
    const headers: Record<string, string> = {};
    for (const [name, headerValue] of Object.entries(record)) {
      const normalized = name.toLowerCase();
      if (typeof headerValue !== "string" || FORBIDDEN_HEADERS.has(normalized)
        || !normalizedAllowed.has(normalized)) throw new Error();
      headers[name] = headerValue;
    }
    if (validateConnectorHeaders(headers).kind !== "ok") throw new Error();
    return headers;
  } catch { throw requestError(); }
}

function captureBody(value: string | null, maximum: number): Buffer | undefined {
  if (value === null) return undefined;
  if (!Number.isSafeInteger(maximum) || maximum < 0) throw requestError();
  const body = Buffer.from(value, "base64");
  if (body.toString("base64") !== value || body.length > maximum) throw requestError();
  return body;
}

function networkAuthority(operation: HostHttpsOperationV1): ProviderAuthorityAtomV1 {
  return Object.freeze({
    kind: "network.https", brokerId: parseBrokerId("https"), operation: operation.operationId,
    target: operation.origin, method: operation.method, credentialSlotId: null,
    credentialHandleId: null, effectClass: null, inputKind: null, toolId: null,
  });
}

function effectAuthority(operation: HostHttpsOperationV1): ProviderAuthorityAtomV1[] {
  if (!operation.effect) return [];
  return [Object.freeze({
    kind: "external.mutate", brokerId: parseBrokerId("https"), operation: operation.operationId,
    target: operation.effect.targetIdentity, method: null, credentialSlotId: null,
    credentialHandleId: null, effectClass: operation.effect.effectClass,
    inputKind: null, toolId: null,
  })];
}

async function executeHttps(
  operation: HostHttpsOperationV1, providerHeaders: Record<string, string>,
  body: Buffer | undefined, secret: Buffer | null, budget: HostBrokerBudgetV1,
  seams: ConfinedFetchSeams | undefined, effect: EffectPlanEntryV1 | null,
  observeMutation: HostHttpsBrokerV1["observeMutation"],
  reserve: (usage: import("./types.js").HostBrokerUsageV1) => boolean,
  deadline: HostInvocationDeadlineV1,
): Promise<HostBrokerExecutionV1> {
  if (deadline.expired()) return effect
    ? unknownResponse("mutating HTTPS post-state is unknown after the invocation deadline")
    : response("unavailable", "HTTPS request exceeded the invocation deadline");
  const authorized = authorizedHeaders(operation, providerHeaders, secret);
  if ("outcome" in authorized) return authorized;
  const responseBytes = effectiveResponseBytes(operation, body, secret, budget);
  if (responseBytes === 0) return response("refused", "HTTPS aggregate byte cap is exhausted");
  const reservation = transferReservation(operation, body, responseBytes);
  if (reservation === null || !reserve({ httpsTransferBytes: reservation })) {
    return response("refused", "HTTPS aggregate byte cap is exhausted");
  }
  const result = await confinedFetchRequest(httpsRequest(operation, authorized.headers, body), {
    timeoutMs: operation.timeoutMs, maxBytes: responseBytes,
    maxTransportBytes: responseBytes,
    maxRedirects: operation.maxRedirects, contentTypes: operation.contentTypes,
    maxRequestBytes: operation.maxRequestBytes,
    maxResponseHeaderBytes: operation.maxResponseHeaderBytes, signal: deadline.signal,
  }, { allowedHosts: [new URL(operation.origin).hostname], allowedOrigins: [operation.origin] }, seams);
  const completed = await completedHttps(
    result, body, secret, operation, effect, observeMutation,
  );
  return Object.freeze({ ...completed, usageReserved: true });
}

function transferReservation(
  operation: HostHttpsOperationV1, body: Buffer | undefined, responseBytes: number,
): number | null {
  const hops = operation.maxRedirects + 1;
  const perHop = (body?.length ?? 0) + responseBytes;
  const total = hops * perHop;
  return Number.isSafeInteger(total) && total >= 0 ? total : null;
}

function effectiveResponseBytes(
  operation: HostHttpsOperationV1, body: Buffer | undefined,
  secret: Buffer | null, budget: HostBrokerBudgetV1,
): number {
  const operationLimit = secret
    ? Math.min(operation.maxResponseBytes, MAX_CREDENTIAL_VISIBLE_BYTES)
    : operation.maxResponseBytes;
  const remaining = Math.max(0, budget.httpsTransferBytes - (body?.length ?? 0));
  return Math.min(operationLimit, remaining);
}

function httpsRequest(
  operation: HostHttpsOperationV1, headers: Record<string, string>,
  body: Buffer | undefined,
): ConfinedFetchRequest {
  const base = { url: new URL(operation.path, operation.origin).toString(),
    method: operation.method, headers };
  return body === undefined ? base : { ...base, body };
}

async function completedHttps(
  result: ConfinedFetchResult, body: Buffer | undefined,
  secret: Buffer | null, operation: HostHttpsOperationV1,
  effect: EffectPlanEntryV1 | null, observeMutation: HostHttpsBrokerV1["observeMutation"],
): Promise<HostBrokerExecutionV1> {
  if (result.kind !== "ok") return effect
    ? unknownResponse("mutating HTTPS post-state is unknown")
    : response(result.kind, result.reason);
  const successful = successfulResponse(
    result.bytes, result.finalUrl, result.contentHash, body?.length ?? 0, secret,
  );
  if (!effect || !operation.effect || !observeMutation) return successful;
  try {
    const observed = await observeMutation(Object.freeze({
      operationId: operation.operationId, targetIdentity: operation.effect.targetIdentity,
      observationContractId: operation.effect.observationContractId,
      idempotencyKey: effect.idempotencyKey, finalUrl: result.finalUrl,
      responseDigest: parseSha256Digest(`sha256:${result.contentHash}`),
    }));
    return observedHttpsEffect(successful, observed);
  } catch { return unknownResponse("mutating HTTPS post-state is unknown"); }
}

function authorizedHeaders(
  operation: HostHttpsOperationV1, providerHeaders: Record<string, string>, secret: Buffer | null,
): { readonly headers: Record<string, string> } | HostBrokerExecutionV1 {
  if (secret && secret.length > MAX_BROKER_CREDENTIAL_BYTES) {
    return response("refused", "credential cannot be safely reflected-scanned");
  }
  const headers = { ...providerHeaders };
  if (operation.credential && !secret) return response("unavailable", "broker credential is unavailable");
  if (operation.credential && secret) {
    headers[operation.credential.headerName] = `${operation.credential.valuePrefix}${secret.toString("utf8")}`;
  }
  if (headerBytes(headers) > operation.maxRequestHeaderBytes) {
    return response("refused", "HTTPS request headers exceed byte cap");
  }
  return { headers };
}

function successfulResponse(
  bytes: Buffer, finalUrl: string, contentHash: string, requestBytes: number,
  secret: Buffer | null,
): HostBrokerExecutionV1 {
  let text: string;
  try { text = STRICT_UTF8.decode(bytes); }
  catch { return response("refused", "broker response is not valid UTF-8"); }
  return Object.freeze({
    outcome: "ok",
    output: Object.freeze({ body: text, finalUrl, contentHash }),
    usage: Object.freeze({ httpsTransferBytes: requestBytes + bytes.length }),
    visibleBytes: secret ? credentialReflectionChunks(bytes, secret.length) : Object.freeze([bytes]),
    responseDigest: parseSha256Digest(`sha256:${contentHash}`),
  });
}

function observedHttpsEffect(
  execution: HostBrokerExecutionV1,
  value: import("./types.js").HostExternalEffectObservationV1,
): HostBrokerExecutionV1 {
  const observed = captureOwnDataRecord(value);
  const allowed = new Set(["outcome", "observedExternalIdentity", "responseDigest", "output"]);
  if (Object.keys(observed).some((key) => !allowed.has(key))
    || !isEffectOutcome(observed.outcome)) throw requestError();
  const output = observed.output === undefined
    ? execution.output : captureBrokerJsonObject(observed.output);
  return Object.freeze({ ...execution, outcome: observed.outcome, output,
    ...observedIdentity(observed.observedExternalIdentity),
    ...(observed.responseDigest === undefined ? {} : {
      responseDigest: parseSha256Digest(observed.responseDigest),
    }) });
}

function isEffectOutcome(value: unknown): value is import("./receipts.js").ExternalEffectOutcomeV1 {
  return value === "applied" || value === "already-applied" || value === "refused"
    || value === "failed" || value === "unavailable" || value === "outcome-unknown";
}

function observedIdentity(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > 4_096
    || /[\u0000-\u001f\u007f]/.test(value)) throw requestError();
  return { observedExternalIdentity: value };
}

function unknownResponse(reason: string): HostBrokerExecutionV1 {
  return Object.freeze({ outcome: "outcome-unknown", output: Object.freeze({ reason }) });
}

export function credentialReflectionChunks(bytes: Buffer, _secretLength: number): readonly Buffer[] {
  return Object.freeze([Buffer.from(bytes)]);
}

function headerBytes(headers: Record<string, string>): number {
  return Object.entries(headers).reduce((total, [name, value]) =>
    total + Buffer.byteLength(name) + Buffer.byteLength(value), 0);
}
function bounded(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

const response = brokerFailure;
function requestError(): Error { return new Error("provider HTTPS broker request is invalid"); }
function unavailableError(): Error { return new Error("provider HTTPS broker is unavailable"); }
