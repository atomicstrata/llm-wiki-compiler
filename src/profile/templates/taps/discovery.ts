/**
 * @file src/profile/templates/taps/discovery.ts
 * @description Read-only search and inspect DTOs over accepted signed tap evidence.
 */
import { deriveTemplateCapabilities } from "../capabilities.js";
import { parseTemplateCoordinate } from "../signing/protocol.js";
import { loadAcceptedIndex } from "./evidence.js";
import { resolveRemotePackage } from "./package.js";
import type { TapPaths } from "./paths.js";
import { readTapState } from "./state-store.js";

/** Index-only search result; no package body or raw key is exposed. */
export interface RemoteTemplateSearchResult {
  coordinate: string;
  tap: string;
  publisher: string;
  templateId: string;
  version: string;
  payloadDigest: string;
  sequence: number;
  stale: boolean;
}

/** Verified package metadata safe for CLI JSON and human output. */
export interface RemoteTemplateDetails extends RemoteTemplateSearchResult {
  displayName: string;
  license: string;
  minLlmwikiVersion: string;
  publisherKeyId: string;
  capabilities: ReturnType<typeof deriveTemplateCapabilities>;
}

/** Search only already accepted index coordinates, never package bodies. */
export async function searchRemoteTemplates(paths: TapPaths, query: string, tap?: string): Promise<RemoteTemplateSearchResult[]> {
  const state = await readTapState(paths);
  if (tap && !state.taps[tap]) throw new Error(`unknown template tap: ${tap}`);
  if (tap && !state.taps[tap].enabled) throw new Error(`template tap is disabled: ${tap}`);
  const sources = Object.values(state.taps).filter((source) => source.enabled && (!tap || source.name === tap));
  const groups = await Promise.all(sources.map(async (source) => {
    const index = await loadAcceptedIndex(paths, source);
    return index.packages
      .filter((entry) => evidenceIsActive(source, entry.publisher, entry.payloadDigest))
      .map((entry) => searchResult(entry.coordinate, entry.payloadDigest, index.sequence, index.expiresAt));
  }));
  const needle = query.trim().toLowerCase();
  return groups.flat().filter((item) => searchable(item).includes(needle)).sort((a, b) => a.coordinate.localeCompare(b.coordinate));
}

function evidenceIsActive(source: Awaited<ReturnType<typeof readTapState>>["taps"][string], publisher: string, digest: string): boolean {
  const keyId = source.publisherPins.publishers[publisher]?.keyId;
  return !source.publisherPins.revokedPackages.includes(digest)
    && keyId !== undefined
    && !source.publisherPins.revokedPublisherKeys.includes(keyId);
}

/** Fetch or reuse and verify one qualified remote package for display. */
export async function inspectRemoteTemplate(paths: TapPaths, coordinate: string): Promise<RemoteTemplateDetails> {
  const resolved = await resolveRemotePackage(paths, coordinate);
  const parsed = parseTemplateCoordinate(coordinate);
  return {
    coordinate,
    tap: parsed.tap,
    publisher: parsed.publisher,
    templateId: parsed.templateId,
    version: parsed.version,
    payloadDigest: resolved.payloadDigest,
    sequence: resolved.tapSequence,
    stale: resolved.indexExpired,
    displayName: resolved.package.displayName,
    license: resolved.package.license,
    minLlmwikiVersion: resolved.package.minLlmwikiVersion,
    publisherKeyId: resolved.publisherKeyId,
    capabilities: deriveTemplateCapabilities(resolved.package.profile),
  };
}

function searchResult(coordinate: string, payloadDigest: string, sequence: number, expiresAt: string): RemoteTemplateSearchResult {
  const parsed = parseTemplateCoordinate(coordinate);
  return { coordinate, ...parsed, payloadDigest, sequence, stale: Date.parse(expiresAt) <= Date.now() };
}

function searchable(result: RemoteTemplateSearchResult): string {
  return `${result.coordinate} ${result.tap} ${result.publisher} ${result.templateId}`.toLowerCase();
}
