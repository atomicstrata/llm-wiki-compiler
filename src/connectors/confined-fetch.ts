/**
 * @file src/connectors/confined-fetch.ts
 * @description Hardened HTTPS fetch primitive for first-party connectors.
 */
import type { LookupAddress } from "node:dns";
import type { IncomingHttpHeaders } from "node:http";
import { Readable } from "node:stream";
import {
  decodeResponse, destroyReturning, firstHeader, isRedirect, now,
  redirectPreservesRequest, requestPinned, resolvePinnedAddress, responseHeaderBytes,
} from "./confined-fetch-hops.js";
import type { ConnectorRequest } from "./types.js";

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * Longest connector URL accepted at ANY hop (initial request and every redirect).
 * This bound is what lets the pre-fetch audit gate pad the event's finalUrl to a
 * true worst case rather than an estimate.
 */
export const MAX_CONNECTOR_URL_BYTES = 2048;

/** Resource bounds applied by the connector substrate to one external fetch. */
export interface FetchLimits {
  timeoutMs: number;
  maxBytes: number;
  /** Maximum request-body bytes. Legacy GET callers omit this and send no body. */
  maxRequestBytes?: number;
  /** Maximum encoded response bytes read from the socket. Defaults to maxBytes. */
  maxTransportBytes?: number;
  /** Maximum aggregate response-header bytes. Legacy callers may omit it. */
  maxResponseHeaderBytes?: number;
  maxRedirects: number;
  contentTypes: readonly string[];
  /** Optional host abort signal that aborts every hop's socket when triggered. */
  signal?: AbortSignal;
}

/** The only results a connector fetch can produce. */
export type ConfinedFetchResult =
  | { kind: "ok"; bytes: Buffer; finalUrl: string; contentHash: string }
  | { kind: "refused"; reason: string }
  | { kind: "unavailable"; reason: string };

/** The pinned HTTPS request passed to the network seam. */
export interface ConfinedHttpRequest {
  url: URL;
  hostname: string;
  family: 4 | 6;
  servername: string;
  hostHeader: string;
  path: string;
  headers: Record<string, string>;
  method: ConfinedFetchMethod;
  body?: Buffer;
  timeoutMs: number;
  signal?: AbortSignal;
}

/** Minimal HTTP response shape used by production and deterministic tests. */
export interface ConfinedHttpResponse {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: Readable;
}

/** Injectable seams for deterministic SSRF/resource-bound tests. */
export interface ConfinedFetchSeams {
  lookup?: (hostname: string) => Promise<LookupAddress[]>;
  request?: (request: ConfinedHttpRequest) => Promise<ConfinedHttpResponse>;
  now?: () => number;
}

/** Host-only connector policy or exact-origin registry policy. */
export type ConfinedFetchPolicy = readonly string[] | {
  allowedHosts: readonly string[];
  allowedOrigins: readonly string[];
};

/** Typed host request accepted by brokers while retaining connector confinement. */
export interface ConfinedFetchRequest {
  readonly url: string;
  readonly method: ConfinedFetchMethod;
  readonly headers?: Record<string, string>;
  readonly body?: Uint8Array;
}
export type ConfinedFetchMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Fetch one HTTPS connector request through the shared confinement policy. */
export async function confinedFetch(
  req: ConnectorRequest,
  limits: FetchLimits,
  policy: ConfinedFetchPolicy,
  seams: ConfinedFetchSeams = {},
): Promise<ConfinedFetchResult> {
  return confinedFetchRequest({ url: req.url, method: "GET", headers: req.headers }, limits, policy, seams);
}

/** Fetch one typed host request through the same pinned per-hop confinement. */
export async function confinedFetchRequest(
  req: ConfinedFetchRequest, limits: FetchLimits, policy: ConfinedFetchPolicy,
  seams: ConfinedFetchSeams = {},
): Promise<ConfinedFetchResult> {
  const parsed = validateUrl(req.url, policy);
  if (parsed.kind !== "ok") return parsed;
  const headers = validateHeaders(req.headers ?? {});
  if (headers.kind !== "ok") return headers;
  if (!validMethod(req.method)) return { kind: "refused", reason: "connector method is not allowed" };
  const body = req.body === undefined ? undefined : Buffer.from(req.body);
  if (body && body.length > (limits.maxRequestBytes ?? 0)) {
    return { kind: "refused", reason: "connector request exceeds byte cap" };
  }
  if (limits.signal?.aborted) return { kind: "unavailable", reason: "connector fetch aborted" };
  const start = now(seams);
  return fetchHop(parsed.url, req.method, body, headers.headers, limits, policy, seams,
    limits.maxRedirects, start + limits.timeoutMs, start);
}

type UrlValidation = { kind: "ok"; url: URL } | { kind: "refused"; reason: string };
type HeaderValidation = { kind: "ok"; headers: Record<string, string> } | { kind: "refused"; reason: string };

function validateUrl(raw: string, policy: ConfinedFetchPolicy): UrlValidation {
  if (Buffer.byteLength(raw, "utf8") > MAX_CONNECTOR_URL_BYTES) {
    return { kind: "refused", reason: "connector URL exceeds the byte cap" };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { kind: "refused", reason: "invalid connector URL" };
  }
  return validateParsedUrl(url, policy);
}

function validateParsedUrl(url: URL, policy: ConfinedFetchPolicy): UrlValidation {
  if (Buffer.byteLength(url.toString(), "utf8") > MAX_CONNECTOR_URL_BYTES) return urlRefusal("connector URL exceeds the byte cap");
  if (url.protocol !== "https:") return urlRefusal("connector URL must use https");
  if (url.username || url.password) return urlRefusal("connector URL cannot include userinfo");
  if (!allowedHostnames(policy).includes(url.hostname.toLowerCase())) return urlRefusal("connector URL host is not allowlisted");
  if (isExactOriginPolicy(policy) && !normalizedOrigins(policy).includes(url.origin)) return urlRefusal("connector URL origin is not allowlisted");
  return { kind: "ok", url };
}

function urlRefusal(reason: string): UrlValidation {
  return { kind: "refused", reason };
}

function allowedHostnames(policy: ConfinedFetchPolicy): string[] {
  const hosts = isExactOriginPolicy(policy) ? policy.allowedHosts : policy;
  return hosts.map((host) => host.toLowerCase());
}

function isExactOriginPolicy(policy: ConfinedFetchPolicy): policy is Exclude<ConfinedFetchPolicy, readonly string[]> {
  return !Array.isArray(policy);
}

function normalizedOrigins(policy: { allowedOrigins: readonly string[] }): string[] {
  return policy.allowedOrigins.map((origin) => new URL(origin).origin);
}

function validateHeaders(headers: Record<string, string>): HeaderValidation {
  const clean: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HEADER_NAME.test(name)) return { kind: "refused", reason: "invalid connector header name" };
    if (!isSafeHeaderValue(value)) return { kind: "refused", reason: "invalid connector header value" };
    clean[name] = value;
  }
  return { kind: "ok", headers: clean };
}

/** Validate connector request headers without dialing the network. */
export function validateConnectorHeaders(headers: Record<string, string>): HeaderValidation {
  return validateHeaders(headers);
}

async function fetchHop(
  url: URL,
  method: ConfinedFetchMethod,
  body: Buffer | undefined,
  headers: Record<string, string>,
  limits: FetchLimits,
  policy: ConfinedFetchPolicy,
  seams: ConfinedFetchSeams,
  redirectsLeft: number,
  deadlineMs: number,
  currentMs: number,
): Promise<ConfinedFetchResult> {
  const resolved = await resolvePinnedAddress(url.hostname, seams);
  if (resolved.kind !== "ok") return resolved;
  const timeoutMs = deadlineMs - currentMs;
  if (timeoutMs <= 0) return { kind: "unavailable", reason: "connector fetch timed out" };
  if (limits.signal?.aborted) return { kind: "unavailable", reason: "connector fetch aborted" };
  const response = await requestPinned(url, method, body, headers, resolved.address, timeoutMs, seams, limits.signal);
  if (response.kind !== "ok") return response;
  if (limits.maxResponseHeaderBytes !== undefined
    && responseHeaderBytes(response.response.headers) > limits.maxResponseHeaderBytes) {
    return destroyReturning(response.response.body, {
      kind: "refused", reason: "connector response headers exceed byte cap",
    });
  }
  if (isRedirect(response.response.statusCode)) {
    return followRedirect(response.response, url, method, body, headers, limits, policy, seams,
      redirectsLeft, deadlineMs);
  }
  return decodeResponse(response.response, url, limits, seams, deadlineMs);
}

async function followRedirect(
  response: ConfinedHttpResponse,
  baseUrl: URL,
  method: ConfinedFetchMethod,
  body: Buffer | undefined,
  headers: Record<string, string>,
  limits: FetchLimits,
  policy: ConfinedFetchPolicy,
  seams: ConfinedFetchSeams,
  redirectsLeft: number,
  deadlineMs: number,
): Promise<ConfinedFetchResult> {
  if (redirectsLeft <= 0) return destroyReturning(response.body, { kind: "refused", reason: "connector redirect limit exceeded" });
  if (!redirectPreservesRequest(response.statusCode, method)) {
    return destroyReturning(response.body, { kind: "refused", reason: "connector redirect cannot change request semantics" });
  }
  const location = firstHeader(response.headers.location);
  if (!location) return destroyReturning(response.body, { kind: "unavailable", reason: "connector redirect missing location" });
  let target: string;
  try {
    target = new URL(location, baseUrl).toString();
  } catch {
    return destroyReturning(response.body, { kind: "refused", reason: "connector redirect location is invalid" });
  }
  const next = validateUrl(target, policy);
  response.body.destroy();
  if (next.kind !== "ok") return next;
  return fetchHop(next.url, method, body, headers, limits, policy, seams,
    redirectsLeft - 1, deadlineMs, now(seams));
}

function isSafeHeaderValue(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

function validMethod(value: unknown): value is ConfinedFetchMethod {
  return value === "GET" || value === "HEAD" || value === "POST"
    || value === "PUT" || value === "PATCH" || value === "DELETE";
}
