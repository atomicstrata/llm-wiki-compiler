/**
 * @file test/capability-providers/provider-removal.test.ts
 * @description Reference-aware uninstall and explicit cache-GC planning tests
 * for Task 4. Product/preparation references enter only through typed calls.
 */
import path from "node:path";
import { mkdir, rename, symlink } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_PROVIDER_LOGICAL_ID_SNAPSHOT_ITEMS } from "../../src/capability-providers/constants.js";
import { planProviderCacheGarbageCollection, removeProviderInstallation } from "../../src/capability-providers/packages/remove.js";
import {
  enumerateExternalProviderReferences, withTrustedExternalProviderReferences, type ProviderPackageReferenceV1, type WithLockedExternalProviderReferencesV1,
} from "../../src/capability-providers/packages/reference-enumeration.js";
import { readProviderInstallState } from "../../src/capability-providers/packages/state-store.js";
import { installResolutionFixture, removeResolutionFixture, type ResolutionFixture } from "./resolution-fixture.js";

const fixtures: ResolutionFixture[] = [];
afterEach(async function cleanProviderRemovalFixtures() {
  const pending = fixtures.splice(0);
  await Promise.all(pending.map((fixture) => removeResolutionFixture(fixture)));
});

describe("provider reference-aware removal", () => {
  it("retains an installation when typed product references name its exact digest", async () => {
    const fixture = await trackedFixture();
    const result = await removeProviderInstallation({
      paths: fixture.paths, packageDigest: fixture.pin.packageDigest,
      withLockedExternalReferences: staticReferenceScope([
        { owner: "product", referenceId: "autosci", packageDigest: fixture.pin.packageDigest },
      ]),
    });
    expect(result).toMatchObject({ kind: "retained", references: [{ owner: "product", referenceId: "autosci" }] });
  });

  it("removes only authoritative install state and leaves cache reclamation explicit", async () => {
    const fixture = await trackedFixture();
    await expect(removeProviderInstallation({
      paths: fixture.paths, packageDigest: fixture.pin.packageDigest, withLockedExternalReferences: staticReferenceScope([]),
    })).resolves.toMatchObject({ kind: "removed" });
    await expect(planProviderCacheGarbageCollection({
      paths: fixture.paths, enumerateExternalReferences: async () => [],
    })).resolves.toMatchObject({ candidates: [fixture.pin.packageDigest] });
  });

  it("holds the external reference fence through the provider-state commit", async () => {
    const fixture = await trackedFixture();
    let releaseWriter = () => {};
    const fenceReleased = new Promise<void>((resolve) => { releaseWriter = resolve; });
    let referenceCreated = false;
    let committedUnderFence = false;
    const removal = removeProviderInstallation({
      paths: fixture.paths, packageDigest: fixture.pin.packageDigest,
      withLockedExternalReferences: async (_digest, operation) => {
        try {
          const result = await operation([]);
          const state = await readProviderInstallState(fixture.paths);
          committedUnderFence = state.installs[fixture.pin.packageDigest] === undefined && !referenceCreated;
          return result;
        } finally { releaseWriter(); }
      },
    });
    const writer = fenceReleased.then(() => { referenceCreated = true; });
    await expect(removal).resolves.toMatchObject({ kind: "removed" });
    expect(committedUnderFence).toBe(true);
    await writer;
    expect(referenceCreated).toBe(true);
  });

  it("refuses GC when a planted parent symlink redirects the packages store", async () => {
    const fixture = await trackedFixture();
    await removeInstalledFixture(fixture);
    const packagesParent = path.dirname(fixture.paths.packagesRoot);
    const original = `${packagesParent}-original`;
    const outside = path.join(fixture.root, "outside-packages");
    await rename(packagesParent, original);
    await mkdir(path.join(outside, "sha256"), { recursive: true });
    await symlink(outside, packagesParent, "dir");

    await expect(planProviderCacheGarbageCollection({
      paths: fixture.paths, enumerateExternalReferences: async () => [],
    })).rejects.toThrow(/unavailable|unauthorized/i);
  });

  it("fails closed at the cache enumeration cap without poisoning a later plan", async () => {
    const fixture = await trackedFixture();
    await removeInstalledFixture(fixture);
    await expect(planProviderCacheGarbageCollection({
      paths: fixture.paths, enumerateExternalReferences: async () => [],
      maximumCacheEntriesForTest: 0,
    })).rejects.toThrow(/cap|capacity/i);
    await expect(planProviderCacheGarbageCollection({
      paths: fixture.paths, enumerateExternalReferences: async () => [],
    })).resolves.toMatchObject({ candidates: [fixture.pin.packageDigest] });
  });
});

describe("external provider reference bounds", () => {
  it("rejects an oversized reference snapshot before parsing its records", async () => {
    const fixture = await trackedFixture();
    const reference = externalReference(fixture);
    const oversized = Array.from({ length: MAX_PROVIDER_LOGICAL_ID_SNAPSHOT_ITEMS + 1 }, () => reference);
    await expect(enumerateExternalProviderReferences(
      async () => oversized, fixture.pin.packageDigest,
    )).rejects.toThrow(/unavailable/i);
  });

  it("rejects callback records with unknown fields or inherited authority", async () => {
    const fixture = await trackedFixture();
    const unknown = { ...externalReference(fixture), extra: true };
    const inherited = Object.assign(Object.create({ owner: "product" }), {
      referenceId: "autosci", packageDigest: fixture.pin.packageDigest,
    }) as ProviderPackageReferenceV1;
    await expect(enumerateExternalProviderReferences(async () => [unknown], fixture.pin.packageDigest))
      .rejects.toThrow(/unavailable/i);
    await expect(enumerateExternalProviderReferences(async () => [inherited], fixture.pin.packageDigest))
      .rejects.toThrow(/unavailable/i);
  });

  it("redacts callback failures and rejects proxies without executing traps", async () => {
    const fixture = await trackedFixture();
    await expect(enumerateExternalProviderReferences(
      async () => { throw new Error(`/private/${fixture.pin.packageDigest}`); }, fixture.pin.packageDigest,
    )).rejects.toThrow("provider reference enumeration is unavailable");
    const array = new Proxy([externalReference(fixture)], { get: () => { throw new Error("array trap"); } });
    let recordTrapCount = 0;
    const record = new Proxy(externalReference(fixture), { ownKeys: () => { recordTrapCount += 1; throw new Error("record trap"); } });
    await expect(enumerateExternalProviderReferences(async () => array, fixture.pin.packageDigest))
      .rejects.toThrow("provider reference enumeration is unavailable");
    await expect(enumerateExternalProviderReferences(async () => [record], fixture.pin.packageDigest))
      .rejects.toThrow("provider reference enumeration is unavailable");
    expect(recordTrapCount).toBe(0);
  });
});

describe("trusted external provider reference scope", () => {
  it("redacts a trusted scope failure before the operation starts", async () => {
    const fixture = await trackedFixture();
    await expect(removeProviderInstallation({
      paths: fixture.paths, packageDigest: fixture.pin.packageDigest,
      withLockedExternalReferences: async () => { throw new Error(`/private/${fixture.pin.packageDigest}`); },
    })).rejects.toThrow("provider reference enumeration is unavailable");
    await expectInstallation(fixture, true);
  });

  it("rejects malformed references before the provider state changes", async () => {
    const fixture = await trackedFixture();
    await expect(removeProviderInstallation({
      paths: fixture.paths, packageDigest: fixture.pin.packageDigest,
      withLockedExternalReferences: async (_digest, operation) => operation([{
        owner: "product", referenceId: "autosci", packageDigest: "sha256:deadbeef",
      } as unknown as ProviderPackageReferenceV1]),
    })).rejects.toThrow("provider reference enumeration is unavailable");
    await expectInstallation(fixture, true);
  });

  it("surfaces a cleanup failure after a completed operation", async () => {
    const fixture = await trackedFixture();
    await expect(removeProviderInstallation({
      paths: fixture.paths, packageDigest: fixture.pin.packageDigest,
      withLockedExternalReferences: async (_digest, operation) => {
        await operation([]);
        throw new Error(`/private/${fixture.pin.packageDigest}`);
      },
    })).rejects.toThrow("provider reference enumeration is unavailable");
    await expectInstallation(fixture, false);
  });

  it("preserves a compliant operation's own failure", async () => {
    const fixture = await trackedFixture();
    const failure = new Error("provider operation failed");
    await expect(withTrustedExternalProviderReferences(
      staticReferenceScope([]), fixture.pin.packageDigest, async () => { throw failure; },
    )).rejects.toBe(failure);
  });
});

/** Create and retain one fixture for deterministic asynchronous cleanup. */
async function trackedFixture(): Promise<ResolutionFixture> {
  const fixture = await installResolutionFixture();
  fixtures.push(fixture);
  return fixture;
}

/** Remove the installed reference while preserving the immutable cache tree. */
async function removeInstalledFixture(fixture: ResolutionFixture): Promise<void> {
  await removeProviderInstallation({
    paths: fixture.paths, packageDigest: fixture.pin.packageDigest,
    withLockedExternalReferences: staticReferenceScope([]),
  });
}

/** Supply one fixed snapshot while preserving the production outer-fence shape. */
function staticReferenceScope(references: readonly ProviderPackageReferenceV1[]): WithLockedExternalProviderReferencesV1 {
  return async (_digest, operation) => (
    operation(references)
  );
}

/** Build one valid external reference for closed-record negative tests. */
function externalReference(fixture: ResolutionFixture): ProviderPackageReferenceV1 {
  return { owner: "product", referenceId: "autosci", packageDigest: fixture.pin.packageDigest };
}

/** Assert the authoritative installation record without inspecting cache bytes. */
async function expectInstallation(fixture: ResolutionFixture, expected: boolean): Promise<void> {
  const state = await readProviderInstallState(fixture.paths);
  expect(state.installs[fixture.pin.packageDigest] !== undefined).toBe(expected);
}
