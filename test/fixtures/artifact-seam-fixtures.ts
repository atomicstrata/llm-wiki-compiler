/**
 * @file test/fixtures/artifact-seam-fixtures.ts
 * @description Shared fixture for the artifact stage-output seam. TWO deliberately
 * dissimilar non-default profiles — a research `experiment-result` and a newsroom
 * `fact-check` — each declare a one-stage `build` workflow whose stage PRODUCES an
 * artifact (`artifactWrites`). Both drive the SAME machinery, proving the
 * artifact-output path is profile-agnostic (the P-A genericity proof).
 */
import { writeFile, mkdtemp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { expect } from "vitest";
import type { ProfilePack } from "../../src/profile/types.js";
import { submitStageOutput, type StageOutput } from "../../src/workflows/stage-output.js";
import { startWorkflow } from "../../src/workflows/start.js";
import { readEvents } from "../../src/events/store-read.js";
import { TRUSTED_WRITE_ENV_VAR } from "../../src/workflows/trusted-write.js";
import { PROFILE_FILE } from "../../src/utils/constants.js";
import { buildResearchLiteProject } from "./profile-fixtures.js";

/** A research profile: an `experiment-result` json artifact + a stage that writes it. */
export function researchArtifactProfile(gate?: string): ProfilePack {
  return {
    schemaVersion: 1, profileId: "research-artifact",
    entities: { experiments: { directory: "wiki/experiments" } },
    artifacts: { "experiment-result": { fileName: "result.json", contentKind: "json", maxBytes: 4096, metadata: { accuracy: { type: "number", required: true } } } },
    workflows: { build: { stages: [{ id: "run", reads: [], writes: [], artifactWrites: ["experiment-result"], ...(gate ? { gate } : {}) }] } },
  } as ProfilePack;
}

/** A DISSIMILAR newsroom profile: a `fact-check` text artifact + a stage that writes it. */
export function newsroomArtifactProfile(gate?: string): ProfilePack {
  return {
    schemaVersion: 1, profileId: "newsroom-artifact",
    entities: { stories: { directory: "wiki/stories" } },
    artifacts: { "fact-check": { fileName: "check.txt", contentKind: "text", maxBytes: 4096 } },
    workflows: { build: { stages: [{ id: "run", reads: [], writes: [], artifactWrites: ["fact-check"], ...(gate ? { gate } : {}) }] } },
  } as ProfilePack;
}

/** Stand up a project from `profile` and start its `build` run. */
export async function startArtifactRun(prefix: string, profile: ProfilePack): Promise<{ root: string; runId: string; profileId: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  await buildResearchLiteProject(root);
  await writeFile(path.join(root, PROFILE_FILE), JSON.stringify(profile), "utf8");
  const run = await startWorkflow(root, "build", {});
  return { root, runId: run.runId, profileId: profile.profileId };
}

/** An `experiment-result` artifact output with a valid json body (accuracy metadata). */
export function resultOutput(slug: string, body = `{"accuracy":0.9}`): StageOutput {
  return { kind: "artifact", artifactType: "experiment-result", slug, body };
}

/** Grant the given profile out-of-band trusted auto-apply for the current test. */
export function grantTrustedWrite(profileId: string): void {
  process.env[TRUSTED_WRITE_ENV_VAR] = profileId;
}

/** The shared allow-path driver: start `profile`'s build run, grant trusted-write, submit `output`. */
export async function submitGrantedArtifact(
  prefix: string,
  profile: ProfilePack,
  output: StageOutput,
): Promise<{ root: string; result: Awaited<ReturnType<typeof submitStageOutput>> }> {
  const { root, runId, profileId } = await startArtifactRun(prefix, profile);
  grantTrustedWrite(profileId);
  return { root, result: await submitStageOutput(root, runId, output) };
}

/** Assert a granted stage-output APPLIED, pinned a sha256 artifact ref, and recorded a workflow-origin event. */
export async function expectAppliedArtifactWrite(
  result: Awaited<ReturnType<typeof submitStageOutput>>,
  root: string,
): Promise<void> {
  expect(result.applied).toBe(true);
  expect((result.run.outputs.run as { sha256: string }).sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(await readArtifactEventOrigin(root)).toBe("workflow");
}

/** The `origin` of the last artifact-write event (undefined when none recorded). */
export async function readArtifactEventOrigin(root: string): Promise<string | undefined> {
  const ev = (await readEvents(root)).events.filter((e) => e.type === "artifact-write").at(-1) as { origin?: string } | undefined;
  return ev?.origin;
}

/** How many `artifact-write` events the journal has recorded so far (a rewrite emits a new one). */
export async function countArtifactWriteEvents(root: string): Promise<number> {
  return (await readEvents(root)).events.filter((e) => e.type === "artifact-write").length;
}
