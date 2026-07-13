/**
 * @file test/profile-template-tap-package.test.ts
 * @description Content-addressed remote package fetch and cache verification tests.
 */
import { mkdir, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { packageUrl, resolveRemotePackage } from "../src/profile/templates/taps/package.js";
import type { TapPaths } from "../src/profile/templates/taps/paths.js";
import { removeTap } from "../src/profile/templates/taps/manage.js";
import { addTap } from "../src/profile/templates/taps/manage.js";
import { refreshTap } from "../src/profile/templates/taps/refresh.js";
import { acceptTemplateTap, isolatedTapPaths, servesTemplateBytes, templateRegistryFixture } from "./fixtures/template-tap-runtime.js";
import { PUBLISHER_KEY, remotePackage, signedIndex, signedPackage, TAP_KEY } from "./fixtures/template-signing.js";

const roots: string[] = [];
const COORDINATE = "official/atomicstrata/team@1.0.0";
async function accepted(): Promise<{ paths: TapPaths; packageText: string }> {
  const isolated = await isolatedTapPaths("llmwiki-package-", roots);
  const root = path.dirname(isolated.configRoot);
  const paths = await acceptTemplateTap(root, "https://tap.example/v1/index.json");
  return { paths, packageText: await templateRegistryFixture("package.json") };
}

async function packageCacheLeaf(paths: TapPaths): Promise<string> {
  const root = path.join(paths.cacheRoot, "packages");
  const files = await readdir(root, { recursive: true });
  return path.join(root, files.find((file) => file.endsWith(".json"))!);
}

async function seedPackageCache(fixture: Awaited<ReturnType<typeof accepted>>): Promise<string> {
  await resolveRemotePackage(fixture.paths, COORDINATE, { seams: servesTemplateBytes(fixture.packageText) });
  return packageCacheLeaf(fixture.paths);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("remote package resolution", () => {
  it("derives an exact-origin content-addressed URL", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    expect(packageUrl("https://tap.example/v1/index.json", digest)).toBe(`https://tap.example/v1/packages/sha256/${"a".repeat(64)}.json`);
  });

  it("fetches, verifies, caches, then verifies again offline", async () => {
    const fixture = await accepted();
    const online = await resolveRemotePackage(fixture.paths, COORDINATE, { seams: servesTemplateBytes(fixture.packageText) });
    const offline = await resolveRemotePackage(fixture.paths, COORDINATE, { offline: true });
    expect(online.package.profile.profileId).toBe("team");
    expect(offline).toEqual(online);
  });

  it("keeps coordinate-specific envelopes separate when taps mirror one payload", async () => {
    const fixture = await accepted();
    const mirror = "mirror/atomicstrata/team@1.0.0";
    const payloadDigest = signedPackage().payloadDigest;
    await addTap(fixture.paths, { name: "mirror", indexUrl: "https://mirror.example/index.json", key: TAP_KEY });
    const mirrorIndex = JSON.stringify(signedIndex({
      tap: "mirror",
      packages: [{ coordinate: mirror, publisher: "atomicstrata", payloadDigest }],
      publishers: { atomicstrata: PUBLISHER_KEY },
    }));
    await refreshTap(fixture.paths, "mirror", servesTemplateBytes(mirrorIndex));
    await resolveRemotePackage(fixture.paths, COORDINATE, { seams: servesTemplateBytes(fixture.packageText) });
    const resolved = await resolveRemotePackage(fixture.paths, mirror, {
      seams: servesTemplateBytes(JSON.stringify(signedPackage(remotePackage(), mirror))),
    });
    expect(resolved.coordinate).toBe(mirror);
  });

  it("replaces invalid cached evidence from the network when online", async () => {
    const fixture = await accepted();
    const leaf = await seedPackageCache(fixture);
    await writeFile(leaf, "not-json");
    const resolved = await resolveRemotePackage(fixture.paths, COORDINATE, { seams: servesTemplateBytes(fixture.packageText) });
    expect(resolved.package.templateId).toBe("team");
  });

  it("refuses a tampered package before caching it", async () => {
    const fixture = await accepted();
    const tampered = fixture.packageText.replace('"displayName": "Team"', '"displayName": "Evil"');
    await expect(resolveRemotePackage(fixture.paths, COORDINATE, { seams: servesTemplateBytes(tampered) })).rejects.toThrow(/digest/);
  });

  it("refuses a package when tap state changes during its fetch", async () => {
    const fixture = await accepted();
    const changing = servesTemplateBytes(fixture.packageText);
    changing.request = async () => {
      await removeTap(fixture.paths, "official");
      return { statusCode: 200, headers: { "content-type": "application/json" }, body: Readable.from([fixture.packageText]) };
    };
    await expect(resolveRemotePackage(fixture.paths, COORDINATE, { seams: changing })).rejects.toThrow(/changed while verifying/);
  });

  it("refuses a symlinked package-cache leaf without reading its target", async () => {
    const fixture = await accepted();
    const leaf = await seedPackageCache(fixture);
    const victim = path.join(path.dirname(fixture.paths.cacheRoot), "victim.json");
    await writeFile(victim, fixture.packageText);
    await unlink(leaf);
    await mkdir(path.dirname(leaf), { recursive: true });
    await symlink(victim, leaf);
    await expect(resolveRemotePackage(fixture.paths, COORDINATE, { offline: true })).rejects.toThrow(/cache evidence is unavailable/);
  });
});
