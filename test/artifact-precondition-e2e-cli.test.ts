/**
 * @file test/artifact-precondition-e2e-cli.test.ts
 * @description End-to-end subprocess proof over `dist/cli.js` that the write-time
 * artifact precondition gates a LIVE typed-page approval: a candidate entering the
 * gated `complete` state is APPROVED when it pins a healthy artifact and DENIED
 * (exit 1, page not live) when the pinned artifact's manifest is a forged
 * integrity-lie — proving a forged manifest does NOT park (superset proof gate a).
 */
import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, rm, readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runCLI } from "./fixtures/run-cli.js";
import { writeProfileFile } from "./fixtures/profile-fixtures.js";
import { stageCompleteExperimentCandidate } from "./fixtures/artifact-seed.js";
import { artifactPaths, hashArtifactBody, type ArtifactManifest } from "../src/artifacts/store.js";
import { researchArtifactPreconditionProfile, RESEARCH_ARTIFACT_TYPE, RESEARCH_ARTIFACT_FILE } from "./fixtures/artifact-precondition-profiles.js";

const GRANT = { LLMWIKI_TRUSTED_WRITE: "research-artifact" };
const BODY = `{"accuracy":0.9}`;

describe("artifact precondition over dist/cli.js (review approve)", () => {
  let root = "";
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "artifact-precond-e2e-"));
    await writeProfileFile(root, researchArtifactPreconditionProfile());
  });
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  it("APPROVES a complete candidate pinning a healthy artifact", async () => {
    const w = await runCLI(["artifact", "write", "--type", RESEARCH_ARTIFACT_TYPE, "--slug", "good", "--body", BODY], root, GRANT);
    expect(w.code).toBe(0);
    const ref = w.stdout.trim().split(/\s+/).pop()!;
    const id = await stageCompleteExperimentCandidate(root, "good", ref);
    const approved = await runCLI(["review", "approve", id], root, GRANT);
    expect(approved.code).toBe(0);
    expect(await readFile(path.join(root, "wiki/experiments/good.md"), "utf8")).toMatch(/stage: complete/);
  });

  it("DENIES a complete candidate whose pinned artifact manifest is a forged integrity-lie", async () => {
    const w = await runCLI(["artifact", "write", "--type", RESEARCH_ARTIFACT_TYPE, "--slug", "bad", "--body", BODY], root, GRANT);
    const ref = w.stdout.trim().split(/\s+/).pop()!;
    const { manifestPath } = artifactPaths(root, RESEARCH_ARTIFACT_TYPE, "bad", RESEARCH_ARTIFACT_FILE);
    const lying: ArtifactManifest = { artifactType: RESEARCH_ARTIFACT_TYPE, slug: "bad", sha256: hashArtifactBody(BODY), bytes: Buffer.byteLength(BODY, "utf8"), contentKind: "text", writtenAt: new Date().toISOString() };
    await writeFile(manifestPath, `${JSON.stringify(lying, null, 2)}\n`, "utf8");
    const id = await stageCompleteExperimentCandidate(root, "bad", ref);
    const denied = await runCLI(["review", "approve", id], root, GRANT);
    expect(denied.code).not.toBe(0);
    await expect(access(path.join(root, "wiki/experiments/bad.md"))).rejects.toThrow();
  });
});
