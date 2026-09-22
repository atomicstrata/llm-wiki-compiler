/**
 * Public SDK discovery witnesses: exact selectors recover pinned references,
 * but missing or tampered material never becomes authoritative absence or a
 * verified result. Reads require no write grant and do not execute selectors.
 */
import { afterEach, expect, it } from "vitest";
import { rm, writeFile, readFile, symlink } from "node:fs/promises";
import path from "node:path";
import { createWiki, type ArtifactSelectorV1 } from "../../src/index.js";
import { makeResearchLikeRoot, makeNonDefaultRootWithNoArtifactTypes, seedArtifact } from "../fixtures/artifact-root.js";

let root = "";
const selector: ArtifactSelectorV1 = { artifactType: "experiment-result", slug: "recover" };
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = ""; });

it("returns the exact verified bytes without a write grant", async () => {
  root = await makeResearchLikeRoot("verified-body");
  const body = '{"accuracy":0.9}';
  const ref = await seedArtifact(root, selector.artifactType, selector.slug, body);
  expect(await createWiki({ root }).readVerifiedArtifactBody(ref)).toEqual({ health: "ok", bytes: Buffer.from(body) });
});

it("withholds bytes when the retained body has changed", async () => {
  root = await makeResearchLikeRoot("verified-body-tampered");
  const ref = await seedArtifact(root, selector.artifactType, selector.slug, '{"accuracy":0.9}');
  await writeFile(path.join(root, "artifacts/experiment-result/recover/result.json"), '{"accuracy":0.1}');
  expect(await createWiki({ root }).readVerifiedArtifactBody(ref)).toEqual({ health: "artifact-bytes-tampered" });
});

it("requires an artifact-declaring profile for both SDK read methods", async () => {
  root = await makeNonDefaultRootWithNoArtifactTypes("verified-profile-gate");
  const wiki = createWiki({ root });
  await expect(wiki.discoverArtifact(selector)).rejects.toThrow("no artifact types declared");
  await expect(wiki.readVerifiedArtifactBody({ ...selector, sha256: "a".repeat(64) }))
    .rejects.toThrow("no artifact types declared");
});

it("discovers the exact persisted reference without a write grant", async () => {
  root = await makeResearchLikeRoot("discovery-found");
  const ref = await seedArtifact(root, selector.artifactType, selector.slug, '{"accuracy":0.9}');
  expect(await createWiki({ root }).discoverArtifact(selector)).toEqual({ status: "found", ref });
});

it("reports missing and undeclared selectors as unavailable, not proof of no effect", async () => {
  root = await makeResearchLikeRoot("discovery-missing");
  const wiki = createWiki({ root });
  expect(await wiki.discoverArtifact(selector)).toEqual({ status: "unavailable" });
  expect(await wiki.discoverArtifact({ ...selector, artifactType: "unknown" })).toEqual({ status: "unavailable" });
  expect(await wiki.discoverArtifact({ ...selector, artifactType: "constructor" })).toEqual({ status: "unavailable" });
  const inherited = { ...selector, artifactType: "constructor", sha256: "a".repeat(64) };
  expect(await wiki.verifyArtifact(inherited)).toEqual({ health: "artifact-dangling" });
  expect(await wiki.readVerifiedArtifactBody(inherited)).toEqual({ health: "artifact-dangling" });
});

it("recomputes body digests instead of trusting a retained manifest", async () => {
  root = await makeResearchLikeRoot("discovery-tampered");
  await seedArtifact(root, selector.artifactType, selector.slug, '{"accuracy":0.9}');
  await writeFile(path.join(root, "artifacts/experiment-result/recover/result.json"), '{"accuracy":0.1}');
  expect(await createWiki({ root }).discoverArtifact(selector)).toEqual({ status: "unavailable" });
});

it("captures selectors before awaiting and rejects accessors without executing them", async () => {
  root = await makeResearchLikeRoot("discovery-capture");
  const ref = await seedArtifact(root, selector.artifactType, selector.slug, '{"accuracy":0.9}');
  const mutable = { ...selector };
  const pending = createWiki({ root }).discoverArtifact(mutable);
  mutable.slug = "missing";
  expect(await pending).toEqual({ status: "found", ref });
  let calls = 0;
  const getter = { artifactType: selector.artifactType, get slug() { calls++; return "recover"; } };
  await expect(createWiki({ root }).discoverArtifact(getter)).rejects.toThrow("Invalid artifact selector");
  expect(calls).toBe(0);
});

it("rejects traversal and extra selector fields", async () => {
  root = await makeResearchLikeRoot("discovery-selector");
  const wiki = createWiki({ root });
  await expect(wiki.discoverArtifact({ ...selector, slug: "../recover" })).rejects.toThrow();
  await expect(wiki.discoverArtifact({ ...selector, extra: true } as ArtifactSelectorV1)).rejects.toThrow();
});

it("withholds a candidate whose manifest names a different artifact", async () => {
  root = await makeResearchLikeRoot("discovery-identity");
  await seedArtifact(root, selector.artifactType, selector.slug, '{"accuracy":0.9}');
  const manifestPath = path.join(root, "artifacts/experiment-result/recover/result.json.manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, slug: "another" }));
  expect(await createWiki({ root }).discoverArtifact(selector)).toEqual({ status: "unavailable" });
});

it("does not discover body bytes through a substituted symlink", async () => {
  root = await makeResearchLikeRoot("discovery-symlink");
  await seedArtifact(root, selector.artifactType, selector.slug, '{"accuracy":0.9}');
  const bodyPath = path.join(root, "artifacts/experiment-result/recover/result.json");
  const alternate = path.join(root, "alternate.json");
  await writeFile(alternate, '{"accuracy":0.9}');
  await rm(bodyPath);
  await symlink(alternate, bodyPath);
  expect(await createWiki({ root }).discoverArtifact(selector)).toEqual({ status: "unavailable" });
});
