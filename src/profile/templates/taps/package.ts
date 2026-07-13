/**
 * @file src/profile/templates/taps/package.ts
 * @description Content-addressed package retrieval with full cached-byte re-verification.
 */
import { TextDecoder } from "node:util";
import packageJson from "../../../../package.json" with { type: "json" };
import { confinedFetch, type ConfinedFetchSeams } from "../../../connectors/confined-fetch.js";
import type { ProfileTemplatePackage } from "../types.js";
import { parseSignedPackage, parseTemplateCoordinate, sha256DigestHex } from "../signing/protocol.js";
import { verifySignedPackage } from "../signing/verify.js";
import { readPackageCache, writePackageCache } from "./cache.js";
import { loadAcceptedIndex } from "./evidence.js";
import type { TapPaths } from "./paths.js";
import { readTapState } from "./state-store.js";
import { canonicalDigest } from "../signing/canonical.js";

const PACKAGE_LIMITS = {
  timeoutMs: 15_000,
  maxBytes: 2 * 1024 * 1024,
  maxTransportBytes: 2 * 1024 * 1024,
  maxRedirects: 3,
  contentTypes: ["application/json"],
};

/** Verified remote package plus stable public provenance. */
export interface ResolvedRemotePackage {
  package: ProfileTemplatePackage;
  coordinate: string;
  payloadDigest: string;
  publisherKeyId: string;
  tapSequence: number;
  indexExpired: boolean;
}

/** Network/test controls; production fetches by default, offline must be explicit. */
export interface ResolveRemoteOptions {
  seams?: ConfinedFetchSeams;
  offline?: boolean;
  currentVersion?: string;
}

/** Resolve one accepted coordinate from verified cache or exact-origin network. */
export async function resolveRemotePackage(
  paths: TapPaths,
  coordinate: string,
  options: ResolveRemoteOptions = {},
): Promise<ResolvedRemotePackage> {
  const parsedCoordinate = parseTemplateCoordinate(coordinate);
  const state = await readTapState(paths);
  const source = state.taps[parsedCoordinate.tap];
  if (!source || !source.enabled) throw new Error("template tap is unavailable or disabled");
  const index = await loadAcceptedIndex(paths, source);
  const entry = index.packages.find((candidate) => candidate.coordinate === coordinate);
  if (!entry) throw new Error(`template coordinate is not accepted: ${coordinate}`);
  assertEntryActive(source, entry.payloadDigest, entry.publisher, index.publishers[entry.publisher]?.keyId);
  const currentVersion = options.currentVersion ?? packageJson.version;
  const evidence = await packageEvidence(paths, coordinate, source.indexUrl, source.origin, entry.payloadDigest, index, source.publisherPins, currentVersion, options);
  const pkg = verifyPackageText(evidence.text, index, source.publisherPins, currentVersion);
  await assertSourceUnchanged(paths, source);
  if (!evidence.cached) await writePackageCache(paths, coordinate, entry.payloadDigest, evidence.text);
  return {
    package: pkg,
    coordinate,
    payloadDigest: entry.payloadDigest,
    publisherKeyId: index.publishers[entry.publisher].keyId,
    tapSequence: index.sequence,
    indexExpired: Date.parse(index.expiresAt) <= Date.now(),
  };
}

function assertEntryActive(
  source: Awaited<ReturnType<typeof readTapState>>["taps"][string],
  digest: string,
  publisher: string,
  publisherKeyId: string | undefined,
): void {
  if (!publisherKeyId) throw new Error(`template publisher is unavailable: ${publisher}`);
  if (source.publisherPins.revokedPackages.includes(digest)) throw new Error("template package is revoked");
  if (source.publisherPins.revokedPublisherKeys.includes(publisherKeyId)) throw new Error("template publisher key is revoked");
}

async function packageEvidence(
  paths: TapPaths,
  coordinate: string,
  indexUrl: string,
  origin: string,
  digest: string,
  index: Parameters<typeof verifySignedPackage>[1],
  pins: Parameters<typeof verifySignedPackage>[2],
  currentVersion: string,
  options: ResolveRemoteOptions,
): Promise<{ text: string; cached: boolean }> {
  const cached = await readPackageCache(paths, coordinate, digest);
  if (cached !== null && cacheVerifies(cached, index, pins, currentVersion)) return { text: cached, cached: true };
  if (options.offline) throw new Error("template package is not cached; refresh online to inspect it");
  const result = await confinedFetch(
    { url: packageUrl(indexUrl, digest) },
    PACKAGE_LIMITS,
    { allowedHosts: [new URL(indexUrl).hostname], allowedOrigins: [origin] },
    options.seams ?? {},
  );
  if (result.kind !== "ok") throw new Error(`template package ${result.kind}: ${result.reason}`);
  return { text: strictUtf8(result.bytes), cached: false };
}

function cacheVerifies(
  text: string,
  index: Parameters<typeof verifySignedPackage>[1],
  pins: Parameters<typeof verifySignedPackage>[2],
  currentVersion: string,
): boolean {
  try {
    verifyPackageText(text, index, pins, currentVersion);
    return true;
  } catch {
    return false;
  }
}

function verifyPackageText(
  text: string,
  index: Parameters<typeof verifySignedPackage>[1],
  pins: Parameters<typeof verifySignedPackage>[2],
  currentVersion: string,
): ProfileTemplatePackage {
  return verifySignedPackage(parseSignedPackage(text), index, pins, currentVersion);
}

async function assertSourceUnchanged(paths: TapPaths, expected: Awaited<ReturnType<typeof readTapState>>["taps"][string]): Promise<void> {
  const current = (await readTapState(paths)).taps[expected.name];
  if (!current || canonicalDigest(current) !== canonicalDigest(expected)) {
    throw new Error("tap state changed while verifying the package; retry");
  }
}

/** Derive the immutable package endpoint from the signed digest only. */
export function packageUrl(indexUrl: string, digest: string): string {
  const hex = sha256DigestHex(digest);
  return new URL(`packages/sha256/${hex}.json`, new URL(".", indexUrl)).toString();
}

function strictUtf8(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("signed package is not valid UTF-8");
  }
}
