/**
 * @file test/fixtures/capability-provider-package.ts
 * @description Isolated signed provider envelope, TAP index, and tiny tar
 * fixtures for Provider V2 package tests. These bytes never execute.
 */
import { createHash } from "node:crypto";
import { buildProviderPayload, tarArchive, type ProviderArtifactV1 } from "./provider-payload.js";
export { tarArchive };
import { Readable } from "node:stream";
import { chmod, lstat, readdir, rm } from "node:fs/promises";
import type { ConfinedFetchSeams } from "../../src/connectors/confined-fetch.js";
import { canonicalDigest, packageClaim, rotationClaim } from "../../src/profile/templates/signing/canonical.js";
import { generateEd25519Keypair, signClaim } from "../../src/profile/templates/signing/sign.js";
import type { SignedTapIndex } from "../../src/profile/templates/signing/types.js";

export const TAP = generateEd25519Keypair("provider-tap-1");
export const PUBLISHER = generateEd25519Keypair("provider-publisher-1");
export const PUBLISHER_2 = generateEd25519Keypair("provider-publisher-2");
export const COORDINATE = "official/atomicstrata/research@1.0.0";


export interface ProviderDistributionFixture {
  readonly archive: Buffer;
  readonly artifact: ProviderArtifactV1;
  readonly payload: Record<string, unknown>;
  readonly envelope: Record<string, unknown>;
  readonly index: SignedTapIndex;
}

/** Build one internally consistent signed provider distribution fixture. */
export interface ProviderIdentityV1 {
  readonly providerId: string;
  readonly coordinate: string;
}

/** The default fixture identity; overriding yields a DISTINCT logical provider. */
const DEFAULT_IDENTITY: ProviderIdentityV1 = { providerId: "research", coordinate: COORDINATE };

export function providerDistribution(
  files: Record<string, Buffer | string> = { "package/bin/provider": "provider-bytes" },
  artifactOutputs: readonly FixtureArtifactOutputV1[] = [],
  identity: ProviderIdentityV1 = DEFAULT_IDENTITY,
): ProviderDistributionFixture {
  // The generic payload builder supplies the archive and manifest; this fixture
  // adds the signed tap envelope and index required for remote resolution.
  const { archive, artifact, payload } = buildProviderPayload(files, artifactOutputs, identity);
  const payloadDigest = canonicalDigest(payload);
  const envelope = {
    schemaVersion: 1, coordinate: identity.coordinate, payload, payloadDigest,
    publisherSignature: signClaim(packageClaim(identity.coordinate, payloadDigest), PUBLISHER.privateKey),
  };
  return { archive, artifact, payload, envelope, index: providerIndex(payloadDigest, {}, identity.coordinate) };
}

export function payloadWithDuplicateHostArtifact(
  fixture: ProviderDistributionFixture,
): Record<string, unknown> {
  const payload = structuredClone(fixture.payload);
  const artifacts = payload.artifacts as ProviderArtifactV1[];
  const alternate: ProviderArtifactV1 = { ...artifacts[0]!, artifactId: `${artifacts[0]!.artifactId}-alternate` };
  artifacts.push(alternate);
  const manifest = payload.manifest as { platformArtifacts: Array<Record<string, unknown>> };
  manifest.platformArtifacts.push({
    artifactId: alternate.artifactId, os: alternate.os,
    architecture: alternate.architecture, artifactDigest: alternate.artifactDigest,
  });
  return payload;
}

/** One valid signed HTTPS broker requirement that tightens its host maxima. */
export const RESEARCH_BROKER_REQUIREMENT = Object.freeze({
  brokerId: "https", brokerContractVersion: "1.0.0", operations: ["fetch-sources"],
  effectClass: "read", access: "read-only", requiredCredentialSlots: ["api-token"],
  exposedInputKinds: ["retained-source"],
  targetConstraints: { allowedOrigins: ["https://api.example.test"] },
  maximums: { httpsTransferBytes: 1024 },
});

/** Clone the signed payload and declare exact capability broker requirements. */
export function payloadWithBrokerRequirements(
  fixture: ProviderDistributionFixture,
  requirements: readonly Record<string, unknown>[],
): Record<string, unknown> {
  const payload = structuredClone(fixture.payload);
  const manifest = payload.manifest as { capabilities: Array<Record<string, unknown>> };
  manifest.capabilities[0].brokerRequirements = requirements.map((item) => structuredClone(item));
  return payload;
}

/** Rebind an archive's digest and byte count into one artifact declaration. */
export function artifactForArchive(
  fixture: ProviderDistributionFixture,
  archive: Buffer,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { ...fixture.artifact, artifactDigest: digestBytes(archive), archiveByteCount: archive.length, ...overrides };
}

/** Remove read-only package snapshots created by immutability tests. */
export async function removeProviderFixtureRoot(root: string): Promise<void> {
  await thaw(root);
  await rm(root, { recursive: true, force: true });
}

/** Build a signed provider TAP index for one exact payload digest. */
export function providerIndex(
  payloadDigest: string, overrides: Partial<SignedTapIndex> = {}, coordinate: string = COORDINATE,
): SignedTapIndex {
  const unsigned: Omit<SignedTapIndex, "signature"> = {
    schemaVersion: 1, tap: "official", sequence: 1,
    generatedAt: "2026-07-17T00:00:00Z", expiresAt: "2026-07-18T00:00:00Z",
    publishers: { atomicstrata: PUBLISHER.publicKey },
    packages: [{ coordinate, publisher: "atomicstrata", payloadDigest }],
    rotations: [], revocations: [], ...withoutSignature(overrides),
  };
  return { ...unsigned, signature: signClaim(unsigned, TAP.privateKey) };
}

/** Build a provider distribution signed under the rotated publisher key. */
export function rotatedProviderDistribution(): ProviderDistributionFixture {
  const fixture = providerDistribution();
  const payloadDigest = String(fixture.envelope.payloadDigest);
  const envelope = {
    ...fixture.envelope,
    publisherSignature: signClaim(packageClaim(COORDINATE, payloadDigest), PUBLISHER_2.privateKey),
  };
  const index = providerIndex(payloadDigest, {
    sequence: 2, publishers: { atomicstrata: PUBLISHER_2.publicKey },
    rotations: [publisherRotation(2)],
  });
  return { ...fixture, envelope, index };
}

/** Build the dual-signed publisher-key rotation accepted by fixture indexes. */
export function publisherRotation(sequence = 2) {
  const base = {
    publisher: "atomicstrata", fromKeyId: PUBLISHER.publicKey.keyId,
    toKey: PUBLISHER_2.publicKey, effectiveSequence: sequence,
  };
  const claim = rotationClaim("official", base);
  return {
    ...base,
    oldSignature: signClaim(claim, PUBLISHER.privateKey),
    newSignature: signClaim(claim, PUBLISHER_2.privateKey),
  };
}

/** Serve a fixture distribution through confined-fetch test seams. */
export function distributionSeams(fixture: ProviderDistributionFixture): ConfinedFetchSeams {
  return {
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    request: async (request) => {
      const url = String(request.path ?? "");
      const body = url.endsWith("index.json")
        ? Buffer.from(JSON.stringify(fixture.index))
        : url.includes("/artifacts/") ? fixture.archive : Buffer.from(JSON.stringify(fixture.envelope));
      const contentType = url.includes("/artifacts/") ? "application/octet-stream" : "application/json";
      return { statusCode: 200, headers: { "content-type": contentType }, body: Readable.from([body]) };
    },
  };
}

/** Encode regular fixture entries in a minimal USTAR archive. */
/** Encode one stored fixture entry in a minimal ZIP archive. */
export function zipArchive(
  name: string,
  value: Buffer | string,
  externalAttributes = (0o100400 << 16) >>> 0,
): Buffer {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const filename = Buffer.from(name);
  const crc = crc32(body);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(0x0800, 6);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(body.length, 22); local.writeUInt16LE(filename.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x031e, 4);
  central.writeUInt16LE(0x0800, 8); central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(body.length, 20); central.writeUInt32LE(body.length, 24);
  central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(externalAttributes, 38);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + filename.length, 12);
  eocd.writeUInt32LE(local.length + filename.length + body.length, 16);
  return Buffer.concat([local, filename, body, central, filename, eocd]);
}

/** Build central-directory-only ZIP metadata for pre-inflate cap tests. */
export function zipMetadataArchive(
  expandedSizes: readonly number[],
  declaredCount = expandedSizes.length,
): Buffer {
  const central = expandedSizes.map((size, index) => {
    const filename = Buffer.from(`package/file-${index}`);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE(0x031e, 4);
    record.writeUInt16LE(0x0800, 8); record.writeUInt16LE(8, 10);
    record.writeUInt32LE(size, 24); record.writeUInt16LE(filename.length, 28);
    record.writeUInt32LE((0o100400 << 16) >>> 0, 38);
    return Buffer.concat([record, filename]);
  });
  const centralBytes = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(declaredCount, 8); eocd.writeUInt16LE(declaredCount, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  return Buffer.concat([centralBytes, eocd]);
}

/**
 * One artifact-output contract a capability may declare, so a fixture provider
 * can legitimately CLAIM a file. The default stays empty: a capability that
 * declares no outputs is the shape every existing suite pins.
 */
export interface FixtureArtifactOutputV1 {
  readonly outputId: string;
  readonly required: boolean;
  readonly mediaTypes: readonly string[];
  readonly maximumFiles: number;
  readonly maximumBytes: number;
}

function digestBytes(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function thaw(leaf: string): Promise<void> {
  const entry = await lstat(leaf).catch(() => null);
  if (!entry || entry.isSymbolicLink()) return;
  await chmod(leaf, entry.isDirectory() ? 0o700 : 0o600).catch(() => {});
  if (!entry.isDirectory()) return;
  const children = await readdir(leaf);
  await Promise.all(children.map((child) => thaw(`${leaf}/${child}`)));
}

// Fixture construction independently implements the archive checksum oracle.
// fallow-ignore-next-line code-duplication
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function withoutSignature(overrides: Partial<SignedTapIndex>): Partial<Omit<SignedTapIndex, "signature">> {
  const { signature: _signature, ...rest } = overrides;
  return rest;
}
