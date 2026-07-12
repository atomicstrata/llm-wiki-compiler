/**
 * @file test/profile-template-tap-package.test.ts
 * @description Content-addressed remote package fetch and cache verification tests.
 */
import { mkdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { packageUrl, resolveRemotePackage } from "../src/profile/templates/taps/package.js";
import type { TapPaths } from "../src/profile/templates/taps/paths.js";
import { removeTap } from "../src/profile/templates/taps/manage.js";
import { acceptTemplateTap, isolatedTapPaths, servesTemplateBytes, templateRegistryFixture } from "./fixtures/template-tap-runtime.js";

const roots: string[] = [];
async function accepted(): Promise<{ paths: TapPaths; packageText: string }> {
  const isolated = await isolatedTapPaths("llmwiki-package-", roots);
  const root = path.dirname(isolated.configRoot);
  const paths = await acceptTemplateTap(root, "https://tap.example/v1/index.json");
  return { paths, packageText: await templateRegistryFixture("package.json") };
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
    const coordinate = "official/atomicstrata/team@1.0.0";
    const online = await resolveRemotePackage(fixture.paths, coordinate, { seams: servesTemplateBytes(fixture.packageText) });
    const offline = await resolveRemotePackage(fixture.paths, coordinate, { offline: true });
    expect(online.package.profile.profileId).toBe("team");
    expect(offline).toEqual(online);
  });

  it("refuses a tampered package before caching it", async () => {
    const fixture = await accepted();
    const tampered = fixture.packageText.replace('"displayName": "Team"', '"displayName": "Evil"');
    await expect(resolveRemotePackage(fixture.paths, "official/atomicstrata/team@1.0.0", { seams: servesTemplateBytes(tampered) })).rejects.toThrow(/digest/);
  });

  it("refuses a package when tap state changes during its fetch", async () => {
    const fixture = await accepted();
    const changing = servesTemplateBytes(fixture.packageText);
    changing.request = async () => {
      await removeTap(fixture.paths, "official");
      return { statusCode: 200, headers: { "content-type": "application/json" }, body: Readable.from([fixture.packageText]) };
    };
    await expect(resolveRemotePackage(fixture.paths, "official/atomicstrata/team@1.0.0", { seams: changing })).rejects.toThrow(/changed while verifying/);
  });

  it("refuses a symlinked package-cache leaf without reading its target", async () => {
    const fixture = await accepted();
    const coordinate = "official/atomicstrata/team@1.0.0";
    await resolveRemotePackage(fixture.paths, coordinate, { seams: servesTemplateBytes(fixture.packageText) });
    const hex = "4a39b4041e21c92f6a0351624ddfe27ec7bcc924659014909c92418bb06f3416";
    const leaf = path.join(fixture.paths.cacheRoot, "packages/sha256", `${hex}.json`);
    const victim = path.join(path.dirname(fixture.paths.cacheRoot), "victim.json");
    await writeFile(victim, fixture.packageText);
    await unlink(leaf);
    await mkdir(path.dirname(leaf), { recursive: true });
    await symlink(victim, leaf);
    await expect(resolveRemotePackage(fixture.paths, coordinate, { offline: true })).rejects.toThrow(/cache evidence is unavailable/);
  });
});
