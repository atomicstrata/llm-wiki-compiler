/**
 * @file test/profile-template-tap-discovery.test.ts
 * @description Search and inspect behavior over accepted signed tap evidence.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { searchRemoteTemplates, inspectRemoteTemplate } from "../src/profile/templates/taps/discovery.js";
import { addTap } from "../src/profile/templates/taps/manage.js";
import { resolveRemotePackage } from "../src/profile/templates/taps/package.js";
import type { TapPaths } from "../src/profile/templates/taps/paths.js";
import { readTapState, writeTapState } from "../src/profile/templates/taps/state-store.js";
import { acceptTemplateTap, servesTemplateBytes, templateRegistryFixture, TAP_KEY } from "./fixtures/template-tap-runtime.js";

const roots: string[] = [];
async function setup(): Promise<TapPaths> {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmwiki-discovery-"));
  roots.push(root);
  return acceptTemplateTap(root);
}

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("remote template discovery", () => {
  it("searches accepted index metadata without fetching packages", async () => {
    const search = await searchRemoteTemplates(await setup(), "team");
    expect(search.results).toMatchObject([{ coordinate: "official/atomicstrata/team@1.0.0", publisher: "atomicstrata" }]);
    expect(search.warnings).toEqual([]);
  });

  it("inspects only after package evidence has been verified and cached", async () => {
    const paths = await setup();
    const packageText = await templateRegistryFixture("package.json");
    await resolveRemotePackage(paths, "official/atomicstrata/team@1.0.0", { seams: servesTemplateBytes(packageText) });
    const details = await inspectRemoteTemplate(paths, "official/atomicstrata/team@1.0.0");
    expect(details).toMatchObject({ displayName: "Team", templateId: "team", publisherKeyId: "publisher-key-1" });
    expect(JSON.stringify(details)).not.toContain('"profile"');
  });

  it("does not advertise a package revoked in authoritative continuity state", async () => {
    const paths = await setup();
    const state = await readTapState(paths);
    const source = state.taps.official;
    const digest = source.publisherPins.coordinates["official/atomicstrata/team@1.0.0"];
    source.publisherPins.revokedPackages.push(digest);
    await writeTapState(paths, state);
    expect((await searchRemoteTemplates(paths, "team")).results).toEqual([]);
  });

  it("refuses cached evidence when coordinate continuity state diverges", async () => {
    const paths = await setup();
    await expectContinuityWarning(paths, (state) => {
      state.taps.official.publisherPins.coordinates["official/atomicstrata/team@1.0.0"] = `sha256:${"0".repeat(64)}`;
    }, /coordinate continuity/);
  });

  it("refuses cached evidence when publisher continuity state diverges", async () => {
    const paths = await setup();
    await expectContinuityWarning(paths, (state) => {
      state.taps.official.publisherPins.publishers.atomicstrata.keyId = "other-key";
    }, /publisher continuity/);
  });

  it("refuses an explicitly selected unknown tap instead of returning an empty result", async () => {
    const paths = await setup();
    await expect(searchRemoteTemplates(paths, "team", "missing")).rejects.toThrow(/unknown template tap/);
  });

  it("keeps healthy results and warns when another enabled tap is unrefreshed", async () => {
    const paths = await setup();
    await addTap(paths, { name: "new", indexUrl: "https://new.example/index.json", key: TAP_KEY });
    const search = await searchRemoteTemplates(paths, "team");
    expect(search.results).toHaveLength(1);
    expect(search.warnings).toEqual([{ tap: "new", reason: "template tap has not been refreshed: new" }]);
  });

  it("keeps explicitly scoped search fail closed for an unrefreshed tap", async () => {
    const paths = await setup();
    await addTap(paths, { name: "new", indexUrl: "https://new.example/index.json", key: TAP_KEY });
    await expect(searchRemoteTemplates(paths, "team", "new")).rejects.toThrow(/has not been refreshed/);
  });
});

async function expectContinuityWarning(
  paths: TapPaths,
  mutate: (state: Awaited<ReturnType<typeof readTapState>>) => void,
  pattern: RegExp,
): Promise<void> {
  const state = await readTapState(paths);
  mutate(state);
  await writeTapState(paths, state);
  const search = await searchRemoteTemplates(paths, "team");
  expect(search.results).toEqual([]);
  expect(search.warnings[0].reason).toMatch(pattern);
}
