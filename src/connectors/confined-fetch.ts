/**
 * @file src/connectors/confined-fetch.ts
 * @description Hardened HTTPS fetch primitive for first-party connectors.
 */
import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import type { IncomingHttpHeaders } from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { Readable, Transform } from "node:stream";
import { createGunzip } from "node:zlib";
import { isPrivateAddress } from "./private-address.js";
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
  /** Maximum encoded response bytes read from the socket. Defaults to maxBytes. */
  maxTransportBytes?: number;
  maxRedirects: number;
  contentTypes: readonly string[];
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
  timeoutMs: number;
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

/** Fetch one HTTPS connector request through the shared confinement policy. */
export async function confinedFetch(
  req: ConnectorRequest,
  limits: FetchLimits,
  policy: ConfinedFetchPolicy,
  seams: ConfinedFetchSeams = {},
): Promise<ConfinedFetchResult> {
  const parsed = validateUrl(req.url, policy);
  if (parsed.kind !== "ok") return parsed;
  const headers = validateHeaders(req.headers ?? {});
  if (headers.kind !== "ok") return headers;
  const start = now(seams);
  return fetchHop(parsed.url, headers.headers, limits, policy, seams, limits.maxRedirects, start + limits.timeoutMs, start);
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
  const response = await requestPinned(url, headers, resolved.address, timeoutMs, seams);
  if (response.kind !== "ok") return response;
  if (isRedirect(response.response.statusCode)) {
    return followRedirect(response.response, url, headers, limits, policy, seams, redirectsLeft, deadlineMs);
  }
  return decodeResponse(response.response, url, limits, seams, deadlineMs);
}

async function followRedirect(
  response: ConfinedHttpResponse,
  baseUrl: URL,
  headers: Record<string, string>,
  limits: FetchLimits,
  policy: ConfinedFetchPolicy,
  seams: ConfinedFetchSeams,
  redirectsLeft: number,
  deadlineMs: number,
): Promise<ConfinedFetchResult> {
  if (redirectsLeft <= 0) return destroyReturning(response.body, { kind: "refused", reason: "connector redirect limit exceeded" });
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
  return fetchHop(next.url, headers, limits, policy, seams, redirectsLeft - 1, deadlineMs, now(seams));
}

async function resolvePinnedAddress(hostname: string, seams: ConfinedFetchSeams) {
  const lookup = seams.lookup ?? defaultLookup;
  let addresses: LookupAddress[];
  try {
    addresses = await lookup(hostname);
  } catch {
    return { kind: "unavailable" as const, reason: "connector host lookup failed" };
  }
  if (addresses.length === 0) return { kind: "unavailable" as const, reason: "connector host did not resolve" };
  if (addresses.some((entry) => isPrivateAddress(entry.address))) {
    return { kind: "refused" as const, reason: "connector host resolved to a private address" };
  }
  const first = addresses[0];
  if (first.family !== 4 && first.family !== 6) return { kind: "unavailable" as const, reason: "connector host resolved to an unknown address family" };
  return { kind: "ok" as const, address: { address: first.address, family: first.family } };
}

async function defaultLookup(hostname: string): Promise<LookupAddress[]> {
  if (isIP(hostname)) return [{ address: hostname, family: isIP(hostname) as 4 | 6 }];
  return dnsLookup(hostname, { all: true, verbatim: true });
}

async function requestPinned(
  url: URL,
  headers: Record<string, string>,
  address: LookupAddress,
  timeoutMs: number,
  seams: ConfinedFetchSeams,
): Promise<{ kind: "ok"; response: ConfinedHttpResponse } | { kind: "unavailable"; reason: string }> {
  const request = buildRequest(url, headers, address, timeoutMs);
  try {
    const response = await (seams.request ?? defaultRequest)(request);
    return { kind: "ok", response };
  } catch {
    return { kind: "unavailable", reason: "connector fetch failed" };
  }
}

function buildRequest(
  url: URL,
  headers: Record<string, string>,
  address: LookupAddress,
  timeoutMs: number,
): ConfinedHttpRequest {
  return {
    url,
    hostname: address.address,
    family: address.family as 4 | 6,
    servername: url.hostname,
    hostHeader: url.host,
    path: `${url.pathname}${url.search}`,
    headers: { ...headers, Host: url.host, "Accept-Encoding": "gzip, identity" },
    timeoutMs,
  };
}

function defaultRequest(request: ConfinedHttpRequest): Promise<ConfinedHttpResponse> {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: request.hostname,
      family: request.family,
      servername: request.servername,
      port: request.url.port ? Number(request.url.port) : 443,
      path: request.path,
      method: "GET",
      headers: request.headers,
      timeout: request.timeoutMs,
    }, (res) => resolve({ statusCode: res.statusCode ?? 0, headers: res.headers, body: res }));
    req.on("timeout", () => req.destroy(new Error("connector fetch timed out")));
    req.on("error", reject);
    req.end();
  });
}

async function decodeResponse(
  response: ConfinedHttpResponse,
  url: URL,
  limits: FetchLimits,
  seams: ConfinedFetchSeams,
  deadlineMs: number,
): Promise<ConfinedFetchResult> {
  if (response.statusCode < 200 || response.statusCode >= 300) {
    return destroyReturning(response.body, { kind: "unavailable", reason: `connector returned HTTP ${response.statusCode}` });
  }
  const contentType = mediaType(firstHeader(response.headers["content-type"]));
  if (!contentType || !limits.contentTypes.includes(contentType)) {
    return destroyReturning(response.body, { kind: "refused", reason: "connector response content type is not allowed" });
  }
  const stream = decodedStream(response, limits.maxTransportBytes ?? limits.maxBytes);
  if (stream.kind !== "ok") return stream;
  const bytes = await readCapped(stream, limits.maxBytes, seams, deadlineMs);
  if (bytes.kind !== "ok") return bytes;
  return { kind: "ok", bytes: bytes.bytes, finalUrl: url.toString(), contentHash: sha256(bytes.bytes) };
}

type StreamBundle = { kind: "ok"; body: Readable; source: Readable };

function decodedStream(response: ConfinedHttpResponse, maxTransportBytes: number): StreamBundle | { kind: "refused"; reason: string } {
  const encoding = (firstHeader(response.headers["content-encoding"]) ?? "identity").toLowerCase();
  if (encoding !== "identity" && encoding !== "" && encoding !== "gzip") {
    return destroyReturning(response.body, { kind: "refused", reason: "connector response encoding is not allowed" });
  }
  const counted = response.body.pipe(new ByteCapTransform(maxTransportBytes, response.body));
  const body = encoding === "gzip" ? pipeGunzip(counted) : counted;
  return { kind: "ok", body, source: response.body };
}

function pipeGunzip(counted: Readable): Readable {
  const gunzip = createGunzip();
  counted.on("error", (error) => gunzip.destroy(error));
  return counted.pipe(gunzip);
}

async function readCapped(
  stream: StreamBundle,
  maxBytes: number,
  seams: ConfinedFetchSeams,
  deadlineMs: number,
): Promise<{ kind: "ok"; bytes: Buffer } | { kind: "refused"; reason: string } | { kind: "unavailable"; reason: string }> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    if (deadlineReached(seams, deadlineMs)) return fetchTimedOut(stream);
    for await (const chunk of stream.body) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > maxBytes) return destroyReturning(stream, { kind: "refused", reason: "connector response exceeds byte cap" });
      if (deadlineReached(seams, deadlineMs)) return fetchTimedOut(stream);
      chunks.push(buffer);
    }
  } catch (error) {
    if (error instanceof TransportCapError) {
      return destroyReturning(stream, { kind: "refused", reason: "connector response exceeds transport byte cap" });
    }
    return destroyReturning(stream, { kind: "unavailable", reason: "connector response could not be decoded" });
  }
  return { kind: "ok", bytes: Buffer.concat(chunks) };
}

/** True once the single request/redirect/body deadline has been spent. */
function deadlineReached(seams: ConfinedFetchSeams, deadlineMs: number): boolean {
  return now(seams) >= deadlineMs;
}

/** Fail closed and stop reading when the connector fetch deadline expires. */
function fetchTimedOut(stream: StreamBundle): { kind: "unavailable"; reason: string } {
  return destroyReturning(stream, { kind: "unavailable", reason: "connector fetch timed out" });
}

class TransportCapError extends Error {}

class ByteCapTransform extends Transform {
  private total = 0;

  constructor(private readonly maxBytes: number, private readonly source: Readable) { super(); }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null, data?: Buffer) => void): void {
    this.total += chunk.length;
    if (this.total > this.maxBytes) this.source.destroy();
    callback(this.total > this.maxBytes ? new TransportCapError() : null, chunk);
  }
}

function destroyReturning<T>(stream: Readable | StreamBundle, result: T): T {
  if ("source" in stream) {
    stream.body.destroy();
    stream.source.destroy();
  } else stream.destroy();
  return result;
}

function isSafeHeaderValue(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

function isRedirect(statusCode: number): boolean {
  return statusCode >= 300 && statusCode < 400;
}

function firstHeader(value: string | string[] | number | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return typeof value === "string" ? value : undefined;
}

function mediaType(contentType: string | undefined): string | undefined {
  return contentType?.split(";")[0]?.trim().toLowerCase();
}

function now(seams: ConfinedFetchSeams): number {
  return seams.now?.() ?? Date.now();
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
