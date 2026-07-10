/**
 * @file test/second-profile-genericity-gate.test.ts
 * @description The C1 completion-gate teeth (Phase 7): the DELIBERATELY DISSIMILAR
 * newsroom profile drives the THREE net-new Phase-7 capabilities through the SAME
 * generic `src/` seams the research profile uses, with ZERO newsroom-specific core
 * code. The three `it`s map one-to-one onto the capabilities:
 *   1. P-A workflow artifact output   — `submitStageOutput` artifact arm.
 *   2. artifactRef write-time precondition — `enforceArtifactPreconditions` at live apply.
 *   3. connector staging substrate     — `runConnector` offline.
 * If any leg needed a newsroom-specific branch in `src/`, that leg would fail; this
 * file is the single consolidated gate, so it re-asserts each capability here even
 * where a sibling test covers it, always through the same shared fixture/driver.
 */
import { describe, it, afterEach, expect } from "vitest";
import { mkdtemp, rm, readFile, mkdir, writeFile, access } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { newsroomArtifactProfile, submitGrantedArtifact, expectAppliedArtifactWrite } from "./fixtures/artifact-seam-fixtures.js";
import { type StageOutput } from "../src/workflows/stage-output.js";
import { TRUSTED_WRITE_ENV_VAR } from "../src/workflows/trusted-write.js";
import { stageEntityPage, promoteStagedEntityPage } from "../src/trust/staging.js";
import { ArtifactPreconditionUnmetError } from "../src/artifacts/enforce-precondition.js";
import { seedArtifact } from "./fixtures/artifact-seed.js";
import { newsroomArtifactPreconditionProfile, NEWSROOM_ARTIFACT_TYPE, NEWSROOM_ARTIFACT_FILE } from "./fixtures/artifact-precondition-profiles.js";
import { writeProfileFile } from "./fixtures/profile-fixtures.js";
import { buildNewsroomProject } from "./fixtures/newsroom-profile.js";
import { runConnector } from "../src/connectors/run.js";
import { listCandidates } from "../src/compiler/candidates.js";
import type { ConfinedFetchResult } from "../src/connectors/confined-fetch.js";

const roots: string[] = [];

afterEach(async () => {
  delete process.env[TRUSTED_WRITE_ENV_VAR];
  delete process.env.LLMWIKI_CONNECTORS;
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

/** A fresh project root carrying the newsroom artifact-precondition profile. */
async function freshPreconditionRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gate-precond-news-"));
  roots.push(root);
  await writeProfileFile(root, newsroomArtifactPreconditionProfile());
  return root;
}

/** A `stories` page body entering `published`, optionally pinning a factcheck ref line. */
function publishedStory(factcheckLine: string): string {
  const extra = factcheckLine ? `${factcheckLine}\n` : "";
  return `---\nheadline: A Story\nstate: published\n${extra}---\n\nStory prose here for the lint floor.\n`;
}

/** Stage `stories/s1` from `body` and return its candidate id (staging never enforces the precondition). */
async function stageStory(root: string, body: string): Promise<string> {
  const staged = await stageEntityPage(root, { entityType: "stories", slug: "s1", body, profile: newsroomArtifactPreconditionProfile(), existingStagedCount: 0 });
  return staged.id;
}

describe("C1 second-profile genericity gate (newsroom drives the Phase-7 capabilities)", () => {
  it("P-A: applies a newsroom artifact stage-output through the same generic seam, workflow-origin event", async () => {
    const out: StageOutput = { kind: "artifact", artifactType: "fact-check", slug: "story-1", body: "verified" };
    const { root, result } = await submitGrantedArtifact("gate-pa-news-", newsroomArtifactProfile(), out);
    roots.push(root);
    await expectAppliedArtifactWrite(result, root);
  });

  it("artifactRef precondition: published is REFUSED without a healthy factcheck, PASSES with one (same enforcer)", async () => {
    const denyRoot = await freshPreconditionRoot();
    await expect(promoteStagedEntityPage(denyRoot, await stageStory(denyRoot, publishedStory(""))))
      .rejects.toBeInstanceOf(ArtifactPreconditionUnmetError);
    const okRoot = await freshPreconditionRoot();
    const ref = await seedArtifact(okRoot, NEWSROOM_ARTIFACT_TYPE, NEWSROOM_ARTIFACT_FILE, "s1", `{"verdict":"true"}`, "json");
    await promoteStagedEntityPage(okRoot, await stageStory(okRoot, publishedStory(`factcheck: "${ref}"`)));
    expect(await readFile(path.join(okRoot, "wiki/stories/s1.md"), "utf8")).toMatch(/state: published/);
  });

  it("connector staging: stages a reviewMode:connector candidate and writes NO live page (same substrate)", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "gate-connector-news-"));
    roots.push(root);
    await buildNewsroomProject(root);
    await mkdir(path.join(root, ".llmwiki"), { recursive: true });
    await writeFile(path.join(root, ".llmwiki", "config.json"), JSON.stringify({ connectors: { fixture: { contactEmail: "ops@example.com", allowedHosts: ["fixture.local"] } } }), "utf8");
    process.env.LLMWIKI_CONNECTORS = "fixture";
    const fetcher = (): Promise<ConfinedFetchResult> => Promise.resolve({ kind: "ok", finalUrl: "https://fixture.local/story-1", bytes: Buffer.from("{}", "utf8"), contentHash: "a".repeat(64) });
    const result = await runConnector(root, "fixture", { id: "story-1" }, { fetcher });
    expect(result.kind).toBe("staged");
    const [candidate] = await listCandidates(root);
    expect(candidate?.reviewMode).toBe("connector");
    await expect(access(path.join(root, "wiki/articles", `${candidate!.slug}.md`))).rejects.toThrow();
  });
});
