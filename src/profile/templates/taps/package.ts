/**
 * @file src/profile/templates/taps/package.ts
 * @description Content-addressed package retrieval with full cached-byte re-verification.
 */
import { TextDecoder } from "node:util";
import packageJson from "../../../../package.json" with { type: "json" };
import { confinedFetch, type ConfinedFetchSeams } from "../../../connectors/confined-fetch.js";
import type { ProfileTemplatePackage } from "../types.js";
import { parseSignedPackage, parseTemplateCoordinate } from "../signing/protocol.js";
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
  const evidence = await packageEvidence(paths, source.indexUrl, source.origin, entry.payloadDigest, options);
  const pkg = verifySignedPackage(parseSignedPackage(evidence.text), index, source.publisherPins, options.currentVersion ?? packageJson.version);
  await assertSourceUnchanged(paths, source);
  if (!evidence.cached) await writePackageCache(paths, entry.payloadDigest, evidence.text);
  return {
    package: pkg,
    coordinate,
    payloadDigest: entry.payloadDigest,
    publisherKeyId: index.publishers[entry.publisher].keyId,
    tapSequence: index.sequence,
    indexExpired: Date.parse(index.expiresAt) <= Date.now(),
  };
}

async function packageEvidence(
  paths: TapPaths,
  indexUrl: string,
  origin: string,
  digest: string,
  options: ResolveRemoteOptions,
): Promise<{ text: string; cached: boolean }> {
  const cached = await readPackageCache(paths, digest);
  if (cached !== null) return { text: cached, cached: true };
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

async function assertSourceUnchanged(paths: TapPaths, expected: Awaited<ReturnType<typeof readTapState>>["taps"][string]): Promise<void> {
  const current = (await readTapState(paths)).taps[expected.name];
  if (!current || canonicalDigest(current) !== canonicalDigest(expected)) {
    throw new Error("tap state changed while verifying the package; retry");
  }
}

/** Derive the immutable package endpoint from the signed digest only. */
export function packageUrl(indexUrl: string, digest: string): string {
  const hex = /^sha256:([0-9a-f]{64})$/.exec(digest)?.[1];
  if (!hex) throw new Error("package digest is invalid");
  return new URL(`packages/sha256/${hex}.json`, new URL(".", indexUrl)).toString();
}

function strictUtf8(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("signed package is not valid UTF-8");
  }
}
