/**
 * @file test/artifacts/artifact-resolve-storefault.test.ts
 * @description Unit proof that resolveArtifactRef discriminates the overloaded
 * `artifact-store-unavailable` health: a manifest that LIES about its own
 * identity/contentKind/byte-count is an `integrity-lie` (the write-time
 * precondition must DENY it), while a MALFORMED (unparseable) manifest is a
 * `genuine-fault` (a retryable run must PARK). The public ArtifactHealth enum is
 * unchanged — the discriminant rides an additive optional `storeFault` field.
 */
import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, rm, writeFile, unlink, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { resolveArtifactRef } from "../../src/artifacts/resolve.js";
import { artifactPaths, hashArtifactBody, writeArtifactFiles, type ArtifactManifest } from "../../src/artifacts/store.js";
import { RESEARCH_PROFILE } from "../fixtures/research-profile.js";
import type { ArtifactRef } from "../../src/artifacts/ref.js";

const TYPE = "experiment-result";
const SLUG = "probe";
const BODY = `{"accuracy":0.9}`;

async function seed(root: string): Promise<{ ref: ArtifactRef; manifest: ArtifactManifest }> {
  const sha256 = hashArtifactBody(BODY);
  const manifest: ArtifactManifest = { artifactType: TYPE, slug: SLUG, sha256, bytes: Buffer.byteLength(BODY, "utf8"), contentKind: "json", writtenAt: new Date().toISOString() };
  const paths = artifactPaths(root, TYPE, SLUG, "result.json");
  await writeArtifactFiles(root, paths, BODY, manifest);
  return { ref: { artifactType: TYPE, slug: SLUG, sha256 }, manifest };
}

/** Overwrite the manifest sidecar with one that PARSES but lies about `contentKind` (declared json → claimed text). */
async function lieAboutContentKind(root: string, manifest: ArtifactManifest): Promise<void> {
  const { manifestPath } = artifactPaths(root, TYPE, SLUG, "result.json");
  await writeFile(manifestPath, `${JSON.stringify({ ...manifest, contentKind: "text" }, null, 2)}\n`, "utf8");
}

/** Replace the body leaf with a symlink so O_NOFOLLOW makes the BODY read `unavailable` while the manifest sidecar stays a real, readable file. */
async function makeBodyUnreadable(root: string): Promise<void> {
  const { bytesPath, manifestPath } = artifactPaths(root, TYPE, SLUG, "result.json");
  await unlink(bytesPath);
  await symlink(manifestPath, bytesPath); // any target: O_NOFOLLOW fails on the symlink leaf itself
}

/** Resolve and assert the integrity-lie DENY verdict (store-unavailable + integrity-lie storeFault). */
async function expectIntegrityLie(root: string, ref: ArtifactRef): Promise<void> {
  const res = await resolveArtifactRef(root, RESEARCH_PROFILE, ref);
  expect(res.health).toBe("artifact-store-unavailable");
  expect(res.storeFault).toBe("integrity-lie");
}

describe("resolveArtifactRef store-fault discrimination", () => {
  let root = "";
  beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "resolve-storefault-")); });
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  it("stamps integrity-lie when the manifest lies about contentKind", async () => {
    const { ref, manifest } = await seed(root);
    await lieAboutContentKind(root, manifest);
    await expectIntegrityLie(root, ref);
  });

  it("stamps genuine-fault when the manifest is malformed (unparseable)", async () => {
    const { ref } = await seed(root);
    const { manifestPath } = artifactPaths(root, TYPE, SLUG, "result.json");
    await writeFile(manifestPath, "{ not json", "utf8");
    const res = await resolveArtifactRef(root, RESEARCH_PROFILE, ref);
    expect(res.health).toBe("artifact-store-unavailable");
    expect(res.storeFault).toBe("genuine-fault");
  });

  it("leaves storeFault undefined on a healthy ref", async () => {
    const { ref } = await seed(root);
    const res = await resolveArtifactRef(root, RESEARCH_PROFILE, ref);
    expect(res.health).toBe("ok");
    expect(res.storeFault).toBeUndefined();
  });

  it("DENIES (integrity-lie) a LYING manifest even when the body is unreadable — never launders the lie into a park", async () => {
    const { ref, manifest } = await seed(root);
    await lieAboutContentKind(root, manifest); // parses, but lies about kind
    await makeBodyUnreadable(root); // body read fails closed (unavailable) — must NOT downgrade the lie to a park
    await expectIntegrityLie(root, ref);
  });

  it("PARKS (unreadable) an HONEST manifest whose body is unreadable — genuine fault, unchanged", async () => {
    const { ref } = await seed(root); // manifest stays honest
    await makeBodyUnreadable(root);
    const res = await resolveArtifactRef(root, RESEARCH_PROFILE, ref);
    expect(res.health).toBe("artifact-unreadable");
    expect(res.storeFault).toBeUndefined();
  });
});
