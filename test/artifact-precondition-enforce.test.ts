/**
 * @file test/artifact-precondition-enforce.test.ts
 * @description Integration proof that the artifact-existence precondition is
 * enforced at the LIVE typed-page apply path (via `validateLiveTypedPage`, shared by
 * promote + workflow page output) for BOTH a research-flavored and an unrelated
 * newsroom profile (genericity, C1). A page entering the gated terminal state
 * without a healthy pinned artifact is DENIED; with a healthy pinned ref it APPLIES;
 * a forged (integrity-lie) manifest DENIES (does not park); a malformed manifest PARKS.
 */
import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { ProfilePack } from "../src/profile/types.js";
import { stageEntityPage, promoteStagedEntityPage } from "../src/trust/staging.js";
import {
  ArtifactPreconditionUnmetError,
  ArtifactPreconditionUnverifiableError,
} from "../src/artifacts/enforce-precondition.js";
import { artifactPaths, hashArtifactBody, writeArtifactFiles, type ArtifactManifest } from "../src/artifacts/store.js";
import { formatArtifactRef } from "../src/artifacts/ref.js";
import { writeProfileFile } from "./fixtures/profile-fixtures.js";
import {
  researchArtifactPreconditionProfile, newsroomArtifactPreconditionProfile,
  multiTypeArtifactPreconditionProfile,
  RESEARCH_ARTIFACT_TYPE, RESEARCH_ARTIFACT_FILE, OTHER_ARTIFACT_TYPE, OTHER_ARTIFACT_FILE,
  NEWSROOM_ARTIFACT_TYPE, NEWSROOM_ARTIFACT_FILE,
} from "./fixtures/artifact-precondition-profiles.js";

const BODY = `{"accuracy":0.9}`;

async function seed(root: string, slug: string): Promise<string> {
  const sha256 = hashArtifactBody(BODY);
  const manifest: ArtifactManifest = { artifactType: RESEARCH_ARTIFACT_TYPE, slug, sha256, bytes: Buffer.byteLength(BODY, "utf8"), contentKind: "json", writtenAt: new Date().toISOString() };
  await writeArtifactFiles(root, artifactPaths(root, RESEARCH_ARTIFACT_TYPE, slug, RESEARCH_ARTIFACT_FILE), BODY, manifest);
  return formatArtifactRef({ artifactType: RESEARCH_ARTIFACT_TYPE, slug, sha256 });
}

/** Stage `experiments/exp` entering `complete` with the given `result` frontmatter line, then promote it live. */
async function promoteComplete(root: string, profile: ProfilePack, resultLine: string): Promise<void> {
  const body = `---\ntitle: An Experiment\nstage: complete\n${resultLine}\n---\n\nExperiment body prose here for the lint floor.\n`;
  const staged = await stageEntityPage(root, { entityType: "experiments", slug: "exp", body, profile, existingStagedCount: 0 });
  await promoteStagedEntityPage(root, staged.id);
}

describe("artifact precondition at the live typed-page apply path (research)", () => {
  let root = "";
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "artifact-precond-"));
    await writeProfileFile(root, researchArtifactPreconditionProfile());
  });
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  it("DENIES entering complete without a pinned artifact", async () => {
    await expect(promoteComplete(root, researchArtifactPreconditionProfile(), "")).rejects.toBeInstanceOf(ArtifactPreconditionUnmetError);
  });

  it("APPLIES entering complete with a healthy pinned artifact", async () => {
    const ref = await seed(root, "exp");
    await promoteComplete(root, researchArtifactPreconditionProfile(), `result: "${ref}"`);
    expect(await readFile(path.join(root, "wiki/experiments/exp.md"), "utf8")).toMatch(/stage: complete/);
  });

  it("DENIES on a forged (contentKind integrity-lie) manifest — not park", async () => {
    const ref = await seed(root, "exp");
    const { manifestPath } = artifactPaths(root, RESEARCH_ARTIFACT_TYPE, "exp", RESEARCH_ARTIFACT_FILE);
    await writeFile(manifestPath, `${JSON.stringify({ artifactType: RESEARCH_ARTIFACT_TYPE, slug: "exp", sha256: hashArtifactBody(BODY), bytes: Buffer.byteLength(BODY, "utf8"), contentKind: "text", writtenAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
    await expect(promoteComplete(root, researchArtifactPreconditionProfile(), `result: "${ref}"`)).rejects.toBeInstanceOf(ArtifactPreconditionUnmetError);
  });

  it("PARKS on a malformed manifest (genuine fault)", async () => {
    const ref = await seed(root, "exp");
    const { manifestPath } = artifactPaths(root, RESEARCH_ARTIFACT_TYPE, "exp", RESEARCH_ARTIFACT_FILE);
    await writeFile(manifestPath, "{ not json", "utf8");
    await expect(promoteComplete(root, researchArtifactPreconditionProfile(), `result: "${ref}"`)).rejects.toBeInstanceOf(ArtifactPreconditionUnverifiableError);
  });
});

const NOTE_BODY = "just a note";

/** Seed a HEALTHY `scratch-note` (the wrong type for the experiment-result requirement) and return its ref. */
async function seedNote(root: string, slug: string): Promise<string> {
  const sha256 = hashArtifactBody(NOTE_BODY);
  const manifest: ArtifactManifest = { artifactType: OTHER_ARTIFACT_TYPE, slug, sha256, bytes: Buffer.byteLength(NOTE_BODY, "utf8"), contentKind: "text", writtenAt: new Date().toISOString() };
  await writeArtifactFiles(root, artifactPaths(root, OTHER_ARTIFACT_TYPE, slug, OTHER_ARTIFACT_FILE), NOTE_BODY, manifest);
  return formatArtifactRef({ artifactType: OTHER_ARTIFACT_TYPE, slug, sha256 });
}

describe("artifact precondition binds the required type at the live apply path (multi-type)", () => {
  let root = "";
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "artifact-precond-multitype-"));
    await writeProfileFile(root, multiTypeArtifactPreconditionProfile());
  });
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  it("REFUSES the live write when the page pins a healthy WRONG-type artifact, leaving no page", async () => {
    const wrongTypeRef = await seedNote(root, "exp"); // healthy scratch-note, in field scope but not the required type
    await expect(promoteComplete(root, multiTypeArtifactPreconditionProfile(), `result: "${wrongTypeRef}"`))
      .rejects.toBeInstanceOf(ArtifactPreconditionUnmetError);
    // The refused transition must not have landed the page on disk.
    await expect(readFile(path.join(root, "wiki/experiments/exp.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

const FACTCHECK_BODY = `{"verdict":"true"}`;

/** Seed a HEALTHY newsroom `factcheck-report` artifact (mirrors `seed()` for the research type) and return its ref. */
async function seedFactcheck(root: string, slug: string): Promise<string> {
  const sha256 = hashArtifactBody(FACTCHECK_BODY);
  const manifest: ArtifactManifest = {
    artifactType: NEWSROOM_ARTIFACT_TYPE,
    slug,
    sha256,
    bytes: Buffer.byteLength(FACTCHECK_BODY, "utf8"),
    contentKind: "json",
    writtenAt: new Date().toISOString(),
  };
  await writeArtifactFiles(root, artifactPaths(root, NEWSROOM_ARTIFACT_TYPE, slug, NEWSROOM_ARTIFACT_FILE), FACTCHECK_BODY, manifest);
  return formatArtifactRef({ artifactType: NEWSROOM_ARTIFACT_TYPE, slug, sha256 });
}

describe("artifact precondition is profile-agnostic (newsroom, C1)", () => {
  let root = "";
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "artifact-precond-news-"));
    await writeProfileFile(root, newsroomArtifactPreconditionProfile());
  });
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  it("DENIES a story entering published without a healthy factcheck artifact", async () => {
    const profile = newsroomArtifactPreconditionProfile();
    const body = `---\nheadline: A Story\nstate: published\n---\n\nStory prose here for the lint floor.\n`;
    const staged = await stageEntityPage(root, { entityType: "stories", slug: "s1", body, profile, existingStagedCount: 0 });
    await expect(promoteStagedEntityPage(root, staged.id)).rejects.toBeInstanceOf(ArtifactPreconditionUnmetError);
  });

  it("APPLIES a story entering published with a healthy factcheck artifact", async () => {
    const profile = newsroomArtifactPreconditionProfile();
    const ref = await seedFactcheck(root, "s1");
    const body = `---\nheadline: A Story\nstate: published\nfactcheck: "${ref}"\n---\n\nStory prose here for the lint floor.\n`;
    const staged = await stageEntityPage(root, { entityType: "stories", slug: "s1", body, profile, existingStagedCount: 0 });
    await promoteStagedEntityPage(root, staged.id);
    expect(await readFile(path.join(root, "wiki/stories/s1.md"), "utf8")).toMatch(/state: published/);
  });
});
