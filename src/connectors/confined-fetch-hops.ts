/**
 * @file src/connectors/confined-fetch-hops.ts
 * @description Per-hop network execution for the hardened connector fetch:
 * pinned DNS resolution, the pinned HTTPS request, bounded response decoding,
 * and the deadline/byte-cap primitives. These are moved verbatim from
 * confined-fetch.ts (no logic change); the SSRF orchestration and redirect loop
 * that drive them stay there and import this module.
 */
import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import type { IncomingHttpHeaders } from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { Readable, Transform } from "node:stream";
import { types as utilTypes } from "node:util";
import { createGunzip } from "node:zlib";
import { captureDenseArray, captureExactRecord, captureOwnDataRecord } from "../utils/runtime-capture.js";
import { isPrivateAddress } from "./private-address.js";
import type {
  ConfinedFetchMethod, ConfinedFetchResult, ConfinedFetchSeams,
  ConfinedHttpRequest, ConfinedHttpResponse, FetchLimits,
} from "./confined-fetch.js";

type StreamBundle = { kind: "ok"; body: Readable; source: Readable };

export async function resolvePinnedAddress(hostname: string, seams: ConfinedFetchSeams) {
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

export async function requestPinned(
  url: URL,
  method: ConfinedFetchMethod,
  body: Buffer | undefined,
  headers: Record<string, string>,
  address: LookupAddress,
  timeoutMs: number,
  seams: ConfinedFetchSeams,
  signal: AbortSignal | undefined,
): Promise<{ kind: "ok"; response: ConfinedHttpResponse } | { kind: "unavailable"; reason: string }> {
  const request = buildRequest(url, method, body, headers, address, timeoutMs, signal);
  try {
    const raw = captureExactRecord(await (seams.request ?? defaultRequest)(request),
      ["statusCode", "headers", "body"]);
    if (!Number.isSafeInteger(raw.statusCode) || !(raw.body instanceof Readable) || utilTypes.isProxy(raw.body)) throw new Error();
    const capturedHeaders = captureOwnDataRecord(raw.headers), safeHeaders: IncomingHttpHeaders = {};
    for (const [name, value] of Object.entries(capturedHeaders)) {
      if (typeof value === "string") safeHeaders[name] = value;
      else safeHeaders[name] = captureDenseArray(value, 256, (item) => {
        if (typeof item !== "string") throw new Error(); return item;
      }) as string[];
    }
    return { kind: "ok", response: Object.freeze({ statusCode: Number(raw.statusCode), headers: Object.freeze(safeHeaders), body: raw.body }) };
  } catch {
    return { kind: "unavailable", reason: "connector fetch failed" };
  }
}

function buildRequest(
  url: URL,
  method: ConfinedFetchMethod,
  body: Buffer | undefined,
  headers: Record<string, string>,
  address: LookupAddress,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): ConfinedHttpRequest {
  return {
    url,
    hostname: address.address,
    family: address.family as 4 | 6,
    servername: url.hostname,
    hostHeader: url.host,
    path: `${url.pathname}${url.search}`,
    headers: { ...headers, Host: url.host, "Accept-Encoding": "gzip, identity" },
    method,
    ...(body === undefined ? {} : { body: Buffer.from(body) }),
    timeoutMs,
    ...(signal === undefined ? {} : { signal }),
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
      method: request.method,
      headers: request.headers,
      timeout: request.timeoutMs,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    }, (res) => resolve({ statusCode: res.statusCode ?? 0, headers: res.headers, body: res }));
    req.on("timeout", () => req.destroy(new Error("connector fetch timed out")));
    req.on("error", reject);
    req.end(request.body);
  });
}

export async function decodeResponse(
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

export function destroyReturning<T>(stream: Readable | StreamBundle, result: T): T {
  if ("source" in stream) {
    stream.body.destroy();
    stream.source.destroy();
  } else stream.destroy();
  return result;
}

export function isRedirect(statusCode: number): boolean {
  return statusCode >= 300 && statusCode < 400;
}

export function redirectPreservesRequest(statusCode: number, method: ConfinedFetchMethod): boolean {
  // Preserve public GET redirect handling; every destination is still confined.
  if (method === "GET") return isRedirect(statusCode);
  if (statusCode === 307 || statusCode === 308) return true;
  return (statusCode === 301 || statusCode === 302 || statusCode === 303)
    && method === "HEAD";
}

export function firstHeader(value: string | string[] | number | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return typeof value === "string" ? value : undefined;
}

function mediaType(contentType: string | undefined): string | undefined {
  return contentType?.split(";")[0]?.trim().toLowerCase();
}

export function responseHeaderBytes(headers: IncomingHttpHeaders): number {
  return Object.entries(headers).reduce((total, [name, value]) => {
    const values = Array.isArray(value) ? value : [value];
    return total + Buffer.byteLength(name)
      + values.reduce((sum, item) => sum + Buffer.byteLength(String(item ?? "")), 0);
  }, 0);
}

export function now(seams: ConfinedFetchSeams): number {
  return seams.now?.() ?? Date.now();
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
