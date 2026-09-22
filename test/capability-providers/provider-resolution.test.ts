/**
 * @file test/capability-providers/provider-resolution.test.ts
 * @description Exact-pin resolver tests for Task 4. These assert the public
 * result never leaks host storage or executable paths.
 */
import path from "node:path";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalDigest } from "../../src/profile/templates/signing/canonical.js";
import { writeIndexCache } from "../../src/profile/templates/taps/cache.js";
import { parseCapabilityId, parseSha256Digest } from "../../src/capability-providers/ids.js";
import { snapshotProviderPin } from "../../src/capability-providers/packages/pin-snapshot.js";
import { consumeProviderEntrypointToken, listProviderCapabilities, resolveProviderPin } from "../../src/capability-providers/packages/resolve.js";
import { readProviderSourcesState, writeProviderSourcesState } from "../../src/capability-providers/packages/state-store.js";
import {
  installForeignArtifactFixture, installHostIncompatibleLocalFixture, installIndependentLocalFixture,
  installResolutionFixture, removeResolutionFixture, type ResolutionFixture,
} from "./resolution-fixture.js";
import { providerIndex } from "../fixtures/capability-provider-package.js";

const fixtures: ResolutionFixture[] = [];
afterEach(async () => Promise.all(fixtures.splice(0).map(removeResolutionFixture)));

describe("provider exact resolution", () => {
  it("resolves one complete installed pin to a single-use opaque token", async () => {
    const fixture = await trackedFixture();
    const resolution = await resolveProviderPin(fixture.pin, fixture.context);
    expect(resolution.kind).toBe("resolved");
    if (resolution.kind !== "resolved") return;
    expect(() => JSON.stringify(resolution)).toThrow(/serializ/i);
    expect(() => JSON.stringify(resolution.entrypointToken)).toThrow(/serializ/i);
    expect(consumeProviderEntrypointToken(resolution.entrypointToken).entrypointRelativePath).toBe("bin/provider");
    expect(() => consumeProviderEntrypointToken(resolution.entrypointToken)).toThrow(/expired|used/i);
  });

  it("returns the first integrity refusal without exposing cache paths", async () => {
    const fixture = await trackedFixture();
    const treeLeaf = path.join(fixture.paths.packagesRoot, fixture.pin.packageDigest.slice(7), "tree", "bin/provider");
    await chmod(path.dirname(treeLeaf), 0o700); await chmod(treeLeaf, 0o600); await writeFile(treeLeaf, "replaced");
    const resolution = await resolveProviderPin(fixture.pin, fixture.context);
    expect(resolution).toMatchObject({ kind: "unavailable", code: "provider-package-integrity-invalid" });
    if (resolution.kind === "unavailable") expect(resolution.detail).not.toContain(fixture.paths.cacheRoot);
  });

  it("rechecks signed package evidence before accepting installed bytes", async () => {
    const fixture = await trackedFixture();
    const evidence = path.join(fixture.paths.packagesRoot, fixture.pin.packageDigest.slice(7), "package.json");
    await chmod(path.dirname(evidence), 0o700); await chmod(evidence, 0o600); await writeFile(evidence, "{}\n");
    await expect(resolveProviderPin(fixture.pin, fixture.context)).resolves.toMatchObject({
      kind: "unavailable", code: "provider-package-integrity-invalid",
    });
  });

  it("classifies an invalid retained publisher signature before later checks", async () => {
    const fixture = await trackedFixture();
    const evidence = path.join(fixture.paths.packagesRoot, fixture.pin.packageDigest.slice(7), "package.json");
    await replacePublisherSignature(evidence);
    const unknownCapability = { ...fixture.pin, capabilityId: parseCapabilityId("unknown") };
    const result = await resolveProviderPin(unknownCapability, { ...fixture.context, protocolVersions: [] });
    expect(result).toMatchObject({ kind: "unavailable", code: "provider-signature-invalid" });
    if (result.kind === "unavailable") expect(result.detail).not.toContain(fixture.paths.cacheRoot);
  });

  it("keeps exact pin refusals ordered before capability lookup", async () => {
    const fixture = await trackedFixture();
    const missing = { ...fixture.pin, packageDigest: parseSha256Digest(`sha256:${"0".repeat(64)}`) };
    const unknownCapability = { ...fixture.pin, capabilityId: parseCapabilityId("unknown") };
    const listed = await listProviderCapabilities({ pins: [missing, unknownCapability], context: fixture.context });
    expect(listed.resolutions).toMatchObject([
      { kind: "unavailable", code: "provider-not-installed" },
      { kind: "unavailable", code: "provider-package-integrity-invalid" },
    ]);
  });

  it("refuses protocol mismatch before an absent isolation backend", async () => {
    const fixture = await trackedFixture();
    const result = await resolveProviderPin(fixture.pin, { ...fixture.context, protocolVersions: [], isolationBackends: [] });
    expect(result).toMatchObject({ kind: "unavailable", code: "provider-protocol-incompatible" });
  });

  it("checks compatibility before capability lookup", async () => {
    const fixture = await trackedFixture();
    const unknownCapability = { ...fixture.pin, capabilityId: parseCapabilityId("unknown") };
    const result = await resolveProviderPin(unknownCapability, {
      ...fixture.context, protocolVersions: [], isolationBackends: [],
    });
    expect(result).toMatchObject({ kind: "unavailable", code: "provider-protocol-incompatible" });
  });

  it("checks immutable bytes before local execution disposition", async () => {
    const fixture = await trackedFixture();
    const localPin = await installIndependentLocalFixture(fixture);
    const treeLeaf = path.join(fixture.paths.packagesRoot, localPin.packageDigest.slice(7), "tree", "bin/provider");
    await chmod(path.dirname(treeLeaf), 0o700); await chmod(treeLeaf, 0o600);
    await writeFile(treeLeaf, "replaced");
    const result = await resolveProviderPin(localPin, fixture.context);
    expect(result).toMatchObject({ kind: "unavailable", code: "provider-package-integrity-invalid" });
  });

  it("refuses current signed authority that no longer pins the recorded coordinate", async () => {
    const fixture = await trackedFixture();
    await replaceCurrentCoordinateDigest(fixture);
    const unknownCapability = { ...fixture.pin, capabilityId: parseCapabilityId("unknown") };
    await expect(resolveProviderPin(unknownCapability, fixture.context)).resolves.toMatchObject({
      kind: "unavailable", code: "provider-package-integrity-invalid",
    });
  });

  it("refuses an installed pin whose immutable package bytes are absent", async () => {
    const fixture = await trackedFixture();
    const packageRoot = path.join(fixture.paths.packagesRoot, fixture.pin.packageDigest.slice(7));
    await rename(packageRoot, `${packageRoot}.missing`);
    const unknownCapability = { ...fixture.pin, capabilityId: parseCapabilityId("unknown") };
    await expect(resolveProviderPin(unknownCapability, fixture.context)).resolves.toMatchObject({
      kind: "unavailable", code: "provider-package-missing",
    });
  });

  it("refuses incompatible host contracts before a capability lookup", async () => {
    const fixture = await trackedFixture();
    const pin = await installHostIncompatibleLocalFixture(fixture);
    const unknownCapability = { ...pin, capabilityId: parseCapabilityId("unknown") };
    await expect(resolveProviderPin(unknownCapability, fixture.context)).resolves.toMatchObject({
      kind: "unavailable", code: "provider-host-incompatible",
    });
  });

  it("refuses an unapproved local package after all prior package checks", async () => {
    const fixture = await trackedFixture();
    const pin = await installIndependentLocalFixture(fixture);
    await expect(resolveProviderPin(pin, fixture.context)).resolves.toMatchObject({
      kind: "unavailable", code: "provider-local-unverified",
    });
  });

  it("snapshots the caller pin before asynchronous resolution", async () => {
    const fixture = await trackedFixture();
    const mutablePin = { ...fixture.pin };
    const expectedCapabilityId = mutablePin.capabilityId;
    const pending = resolveProviderPin(mutablePin, fixture.context);
    mutablePin.capabilityId = parseCapabilityId("changed-after-call");
    const result = await pending;
    expect(result.pin).not.toBe(mutablePin);
    expect(result.pin.capabilityId).toBe(expectedCapabilityId);
    expect(Object.isFrozen(result.pin)).toBe(true);
  });

  it("rejects malformed runtime pin objects without executing accessors", async () => {
    const fixture = await trackedFixture();
    const accessorPin = { ...fixture.pin } as Record<string, unknown>;
    Object.defineProperty(accessorPin, "coordinate", {
      enumerable: true,
      get: () => { throw new Error("accessor must not execute"); },
    });
    const cases = [
      { ...fixture.pin, unexpected: true },
      Object.assign(Object.create({ inherited: true }), fixture.pin),
      accessorPin,
      new Proxy({ ...fixture.pin }, { get: () => { throw new Error("proxy must not execute"); } }),
    ];
    for (const pin of cases) {
      await expect(resolveProviderPin(pin as never, fixture.context)).rejects.toThrow(
        "provider integrity verification failed",
      );
    }
  });

  it("rejects an object-valued known field at the synchronous snapshot boundary", async () => {
    const fixture = await trackedFixture();
    const callerOwnedCoordinate = { value: fixture.pin.coordinate };
    const pin = { ...fixture.pin, coordinate: callerOwnedCoordinate };
    let snapshot: object | undefined;
    expect(() => { snapshot = snapshotProviderPin(pin as never); }).toThrow(
      "provider integrity verification failed",
    );
    expect(snapshot).toBeUndefined();
  });

  it("checks compatibility against the exact recorded artifact", async () => {
    const fixture = await trackedFixture();
    const foreignPin = await installForeignArtifactFixture(fixture);
    const result = await resolveProviderPin(foreignPin, fixture.context);
    expect(result).toMatchObject({ kind: "unavailable", code: "provider-platform-incompatible" });
  });

  it("refuses an absent accepted backend after protocol compatibility succeeds", async () => {
    const fixture = await trackedFixture();
    const result = await resolveProviderPin(fixture.pin, { ...fixture.context, isolationBackends: [] });
    expect(result).toMatchObject({ kind: "unavailable", code: "provider-isolation-unavailable" });
  });
});

/** Create and retain one fixture for deterministic asynchronous cleanup. */
async function trackedFixture(): Promise<ResolutionFixture> {
  const fixture = await installResolutionFixture();
  fixtures.push(fixture);
  return fixture;
}

/** Replace accepted test continuity with a valid index that omits the installed digest. */
async function replaceCurrentCoordinateDigest(fixture: ResolutionFixture): Promise<void> {
  const index = providerIndex(`sha256:${"0".repeat(64)}`);
  const sources = await readProviderSourcesState(fixture.paths);
  const source = sources.sources.official;
  if (!source) throw new Error("official provider source is missing");
  await writeIndexCache(tapPaths(fixture), "official", index.sequence, JSON.stringify(index));
  await writeProviderSourcesState(fixture.paths, {
    schemaVersion: 1,
    sources: { official: { ...source, acceptedIndexDigest: canonicalDigest(index), publisherPins: {
      ...source.publisherPins, coordinates: { ...source.publisherPins.coordinates, [fixture.pin.coordinate]: index.packages[0]!.payloadDigest },
    } } },
  });
}

/** Adapt Task 3-authorized roots to the TAP evidence cache interface. */
function tapPaths(fixture: ResolutionFixture) {
  return {
    configRoot: fixture.paths.configRoot, cacheRoot: fixture.paths.providerCacheRoot,
    stateFile: fixture.paths.sourcesFile, lockFile: fixture.paths.lockFile,
  };
}

/** Replace only the signed-envelope signature while retaining valid payload bytes. */
async function replacePublisherSignature(evidence: string): Promise<void> {
  const envelope = JSON.parse(await readFile(evidence, "utf8")) as Record<string, unknown>;
  const signature = envelope.publisherSignature as Record<string, unknown>;
  signature.value = Buffer.alloc(64).toString("base64");
  await chmod(path.dirname(evidence), 0o700); await chmod(evidence, 0o600);
  await writeFile(evidence, `${JSON.stringify(envelope)}\n`);
}
