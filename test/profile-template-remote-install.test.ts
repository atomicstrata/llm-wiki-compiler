/**
 * @file test/profile-template-remote-install.test.ts
 * @description Verifies signed remote packages enter through the shared locked
 * installer and persist complete, advisory-only v2 provenance.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadProfile } from "../src/profile/load.js";
import { installRemoteTemplate } from "../src/profile/templates/install.js";
import { readTapState, writeTapState } from "../src/profile/templates/taps/state-store.js";
import { makeTempRoot } from "./fixtures/temp-root.js";
import {
  acceptTemplateTap,
  resolveFixturePackage,
} from "./fixtures/template-tap-runtime.js";

const COORDINATE = "official/atomicstrata/team@1.0.0";
const roots: string[] = [];

async function fixture() {
  const root = await makeTempRoot("remote-install-tap");
  roots.push(root);
  const paths = await acceptTemplateTap(root);
  const resolved = await resolveFixturePackage(paths, COORDINATE);
  return { paths, resolved };
}

async function project(): Promise<string> {
  const root = await makeTempRoot("remote-install-project");
  roots.push(root);
  return root;
}

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("remote template install", () => {
  it("writes the verified profile and complete advisory provenance", async () => {
    const { paths, resolved } = await fixture();
    const root = await project();
    const result = await installRemoteTemplate(root, paths, resolved, { force: false });
    const lock = JSON.parse(await readFile(path.join(root, ".llmwiki/template-lock.json"), "utf8"));

    expect(result).toMatchObject({ templateId: "team", version: "1.0.0", lockWritten: true });
    expect(lock).toMatchObject({
      schemaVersion: 2,
      sourceType: "remote",
      remote: {
        coordinate: COORDINATE,
        packageDigest: resolved.payloadDigest,
        tap: "official",
        indexSequence: resolved.tapSequence,
        publisherKeyId: resolved.publisherKeyId,
      },
    });
    await expect(loadProfile(root)).resolves.toMatchObject({ profile: { profileId: "team" } });
  });

  it("refuses a populated default wiki without changing it", async () => {
    const { paths, resolved } = await fixture();
    const root = await project();
    await mkdir(path.join(root, "wiki/concepts"), { recursive: true });
    await writeFile(path.join(root, "wiki/concepts/existing.md"), "# Existing\n", "utf8");

    await expect(installRemoteTemplate(root, paths, resolved, { force: false })).rejects.toThrow(/typed corpus is not empty/);
    await expect(readFile(path.join(root, ".llmwiki/profile.json"), "utf8")).rejects.toThrow();
  });

  it("refuses expired accepted evidence", async () => {
    const { paths, resolved } = await fixture();
    await expect(installRemoteTemplate(await project(), paths, { ...resolved, indexExpired: true }, { force: false }))
      .rejects.toThrow(/stale/);
  });

  it("re-verifies under the tap-state lock and catches a post-review revocation", async () => {
    const { paths, resolved } = await fixture();
    const state = await readTapState(paths);
    state.taps.official.publisherPins.revokedPackages.push(resolved.payloadDigest);
    await writeTapState(paths, state);
    await expect(installRemoteTemplate(await project(), paths, resolved, { force: false }))
      .rejects.toThrow(/revoked/);
  });

  it("installs honestly when the advisory lock leaf cannot be written", async () => {
    const { paths, resolved } = await fixture();
    const root = await project();
    await mkdir(path.join(root, ".llmwiki/template-lock.json"), { recursive: true });

    const result = await installRemoteTemplate(root, paths, resolved, { force: false });
    expect(result.lockWritten).toBe(false);
    await expect(loadProfile(root)).resolves.toMatchObject({ profile: { profileId: "team" } });
  });
});
