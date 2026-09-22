/**
 * @file test/capability-providers/resolution-fixture.ts
 * @description Shared Task 4 installation fixture helpers. They create
 * immutable package state through Task 3's public installation path so
 * resolver tests do not forge authoritative records or cache trees.
 */
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { canonicalDigest } from "../../src/profile/templates/signing/canonical.js";
import { parseBackendId, parseCapabilityContractVersion, parseCapabilityId, parseProviderCoordinate, parseProviderId, parseSemanticVersion, parseSha256Digest } from "../../src/capability-providers/ids.js";
import {
  approveLocalProviderExecution, installLocalProvider,
} from "../../src/capability-providers/packages/local-install.js";
import { authorizeProviderPathsForTest } from "../../src/capability-providers/packages/paths.js";
import { addProviderSource, installRemoteProvider, refreshProviderSource } from "../../src/capability-providers/packages/remote-install.js";
import {
  readProviderInstallState, withProviderStateLock, writeProviderInstallState,
} from "../../src/capability-providers/packages/state-store.js";
import type { ProviderPinV1 } from "../../src/capability-providers/types.js";
import { derivePinForPayload } from "../../src/capability-providers/packages/pin.js";
import type { ProviderResolutionContextV1 } from "../../src/capability-providers/packages/resolve.js";
import { COORDINATE, TAP, distributionSeams, providerDistribution, removeProviderFixtureRoot } from "../fixtures/capability-provider-package.js";

/** A signed installed package, exact pin, and host resolution context. */
export interface ResolutionFixture {
  readonly paths: Awaited<ReturnType<typeof authorizeProviderPathsForTest>>;
  readonly pin: ProviderPinV1;
  readonly context: ProviderResolutionContextV1;
  readonly root: string;
}

/** Install the signed fixture through Task 3 and derive its complete exact pin. */
export async function installResolutionFixture(
  nowForTest = () => new Date("2026-07-17T12:00:00Z"),
): Promise<ResolutionFixture> {
  const fixture = providerDistribution();
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "llmwiki-provider-resolution-")));
  const paths = await providerPaths(root, nowForTest);
  await addProviderSource(paths, { name: "official", indexUrl: "https://tap.example/index.json", trustedKey: TAP.publicKey });
  await refreshProviderSource(paths, "official", { seams: distributionSeams(fixture) });
  await installRemoteProvider(paths, {
    coordinate: COORDINATE, confirmedPackageDigest: String(fixture.envelope.payloadDigest),
    confirmedIndexDigest: canonicalDigest(fixture.index), seams: distributionSeams(fixture),
  });
  return { paths, root, pin: pinForFixture(fixture), context: hostContext(paths) };
}

/** Install a second local-development release with independent exact identity. */
export async function installIndependentLocalFixture(
  fixture: ResolutionFixture,
): Promise<ProviderPinV1> {
  return installLocalFixture(fixture, { directory: "local-provider", version: "1.0.1" });
}

/** Install an approved local package whose declared host floor is deliberately too new. */
export async function installHostIncompatibleLocalFixture(
  fixture: ResolutionFixture,
): Promise<ProviderPinV1> {
  return installLocalFixture(fixture, {
    directory: "host-incompatible-provider", version: "1.0.3", minLlmwikiVersion: "9999.0.0", approved: true,
  });
}

interface LocalFixtureOptions {
  readonly directory: string;
  readonly version: string;
  readonly minLlmwikiVersion?: string;
  readonly approved?: boolean;
}

interface LocalFixtureMaterial {
  readonly sourceRoot: string;
  readonly payload: Record<string, unknown>;
  readonly manifest: Record<string, unknown>;
}

/** Install one local fixture variant with an exact distinct version and optional approval. */
async function installLocalFixture(fixture: ResolutionFixture, options: LocalFixtureOptions): Promise<ProviderPinV1> {
  const { sourceRoot, payload } = await localFixtureMaterial(fixture, options.directory, options.version);
  if (options.minLlmwikiVersion) payload.minLlmwikiVersion = options.minLlmwikiVersion;
  const packageDigest = canonicalDigest(payload);
  await installLocalProvider(fixture.paths, { sourceRoot, payload, confirmedPackageDigest: packageDigest });
  if (options.approved) await approveLocalProviderExecution(fixture.paths, { packageDigest, confirmed: true });
  return pinForPayload(payload, `local/atomicstrata/research@${options.version}`, packageDigest);
}

/** Install a local package whose recorded artifact belongs to another platform. */
export async function installForeignArtifactFixture(
  fixture: ResolutionFixture,
): Promise<ProviderPinV1> {
  const { sourceRoot, payload, manifest } = await localFixtureMaterial(fixture, "foreign-provider", "1.0.2");
  const artifacts = payload.artifacts as Array<Record<string, unknown>>;
  const host = artifacts.find((item) => item.os === process.platform && item.architecture === process.arch);
  if (!host) throw new Error("fixture has no host artifact");
  const foreign: Record<string, unknown> = { ...host, artifactId: "foreign-artifact", os: "foreign-os", architecture: "foreign-arch" };
  artifacts.push(foreign);
  (manifest.platformArtifacts as Array<Record<string, unknown>>).push({
    artifactId: foreign.artifactId, os: foreign.os, architecture: foreign.architecture,
    artifactDigest: foreign.artifactDigest,
  });
  const packageDigest = canonicalDigest(payload);
  await installLocalProvider(fixture.paths, { sourceRoot, payload, confirmedPackageDigest: packageDigest });
  await recordForeignArtifact(fixture, packageDigest, foreign);
  await approveLocalProviderExecution(fixture.paths, { packageDigest, confirmed: true });
  return pinForPayload(payload, "local/atomicstrata/research@1.0.2", packageDigest);
}

/**
 * An uninstalled local tree and payload, for a suite that drives the INSTALL
 * itself rather than consuming an already-installed one.
 */
export function devInstallMaterial(
  fixture: ResolutionFixture, directory: string, version: string,
): Promise<LocalFixtureMaterial> {
  return localFixtureMaterial(fixture, directory, version);
}

/** Create an uninstalled local tree and matching mutable payload fixture. */
async function localFixtureMaterial(
  fixture: ResolutionFixture,
  directory: string,
  version: string,
): Promise<LocalFixtureMaterial> {
  const sourceRoot = path.join(fixture.root, directory);
  await mkdir(path.join(sourceRoot, "bin"), { recursive: true });
  await writeFile(path.join(sourceRoot, "bin", "provider"), "provider-bytes");
  const payload = structuredClone(providerDistribution().payload) as Record<string, unknown>;
  const manifest = payload.manifest as Record<string, unknown>;
  payload.providerVersion = version;
  manifest.providerVersion = version;
  return { sourceRoot, payload, manifest };
}

/** Rebind test-authorized installed state to the package's foreign artifact. */
async function recordForeignArtifact(
  fixture: ResolutionFixture,
  packageDigest: string,
  artifact: Record<string, unknown>,
): Promise<void> {
  await withProviderStateLock(fixture.paths, async () => {
    const state = await readProviderInstallState(fixture.paths);
    const record = state.installs[packageDigest];
    if (!record) throw new Error("fixture install record is missing");
    await writeProviderInstallState(fixture.paths, {
      schemaVersion: 1,
      installs: { ...state.installs, [packageDigest]: {
        ...record, artifactId: String(artifact.artifactId),
        artifactDigest: parseSha256Digest(artifact.artifactDigest),
        expandedTreeDigest: parseSha256Digest(artifact.expandedTreeDigest),
      } },
      localApprovals: state.localApprovals,
    });
  });
}

/** Delete the fixture root after a test, thawing immutable package directories first. */
export async function removeResolutionFixture(fixture: ResolutionFixture): Promise<void> {
  await removeProviderFixtureRoot(fixture.root);
}

/** Construct the Task 4 host compatibility descriptor for this process. */
function hostContext(paths: ResolutionFixture["paths"]): ProviderResolutionContextV1 {
  return {
    paths, protocolVersions: ["provider-framing-v1"],
    isolationBackends: [{ backendId: parseBackendId("test-backend"), os: process.platform, architecture: process.arch }],
  };
}

/** Derive a complete pin from the signed fixture rather than hard-coding digests. */
function pinForFixture(fixture: ReturnType<typeof providerDistribution>): ProviderPinV1 {
  return pinForPayload(fixture.payload, COORDINATE, String(fixture.envelope.payloadDigest));
}

/** Derive one exact pin, through the SINGLE derivation the dev installer owns. */
function pinForPayload(payload: Record<string, unknown>, coordinateText: string, packageDigest: string): ProviderPinV1 {
  return derivePinForPayload(payload, coordinateText, packageDigest);
}

/** Create isolated config/cache roots authorized through the Task 3 seam. */
async function providerPaths(root: string, nowForTest: () => Date) {
  // This mirrors the existing Task 3 test root setup while keeping Task 4 fixtures self-contained.
  // fallow-ignore-next-line code-duplication
  await mkdir(path.join(root, "config"), { mode: 0o700 });
  await mkdir(path.join(root, "cache"), { mode: 0o700 });
  return authorizeProviderPathsForTest({
    configRoot: path.join(root, "config"), cacheRoot: path.join(root, "cache"), nowForTest,
  });
}
