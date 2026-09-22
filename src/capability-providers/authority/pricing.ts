/**
 * @file src/capability-providers/authority/pricing.ts
 * @description Exact host-owned provider price tables and digest-pinned
 * lookups. Missing, unknown, ambiguous, expired, or drifted prices fail closed;
 * provider- or pack-declared price fields are never accepted.
 */
import path from "node:path";
import { atomicWrite } from "../../utils/atomic-write.js";
import { captureDenseArray, captureExactRecord } from "../../utils/runtime-capture.js";
import { canonicalDigest } from "../../profile/templates/signing/canonical.js";
import { parseBoundedUniqueJson } from "../../profile/templates/signing/json.js";
import { parseSha256Digest } from "../ids.js";
import type { AuthorizedProviderPaths } from "../packages/paths.js";
import { withProviderStateLock } from "../packages/state-store.js";
import type { Sha256Digest } from "../types.js";
import type {
  HostPriceEntryV1, HostPriceRequestV1, HostPriceTableV1,
} from "./types.js";
import { readProviderAuthorityText } from "./grants-store.js";

const MAX_PRICE_TABLE_BYTES = 4 * 1024 * 1024;
const MAX_PRICE_ENTRIES = 50_000;
const PRICING_FILENAME = "provider-pricing-v1.json";
const TABLE_KEYS = Object.freeze(["schemaVersion", "currency", "validFrom", "validUntil", "entries"] as const);
const ENTRY_KEYS = Object.freeze(["brokerContract", "service", "modelOrSku", "unit", "priceUsdPerUnit"] as const);
const REQUEST_KEYS = Object.freeze(["brokerContract", "service", "modelOrSku", "unit", "currency"] as const);
const MIN_PROVIDER_PRICE_USD_PER_UNIT_V1 = 1e-12;
const HOST_SHIPPED_PRICE_TABLE_V1: HostPriceTableV1 = Object.freeze({
  schemaVersion: 1, currency: "USD", validFrom: "1970-01-01T00:00:00.000Z",
  validUntil: "9999-12-31T23:59:59.999Z", entries: Object.freeze([]),
});

/** Parse one complete duplicate-key-free host price table. */
export function parseHostPriceTable(text: string): HostPriceTableV1 {
  try { return captureHostPriceTable(parseBoundedUniqueJson(text, MAX_PRICE_TABLE_BYTES)); }
  catch (error) {
    if (error instanceof Error && /duplicate or ambiguous/.test(error.message)) throw error;
    throw pricingInvalidError();
  }
}

/** Return the one RFC-8785 digest bound into grants and receipts. */
export function hostPriceTableDigest(table: HostPriceTableV1): Sha256Digest {
  return parseSha256Digest(canonicalDigest(captureHostPriceTable(table)));
}

/** Resolve an exact active key only under the caller's expected table digest. */
export async function resolveHostPrice(
  paths: AuthorizedProviderPaths,
  request: HostPriceRequestV1,
  expectedDigest: Sha256Digest,
  now: Date,
): Promise<HostPriceEntryV1 & { readonly currency: "USD"; readonly priceTableDigest: Sha256Digest }> {
  const query = capturePriceRequest(request);
  const expected = parseSha256Digest(expectedDigest);
  const requestedAt = capturePricingTime(now);
  const snapshot = await readHostPriceTable(paths);
  const actualDigest = hostPriceTableDigest(snapshot);
  if (expected !== actualDigest) throw pricingDriftError();
  if (requestedAt < new Date(snapshot.validFrom) || requestedAt >= new Date(snapshot.validUntil)) {
    throw pricingUnavailableError();
  }
  const matches = snapshot.entries.filter((entry) => priceKey(entry) === priceKey(query));
  if (matches.length !== 1) throw pricingUnavailableError();
  return Object.freeze({ ...matches[0], currency: "USD" as const, priceTableDigest: actualDigest });
}

/** Read operator pricing or the immutable shipped v1 table on genuine absence. */
export async function readHostPriceTable(paths: AuthorizedProviderPaths): Promise<HostPriceTableV1> {
  const read = await readProviderAuthorityText(paths, PRICING_FILENAME, MAX_PRICE_TABLE_BYTES);
  if (read.kind === "absent") return HOST_SHIPPED_PRICE_TABLE_V1;
  if (read.kind !== "ok") throw pricingUnavailableError();
  try { return parseHostPriceTable(read.text); }
  catch { throw pricingUnavailableError(); }
}

/** Dedicated operator transaction; provider and pack code have no write seam. */
export async function writeOperatorPriceTable(
  paths: AuthorizedProviderPaths,
  table: HostPriceTableV1,
  confirmedDigest: Sha256Digest,
): Promise<void> {
  const snapshot = captureHostPriceTable(table);
  const digest = hostPriceTableDigest(snapshot);
  if (parseSha256Digest(confirmedDigest) !== digest) throw new Error("provider pricing confirmation differs");
  await withProviderStateLock(paths, async () => {
    const text = `${JSON.stringify(snapshot, null, 2)}\n`;
    if (Buffer.byteLength(text) > MAX_PRICE_TABLE_BYTES) throw pricingInvalidError();
    await atomicWrite(path.join(paths.configRoot, PRICING_FILENAME), text, {
      confineRoot: paths.configRoot, exactParent: true, durable: true,
      strictDurability: true, mode: 0o600,
    });
  });
}

function captureHostPriceTable(value: unknown): HostPriceTableV1 {
  const table = captureExactRecord(value, TABLE_KEYS);
  if (table.schemaVersion !== 1 || table.currency !== "USD") throw pricingInvalidError();
  const validFrom = timestamp(table.validFrom);
  const validUntil = timestamp(table.validUntil);
  if (new Date(validFrom) >= new Date(validUntil)) throw pricingInvalidError();
  const entries = captureDenseArray(table.entries, MAX_PRICE_ENTRIES, parsePriceEntry, pricingInvalidError);
  const keys = entries.map(priceKey);
  if (new Set(keys).size !== keys.length) throw new Error("provider pricing has duplicate or ambiguous entries");
  return Object.freeze({ schemaVersion: 1, currency: "USD", validFrom, validUntil, entries });
}

function parsePriceEntry(value: unknown): HostPriceEntryV1 {
  const entry = captureExactRecord(value, ENTRY_KEYS);
  const price = entry.priceUsdPerUnit;
  if (typeof price !== "number" || !Number.isFinite(price)
    || price < MIN_PROVIDER_PRICE_USD_PER_UNIT_V1) throw pricingInvalidError();
  return Object.freeze({
    brokerContract: token(entry.brokerContract), service: token(entry.service),
    modelOrSku: token(entry.modelOrSku), unit: token(entry.unit), priceUsdPerUnit: price,
  });
}

function capturePriceRequest(value: unknown): HostPriceRequestV1 {
  try {
    const request = captureExactRecord(value, REQUEST_KEYS);
    if (request.currency !== "USD") throw pricingInvalidError();
    return Object.freeze({
      brokerContract: token(request.brokerContract), service: token(request.service),
      modelOrSku: token(request.modelOrSku), unit: token(request.unit), currency: "USD",
    });
  } catch { throw pricingInvalidError(); }
}

function priceKey(value: Pick<HostPriceEntryV1, "brokerContract" | "service" | "modelOrSku" | "unit">): string {
  return [value.brokerContract, value.service, value.modelOrSku, value.unit].join("\0");
}
function token(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,255}$/.test(value)) throw pricingInvalidError();
  return value;
}
function timestamp(value: unknown): string {
  try {
    if (typeof value !== "string" || new Date(value).toISOString() !== value) throw pricingInvalidError();
    return value;
  } catch { throw pricingInvalidError(); }
}
/** Capture one clock value without invoking a caller-owned Date override. */
function capturePricingTime(value: Date): Date {
  try {
    const milliseconds = Date.prototype.getTime.call(value);
    if (!Number.isFinite(milliseconds)) throw pricingUnavailableError();
    return new Date(milliseconds);
  } catch { throw pricingUnavailableError(); }
}
function pricingInvalidError(): Error { return new Error("provider pricing is invalid"); }
function pricingUnavailableError(): Error { return new Error("provider pricing is unavailable"); }
function pricingDriftError(): Error { return new Error("provider pricing has drifted"); }
