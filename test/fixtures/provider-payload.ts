/**
 * @file Generic unsigned capability-provider payload fixtures. Tests share the
 * compiler's canonical digest and exercise its package installer without any
 * dependency on standalone product hosts.
 */

import { createHash } from "node:crypto";
import { canonicalDigest } from "../../src/profile/templates/signing/canonical.js";

/** One declared artifact output of a provider capability. */
export interface ProviderArtifactOutputV1 {
  readonly outputId: string;
  readonly required: boolean;
  readonly mediaTypes: readonly string[];
  readonly maximumFiles: number;
  readonly maximumBytes: number;
}

/** The identity a pack names a provider by. */
export interface ProviderIdentityV1 {
  readonly providerId: string;
  readonly coordinate: string;
}

/** The platform artifact record one payload carries for THIS host platform. */
export interface ProviderArtifactV1 {
  readonly artifactId: string;
  readonly os: string;
  readonly architecture: string;
  readonly artifactDigest: string;
  readonly archiveFormat: "tar";
  readonly archiveByteCount: number;
  readonly expandedTreeDigest: string;
  readonly expandedByteCount: number;
  readonly entryCount: number;
  readonly entrypointRelativePath: string;
}

/** The archive, its platform artifact record, and the payload the platform installs. */
export interface ProviderPayloadV1 {
  readonly archive: Buffer;
  readonly artifact: ProviderArtifactV1;
  readonly payload: Record<string, unknown>;
}

/** The small, uniform resource bounds every fixture provider declares. */
const FIXTURE_BOUNDS = {
  structuredInputBytes: 1024, materializedInputFiles: 8, materializedInputBytes: 4096,
  scratchFiles: 8, scratchBytes: 4096, outputFiles: 8, outputBytes: 4096,
  custodyScanBytes: 8192, custodyWallTimeMs: 1000, protocolFrames: 64,
  protocolBytes: 8192, brokerRequests: 0, mutatingEffects: 0, wallTimeMs: 1000,
  cpuTimeMs: 1000, memoryBytes: 16 * 1024 * 1024, processCount: 1,
};

const TAR_BLOCK = 512;

function digestBytes(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** A minimal ustar archive of the given entries (the platform's expected framing). */
export function tarArchive(entries: Array<{ name: string; body?: Buffer | string; type?: string }>): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const body = Buffer.isBuffer(entry.body) ? entry.body : Buffer.from(entry.body ?? "");
    const header = Buffer.alloc(TAR_BLOCK);
    header.write(entry.name, 0, 100, "utf8");
    header.write("0000600\0", 100, 8, "ascii");
    header.write("0000000\0", 108, 8, "ascii");
    header.write("0000000\0", 116, 8, "ascii");
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
    header.write("00000000000\0", 136, 12, "ascii");
    header.fill(0x20, 148, 156);
    header.write(entry.type ?? "0", 156, 1, "ascii");
    header.write("ustar\0", 257, 6, "ascii");
    const checksum = [...header].reduce((sum, value) => sum + value, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    chunks.push(header, body, Buffer.alloc((TAR_BLOCK - body.length % TAR_BLOCK) % TAR_BLOCK));
  }
  return Buffer.concat([...chunks, Buffer.alloc(TAR_BLOCK * 2)]);
}

function providerManifest(artifact: ProviderArtifactV1, artifactOutputs: readonly ProviderArtifactOutputV1[], providerId: string): Record<string, unknown> {
  const schema = { type: "object", properties: {}, additionalProperties: false };
  return {
    schemaVersion: 1, providerId, providerVersion: "1.0.0",
    protocolVersions: ["provider-framing-v1"], isolationClass: "host-brokered-process-v1",
    capabilities: [{
      capabilityId: "discover", contractVersion: "discover-v1", summary: "Discover sources",
      inputSchema: schema, outputSchema: schema, brokerRequirements: [], artifactOutputs,
      defaultBounds: FIXTURE_BOUNDS, hardMaximums: FIXTURE_BOUNDS, supportsCheckpoint: false,
      supportsCooperativeCancel: false,
    }],
    platformArtifacts: [{
      artifactId: artifact.artifactId, os: artifact.os, architecture: artifact.architecture,
      artifactDigest: artifact.artifactDigest,
    }],
  };
}

/**
 * Package `files` (archive-relative names such as `package/bin/provider`) as one
 * provider payload for THIS platform, declaring `artifactOutputs` under `identity`.
 */
export function buildProviderPayload(
  files: Record<string, Buffer | string>, artifactOutputs: readonly ProviderArtifactOutputV1[], identity: ProviderIdentityV1,
): ProviderPayloadV1 {
  const archive = tarArchive(Object.entries(files).map(([name, body]) => ({ name, body })));
  const treeFiles = Object.entries(files).map(([name, body]) => ({
    path: name.split("/").slice(1).join("/"),
    digest: digestBytes(Buffer.isBuffer(body) ? body : Buffer.from(body)),
    byteCount: Buffer.byteLength(body),
  })).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const artifact: ProviderArtifactV1 = {
    artifactId: "darwin-arm64", os: process.platform, architecture: process.arch,
    artifactDigest: digestBytes(archive), archiveFormat: "tar",
    archiveByteCount: archive.length, expandedTreeDigest: canonicalDigest(treeFiles),
    expandedByteCount: treeFiles.reduce((sum, item) => sum + item.byteCount, 0),
    entryCount: treeFiles.length, entrypointRelativePath: "bin/provider",
  };
  const manifest = providerManifest(artifact, artifactOutputs, identity.providerId);
  const payload = {
    schemaVersion: 1, packageKind: "capability-provider", providerId: identity.providerId,
    providerVersion: "1.0.0", publisher: "atomicstrata", minLlmwikiVersion: "1.0.0",
    manifest, artifacts: [artifact],
  };
  return { archive, artifact, payload };
}
