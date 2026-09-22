/**
 * @file test/viewer-stage-output.test.ts
 * @description The GENERIC stage-output artifact route (P9.3)
 * `/api/workflows/:workflowId/runs/:runId/stage/:stageId/output`. Subprocess tests boot the
 * real `llmwiki view` binary and assert it serves a stage's recorded output artifact bytes
 * with a content-type FIXED by the artifact type's declared contentKind, nosniff, inline, and
 * no-store — the ref derived SERVER-side from run.outputs (the URL carries no type/slug/sha).
 * The route is workflow-generic: these fixtures use plain artifact profiles, never a research
 * journey; the served bytes come from the confined, re-hashing verified-artifact reader.
 */

import { describe, it, expect } from "vitest";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { submitStageOutput, type StageOutput } from "../src/workflows/stage-output.js";
import { readRun, writeRun } from "../src/workflows/store.js";
import { artifactPaths } from "../src/artifacts/store.js";
import { PROFILE_FILE } from "../src/utils/constants.js";
import {
  startArtifactRun, grantTrustedWrite, resultOutput, researchArtifactProfile, newsroomArtifactProfile,
} from "./fixtures/artifact-seam-fixtures.js";
import type { ProfilePack } from "../src/profile/types.js";
import { useViewerProcessLifecycle } from "./fixtures/run-cli-server.js";

const { start: startViewerProcess } = useViewerProcessLifecycle();

interface RecordedRun { root: string; workflowId: string; runId: string; stageId: string; body: string }

/** Start a `build` run, grant trusted write, record ONE artifact output, return its ids + body. */
async function runWithArtifact(prefix: string, profile: ProfilePack, output: StageOutput): Promise<RecordedRun> {
  const { root, runId, profileId } = await startArtifactRun(prefix, profile);
  grantTrustedWrite(profileId);
  const run = (await submitStageOutput(root, runId, output)).run;
  const stageId = Object.keys(run.outputs)[0] as string;
  return { root, workflowId: run.workflowId, runId, stageId, body: (output as { body: string }).body };
}

/** GET the stage-output route for `ids` under an optionally overridden workflow/stage. */
async function fetchOutput(r: RecordedRun, over: { workflowId?: string; stageId?: string } = {}): Promise<Response> {
  const handle = await startViewerProcess(r.root);
  const wf = over.workflowId ?? r.workflowId;
  const stage = over.stageId ?? r.stageId;
  return fetch(`http://${handle.host}:${handle.port}/api/workflows/${wf}/runs/${r.runId}/stage/${stage}/output`);
}

describe("llmwiki view — /api/workflows/:workflowId/runs/:runId/stage/:stageId/output (subprocess)", () => {
  it("serves a JSON output artifact with the server-derived ref, nosniff, inline, no-store", async () => {
    const r = await runWithArtifact("so-json-", researchArtifactProfile(), resultOutput("r1"));
    const res = await fetchOutput(r);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Disposition")).toContain(`filename="output.json"`);
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'self'"); // CSP unchanged
    expect(await res.text()).toBe(r.body);
  }, 60_000);

  it("serves a TEXT artifact as text/plain — the content-type is generic from contentKind", async () => {
    const output: StageOutput = { kind: "artifact", artifactType: "fact-check", slug: "c1", body: "a plain fact-check body" };
    const r = await runWithArtifact("so-text-", newsroomArtifactProfile(), output);
    const res = await fetchOutput(r);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/plain");
    expect(res.headers.get("Content-Disposition")).toContain(`filename="output.txt"`);
    expect(await res.text()).toBe("a plain fact-check body");
  }, 60_000);

  it("returns a fail-visible 404 for a workflow-id mismatch", async () => {
    const r = await runWithArtifact("so-mm-", researchArtifactProfile(), resultOutput("r1"));
    const res = await fetchOutput(r, { workflowId: "not-build" });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("artifact_unavailable");
  }, 60_000);

  it("returns 404 for a stage with no recorded output", async () => {
    const r = await runWithArtifact("so-noout-", researchArtifactProfile(), resultOutput("r1"));
    const res = await fetchOutput(r, { stageId: "unreached-stage" });
    expect(res.status).toBe(404);
  }, 60_000);

  it("REFUSES a run.outputs ref carrying a malformed (non-64-hex) digest", async () => {
    const r = await runWithArtifact("so-baddig-", researchArtifactProfile(), resultOutput("r1"));
    const read = await readRun(r.root, r.runId);
    if (read.status !== "ok") throw new Error("run not readable");
    const existing = read.run.outputs[r.stageId] as Record<string, unknown>;
    const tampered = { ...existing, sha256: "not-a-64-hex-digest" };
    await writeRun(r.root, { ...read.run, outputs: { ...read.run.outputs, [r.stageId]: tampered } });
    const res = await fetchOutput(r);
    expect(res.status).toBe(404);
  }, 60_000);

  it("REFUSES when the retained artifact BYTES are tampered after recording (the verified read is load-bearing)", async () => {
    const r = await runWithArtifact("so-tamper-", researchArtifactProfile(), resultOutput("r1"));
    // The ref's digest is still valid, but the on-disk bytes no longer hash to it — only the
    // re-hashing verified reader catches this, so a route that bypassed it would serve forged bytes.
    const { bytesPath } = artifactPaths(r.root, "experiment-result", "r1", "result.json");
    await writeFile(bytesPath, `{"accuracy":0.123456}`, "utf8");
    const res = await fetchOutput(r);
    expect(res.status).toBe(404);
  }, 60_000);

  it("returns a 404 (not a 500) when the profile becomes UNAVAILABLE after server startup", async () => {
    const r = await runWithArtifact("so-noprofile-", researchArtifactProfile(), resultOutput("r1"));
    const handle = await startViewerProcess(r.root);
    // A profile that fails to load at REQUEST time (corrupt JSON) must degrade to the route's
    // typed 404 problem, never propagate to the global 500 handler.
    await writeFile(path.join(r.root, PROFILE_FILE), "{ not valid json", "utf8");
    const res = await fetch(`http://${handle.host}:${handle.port}/api/workflows/${r.workflowId}/runs/${r.runId}/stage/${r.stageId}/output`);
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  }, 60_000);

  it("returns 404 for a malformed stage-output path (missing /output)", async () => {
    const r = await runWithArtifact("so-badpath-", researchArtifactProfile(), resultOutput("r1"));
    const handle = await startViewerProcess(r.root);
    const res = await fetch(`http://${handle.host}:${handle.port}/api/workflows/build/runs/${r.runId}/stage/${r.stageId}`);
    expect(res.status).toBe(404);
  }, 60_000);
});
