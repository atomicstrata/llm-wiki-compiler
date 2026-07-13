/**
 * @file test/profile-template-remote-status.test.ts
 * @description Remote status independently verifies cached release evidence and
 * distinguishes drift, staleness, revocation, and available updates.
 */
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installRemoteTemplate } from "../src/profile/templates/install.js";
import { collectTemplateStatus } from "../src/profile/templates/status.js";
import { resolveRemotePackage } from "../src/profile/templates/taps/package.js";
import { readTapState, writeTapState } from "../src/profile/templates/taps/state-store.js";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { acceptTemplateTap, servesTemplateBytes, templateRegistryFixture } from "./fixtures/template-tap-runtime.js";

const COORDINATE = "official/atomicstrata/team@1.0.0";
const roots: string[] = [];

async function installed() {
  const tapRoot = await makeTempRoot("remote-status-tap");
  const project = await makeTempRoot("remote-status-project");
  roots.push(tapRoot, project);
  const paths = await acceptTemplateTap(tapRoot);
  const resolved = await resolveRemotePackage(paths, COORDINATE, {
    seams: servesTemplateBytes(await templateRegistryFixture("package.json")),
  });
  await installRemoteTemplate(project, paths, resolved, { force: false });
  return { paths, project, resolved };
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("remote template status", () => {
  it("reports a clean exact release using cached verified evidence", async () => {
    const fixture = await installed();
    await expect(collectTemplateStatus(fixture.project, fixture.paths)).resolves.toMatchObject({
      status: "installed-clean",
      sourceType: "remote",
      coordinate: COORDINATE,
      stale: false,
    });
  });

  it("reports local drift against release bytes rather than the lock digest", async () => {
    const fixture = await installed();
    const profilePath = path.join(fixture.project, ".llmwiki/profile.json");
    const profile = JSON.parse(await readFile(profilePath, "utf8"));
    await writeFile(profilePath, JSON.stringify({ ...profile, displayName: "Changed locally" }), "utf8");
    const lockPath = path.join(fixture.project, ".llmwiki/template-lock.json");
    const lock = JSON.parse(await readFile(lockPath, "utf8"));
    await writeFile(lockPath, JSON.stringify({ ...lock, profileDigest: "0".repeat(64) }), "utf8");

    await expect(collectTemplateStatus(fixture.project, fixture.paths)).resolves.toMatchObject({
      status: "locally-modified",
      sourceType: "remote",
    });
  });

  it("reports retained revocation before treating evidence as unavailable", async () => {
    const fixture = await installed();
    const state = await readTapState(fixture.paths);
    state.taps.official.publisherPins.revokedPackages.push(fixture.resolved.payloadDigest);
    await writeTapState(fixture.paths, state);
    await expect(collectTemplateStatus(fixture.project, fixture.paths)).resolves.toMatchObject({
      status: "release-revoked",
      coordinate: COORDINATE,
    });
  });

  it("reports stale accepted evidence without losing clean-profile comparison", async () => {
    const fixture = await installed();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2028-01-01T00:00:00Z"));
    await expect(collectTemplateStatus(fixture.project, fixture.paths)).resolves.toMatchObject({
      status: "installed-stale",
      stale: true,
      coordinate: COORDINATE,
    });
  });
});
