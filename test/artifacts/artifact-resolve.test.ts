/**
 * @file test/artifacts/artifact-resolve.test.ts
 * @description {@link resolveArtifactRef} verifies a hash-pinned ref against the
 * ACTUAL bytes, never trusting the manifest hash alone — a bytes-only tamper
 * (manifest left stale) must be caught, and a corrupt manifest must fail closed
 * as `artifact-store-unavailable` rather than reading as clean or dangling.
 */
import { describe, it, expect } from "vitest";
import path from "path";
import { writeFile, mkdir, symlink, rm, readFile } from "fs/promises";
import { makeResearchLikeRoot, seedArtifact } from "../fixtures/artifact-root.js";
import { makeOutsideDir } from "../fixtures/outside-dir.js";
import { resolveArtifactRef } from "../../src/artifacts/resolve.js";
import { loadNonDefaultProfile } from "../../src/profile/block.js";
import { artifactPaths, hashArtifactBody, writeArtifactFiles } from "../../src/artifacts/store.js";
import type { ArtifactManifest } from "../../src/artifacts/store.js";

async function seed(prefix: string) {
  const root = await makeResearchLikeRoot(prefix);
  const ref = await seedArtifact(root, "experiment-result", "probe", `{"accuracy":0.9}`);
  const profile = (await loadNonDefaultProfile(root))!.profile;
  return { root, ref, profile };
}

/** Read the on-disk manifest sidecar as a plain object, for direct field mutation in identity/contentKind-mismatch tests. */
async function readManifestFile(manifestPath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(manifestPath, "utf8"));
}

/** The fixture profile's `experiment-result` type declares `maxBytes: 65536` (see `test/fixtures/artifact-root.ts`). */
const MAX_BYTES = 65536;

/**
 * Directly author a manifest + body pair via {@link writeArtifactFiles} (bypassing
 * the trust-checked write path, which enforces `maxBytes`/schema at write time) so
 * a test can construct an out-of-band oversize-body state that could never arise
 * through `artifact write` itself.
 */
async function seedOversizeCase(prefix: string, manifestBytesBody: string, actualBody: string) {
  const root = await makeResearchLikeRoot(prefix);
  const profile = (await loadNonDefaultProfile(root))!.profile;
  const sha256 = hashArtifactBody(manifestBytesBody);
  const paths = artifactPaths(root, "experiment-result", "probe", "result.json");
  const manifest: ArtifactManifest = {
    artifactType: "experiment-result", slug: "probe", sha256,
    bytes: Buffer.byteLength(manifestBytesBody, "utf8"), contentKind: "json", writtenAt: new Date().toISOString(),
  };
  await writeArtifactFiles(root, paths, manifestBytesBody, manifest);
  await writeFile(paths.bytesPath, actualBody); // out-of-band overwrite — grows the body past maxBytes
  return { root, profile, ref: { artifactType: "experiment-result", slug: "probe", sha256 } };
}

describe("resolveArtifactRef verifies against the bytes", () => {
  it("returns ok for an untouched artifact", async () => {
    const { root, ref, profile } = await seed("resolve-ok");
    expect((await resolveArtifactRef(root, profile, ref)).health).toBe("ok");
  });
  it("flags a bytes-only tamper (manifest left stale)", async () => {
    const { root, ref, profile } = await seed("resolve-tamper");
    const { bytesPath } = artifactPaths(root, "experiment-result", "probe", "result.json");
    await writeFile(bytesPath, `{"accuracy":0.1}`); // manifest still records the old hash
    expect((await resolveArtifactRef(root, profile, ref)).health).toBe("artifact-bytes-tampered");
  });
  it("does NOT report a corrupt manifest as clean/dangling", async () => {
    const { root, ref, profile } = await seed("resolve-corrupt");
    const { manifestPath } = artifactPaths(root, "experiment-result", "probe", "result.json");
    await writeFile(manifestPath, "{ not json"); // malformed
    expect((await resolveArtifactRef(root, profile, ref)).health).toBe("artifact-store-unavailable");
  });
});

describe("resolveArtifactRef classifies an oversize body against the recorded manifest length", () => {
  it("actualBytes diverging from manifest.bytes → artifact-bytes-tampered (provable divergence)", async () => {
    const small = `{"accuracy":0.9}`;
    const { root, profile, ref } = await seedOversizeCase("resolve-oversize-tampered", small, "x".repeat(MAX_BYTES + 4096));
    expect((await resolveArtifactRef(root, profile, ref)).health).toBe("artifact-bytes-tampered");
  });
  it("actualBytes matching manifest.bytes → artifact-unreadable (benign: operator lowered maxBytes)", async () => {
    const large = "x".repeat(MAX_BYTES + 4096);
    const { root, profile, ref } = await seedOversizeCase("resolve-oversize-benign", large, large);
    expect((await resolveArtifactRef(root, profile, ref)).health).toBe("artifact-unreadable");
  });
  it("oversize body + a broken manifest → artifact-store-unavailable (the early rung wins, oversize never overrides it)", async () => {
    const root = await makeResearchLikeRoot("resolve-oversize-broken-manifest");
    const profile = (await loadNonDefaultProfile(root))!.profile;
    const paths = artifactPaths(root, "experiment-result", "probe", "result.json");
    await mkdir(paths.expectedDir, { recursive: true });
    await writeFile(paths.manifestPath, "{ not json"); // malformed manifest
    await writeFile(paths.bytesPath, "x".repeat(MAX_BYTES + 4096));
    const ref = { artifactType: "experiment-result", slug: "probe", sha256: "0".repeat(64) };
    expect((await resolveArtifactRef(root, profile, ref)).health).toBe("artifact-store-unavailable");
  });
  it("[P3.1] an oversize body reached through a symlinked PARENT never surfaces as tampered", async () => {
    const { root, ref, profile } = await seed("resolve-oversize-symparent");
    const outside = await makeOutsideDir();
    await mkdir(path.join(outside, "evil"), { recursive: true });
    await writeFile(path.join(outside, "evil", "result.json"), "y".repeat(MAX_BYTES + 4096));
    await writeFile(path.join(outside, "evil", "result.json.manifest.json"), "{}"); // present (any content) so manifest read isn't ENOENT/absent — it must hit the SAME confinement failure as the body
    const paths = artifactPaths(root, "experiment-result", "probe", "result.json");
    await rm(paths.expectedDir, { recursive: true, force: true });
    await symlink(path.join(outside, "evil"), paths.expectedDir); // <slug> dir is a symlink OUT of tree
    const health = (await resolveArtifactRef(root, profile, ref)).health;
    expect(health).not.toBe("artifact-bytes-tampered");
    expect(health).toBe("artifact-unreadable");
  });
});

/**
 * Seed a probe artifact, mutate one field of its on-disk manifest sidecar via
 * `mutate`, resolve, and assert the shared identity/contentKind-mismatch
 * outcome: `artifact-store-unavailable` with the mutated manifest still
 * carried. Shared by the three field-mismatch cases below so they don't each
 * re-spell the read/mutate/write/assert sequence.
 */
async function expectManifestMismatchCarried(prefix: string, mutate: (raw: Record<string, unknown>) => void): Promise<void> {
  const { root, ref, profile } = await seed(prefix);
  const { manifestPath } = artifactPaths(root, "experiment-result", "probe", "result.json");
  const raw = await readManifestFile(manifestPath);
  mutate(raw); // the file still lives at ref's own path — only the recorded field lies
  await writeFile(manifestPath, JSON.stringify(raw));
  const result = await resolveArtifactRef(root, profile, ref);
  expect(result.health).toBe("artifact-store-unavailable");
  expect(result.manifest).toEqual(raw);
}

describe("resolveArtifactRef flags a manifest lying about its own identity or kind, carrying it anyway", () => {
  it("manifest.artifactType diverging from the ref → artifact-store-unavailable, manifest still carried", () =>
    expectManifestMismatchCarried("resolve-identity-artifacttype", (raw) => { raw.artifactType = "other-type"; }));
  it("manifest.slug diverging from the ref → artifact-store-unavailable, manifest still carried", () =>
    expectManifestMismatchCarried("resolve-identity-slug", (raw) => { raw.slug = "other-slug"; }));
  it("manifest.contentKind diverging from the declared artifact type → artifact-store-unavailable, manifest still carried", () =>
    // the fixture profile declares "json" for experiment-result (see test/fixtures/artifact-root.ts)
    expectManifestMismatchCarried("resolve-contentkind-mismatch", (raw) => { raw.contentKind = "text"; }));
});
