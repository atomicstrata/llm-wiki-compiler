/**
 * @file test/viewer-workflow-run.test.ts
 * @description Tests for the GENERIC per-run projection route
 * `/api/workflows/:workflowId/runs/:runId` (P9.1). The in-process block drives the
 * builder directly (it can park/approve gates and inject a live provider); the
 * subprocess block boots the real `llmwiki view` binary and asserts the route,
 * `Cache-Control: no-store`, and the unchanged security headers.
 *
 * The route is workflow-GENERIC: these fixtures use the plain `build` workflow, never
 * product vocabulary. Recorded-only is the default (no provider); a provider only
 * UPGRADES rows to verified when its result is bound to the exact run version.
 */

import { describe, it, expect } from "vitest";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { installWorkflowProfile, buildWorkflowProfile } from "./fixtures/workflow-profile.js";
import { startWorkflow } from "../src/workflows/start.js";
import { advanceWorkflow } from "../src/workflows/advance.js";
import { approveGate } from "../src/workflows/gate.js";
import { failWorkflow } from "../src/workflows/fail.js";
import { resumeWorkflow } from "../src/workflows/resume.js";
import { readRun, writeRun } from "../src/workflows/store.js";
import { loadProfile } from "../src/profile/load.js";
import { useViewerProcessLifecycle } from "./fixtures/run-cli-server.js";
import { fetchJson } from "./fixtures/viewer-fetch.js";
import {
  buildWorkflowRunProjection, providerTimeoutMsForStageCount,
  type WorkflowRunProjectionEnvelope, type StageProjection,
  type LiveStageProjectionProvider,
} from "../src/viewer/workflow-run-projection.js";
import { startViewer } from "../src/viewer/server.js";

/** A gated first stage (write-less so it parks purely on the human gate) + a plain second. */
const GATED_STAGES = [
  { id: "review-step", reads: ["ideas"], writes: [], gate: "human:review" },
  { id: "final-step", reads: ["ideas"], writes: [] },
];

/** Narrow a projection result to the success envelope (or fail the test). */
function envelopeOf(result: WorkflowRunProjectionEnvelope | { problem: string }): WorkflowRunProjectionEnvelope {
  if ("problem" in result) throw new Error(`expected an envelope, got problem: ${result.problem}`);
  return result;
}

/** The projected stage row for `stageId`. */
function stageOf(envelope: WorkflowRunProjectionEnvelope, stageId: string): StageProjection {
  const row = envelope.stages.find((s) => s.stageId === stageId);
  if (row === undefined) throw new Error(`no projected stage "${stageId}"`);
  return row;
}

/** Start a gated `build` run and advance it to park awaiting its human gate. */
async function startParkedGatedRun(prefix: string): Promise<{ root: string; runId: string }> {
  const root = await makeTempRoot(prefix);
  await installWorkflowProfile(root, buildWorkflowProfile(GATED_STAGES));
  const run = await startWorkflow(root, "build", {});
  await advanceWorkflow(root, run.runId);
  return { root, runId: run.runId };
}

/** Assert that projecting `root`/`runId` under `provider` degrades every row to recorded-only. */
async function expectDegradesToRecordedOnly(root: string, runId: string, provider: LiveStageProjectionProvider): Promise<void> {
  const rows = envelopeOf(await buildWorkflowRunProjection(root, "build", runId, provider)).stages;
  expect(rows.every((r) => r.verification === "recorded-only")).toBe(true);
}

describe("workflow-run projection (generic, in-process)", () => {
  it("budgets provider verification at ten seconds per stage after the sixty-second floor", () => {
    expect(providerTimeoutMsForStageCount(5)).toBe(60_000);
    expect(providerTimeoutMsForStageCount(15)).toBe(150_000);
  });

  it("projects recorded-only rows with the gate lifecycle: not-reached -> awaiting -> approved", async () => {
    const { root, runId } = await startParkedGatedRun("wf-run-gate");
    const awaiting = envelopeOf(await buildWorkflowRunProjection(root, "build", runId));
    expect(awaiting.workflowId).toBe("build");
    expect(awaiting.runId).toBe(runId);
    expect(awaiting.classification).toBe("current");
    expect(typeof awaiting.stateVersion).toBe("number");
    const gatedRow = stageOf(awaiting, "review-step");
    expect(gatedRow.verification).toBe("recorded-only");
    expect(gatedRow.gate).toEqual({ gateId: "review", gateKind: "human", state: "awaiting" });
    expect(stageOf(awaiting, "final-step").gate).toBeUndefined(); // no gate declared
    await approveGate(root, runId, "review", { actorKind: "human", actorLabel: "reviewer" });
    const approved = envelopeOf(await buildWorkflowRunProjection(root, "build", runId));
    const approvedGate = stageOf(approved, "review-step").gate;
    expect(approvedGate?.state).toBe("approved");
    expect(approvedGate?.gateKind).toBe("human"); // the client labels a human gate distinctly
    expect(approvedGate?.actor).toBe("reviewer");
    expect(approvedGate?.actorKind).toBe("human"); // the recorded approver, from the gate-approved event
    expect(typeof approvedGate?.at).toBe("string");
  });

  it("projects a satisfied gate with NO gate-approved event as approved WITHOUT a fabricated byline", async () => {
    const { root, runId } = await startParkedGatedRun("wf-run-gate-eventless");
    // Splice the gate into satisfiedGates directly — no gate-approved event recorded.
    const read = await readRun(root, runId);
    if (read.status !== "ok") throw new Error(`expected a readable run, got ${read.status}`);
    await writeRun(root, { ...read.run, satisfiedGates: [...read.run.satisfiedGates, "human:review"] });
    const gate = stageOf(envelopeOf(await buildWorkflowRunProjection(root, "build", runId)), "review-step").gate;
    expect(gate?.state).toBe("approved");
    expect(gate?.gateKind).toBe("human"); // kind is derived from the declared gate, always present
    expect(gate?.actor).toBeUndefined(); // no event → no fabricated actor
    expect(gate?.actorKind).toBeUndefined();
    expect(gate?.at).toBeUndefined();
  });

  it("attributes a re-approved gate to the LATEST approver, not the stale first (resume path)", async () => {
    const { root, runId } = await startParkedGatedRun("wf-run-reapprove");
    await approveGate(root, runId, "review", { actorKind: "human", actorLabel: "first-reviewer" });
    await failWorkflow(root, runId, "retrying the review");
    await resumeWorkflow(root, runId); // clears the gate from satisfiedGates, keeps the append-only events
    await approveGate(root, runId, "review", { actorKind: "human", actorLabel: "second-reviewer" });
    const gate = stageOf(envelopeOf(await buildWorkflowRunProjection(root, "build", runId)), "review-step").gate;
    expect(gate?.state).toBe("approved");
    expect(gate?.actor).toBe("second-reviewer"); // the latest gate-approved event, not the first
  });

  it("returns a fail-visible problem when the run belongs to a different workflow (id bind)", async () => {
    const { root, runId } = await startParkedGatedRun("wf-run-mismatch");
    const result = await buildWorkflowRunProjection(root, "not-the-build-workflow", runId);
    expect("problem" in result && result.problem).toMatch(/belongs to workflow "build"/);
  });

  it("returns a fail-visible problem (not a throw) for an unknown run id", async () => {
    const root = await makeTempRoot("wf-run-absent");
    await installWorkflowProfile(root, buildWorkflowProfile(GATED_STAGES));
    const result = await buildWorkflowRunProjection(root, "build", "run_does_not_exist");
    expect("problem" in result && result.problem).toMatch(/not readable/);
  });

  it("upgrades a stage to verified when an injected provider returns run-version-bound facts", async () => {
    const { root, runId } = await startParkedGatedRun("wf-run-verified");
    // Without a provider the same stage is recorded-only — the provider is the ONLY
    // thing that can raise it to verified.
    expect(stageOf(envelopeOf(await buildWorkflowRunProjection(root, "build", runId)), "review-step").verification)
      .toBe("recorded-only");
    const provider: LiveStageProjectionProvider = async (_r, workflowId, id, expected) => ({
      workflowId, runId: id, stateVersion: expected.stateVersion, profileDigest: expected.profileDigest,
      stages: [{
        stageId: "review-step", summary: "did science", appliedTargets: ["page:x/y"], evidenceDigests: ["sha256:aa"],
        experimentState: { hypothesis: "x improves y", slug: "trial-one", lifecycle: "designed" },
      }],
    });
    const upgraded = stageOf(envelopeOf(await buildWorkflowRunProjection(root, "build", runId, provider)), "review-step");
    expect(upgraded.verification).toBe("verified");
    if (upgraded.verification !== "verified") throw new Error("unreachable");
    expect(upgraded.summary).toBe("did science");
    expect(upgraded.appliedTargets).toEqual(["page:x/y"]);
    expect(upgraded.experimentState).toEqual({ hypothesis: "x improves y", slug: "trial-one", lifecycle: "designed" });
  });

  it("DEGRADES to recorded-only when experiment state has an unknown lifecycle", async () => {
    const { root, runId } = await startParkedGatedRun("wf-run-bad-experiment-state");
    await expectDegradesToRecordedOnly(root, runId, async (_r, workflowId, id, expected) => ({
      workflowId, runId: id, stateVersion: expected.stateVersion, profileDigest: expected.profileDigest,
      stages: [{ stageId: "review-step", summary: "bad", appliedTargets: [], evidenceDigests: [],
        experimentState: { hypothesis: "x", slug: "trial", lifecycle: "invented" } } as never],
    }));
  });

  it("DEGRADES to recorded-only when the provider throws", async () => {
    const { root, runId } = await startParkedGatedRun("wf-run-degrade-throw");
    await expectDegradesToRecordedOnly(root, runId, async () => { throw new Error("provider blew up"); });
  });

  it("DEGRADES to recorded-only when the provider result is bound to a different stateVersion", async () => {
    const { root, runId } = await startParkedGatedRun("wf-run-degrade-drift");
    await expectDegradesToRecordedOnly(root, runId, async (_r, workflowId, id, expected) => ({
      workflowId, runId: id, stateVersion: expected.stateVersion + 1, profileDigest: expected.profileDigest, // STALE version
      stages: [{ stageId: "review-step", summary: "stale", appliedTargets: [], evidenceDigests: [] }],
    }));
  });

  it("DEGRADES to recorded-only when the provider result is bound to a different profile digest", async () => {
    const { root, runId } = await startParkedGatedRun("wf-run-degrade-profile");
    // A reactivation does NOT bump the run version, so version alone would mislabel these
    // as verified — the profile-digest bind is what refuses them.
    await expectDegradesToRecordedOnly(root, runId, async (_r, workflowId, id, expected) => ({
      workflowId, runId: id, stateVersion: expected.stateVersion, profileDigest: `${expected.profileDigest}-tampered`,
      stages: [{ stageId: "review-step", summary: "wrong-profile", appliedTargets: [], evidenceDigests: [] }],
    }));
  });

  it("DEGRADES to recorded-only when the provider emits a malformed (oversized) verified payload", async () => {
    const { root, runId } = await startParkedGatedRun("wf-run-degrade-malformed");
    await expectDegradesToRecordedOnly(root, runId, async (_r, workflowId, id, expected) => ({
      workflowId, runId: id, stateVersion: expected.stateVersion, profileDigest: expected.profileDigest,
      stages: [{ stageId: "review-step", summary: "x".repeat(10_000), appliedTargets: [], evidenceDigests: [] }], // past the byte bound
    }));
  });

  it("DEGRADES to recorded-only when the provider never settles (timeout)", async () => {
    const { root, runId } = await startParkedGatedRun("wf-run-degrade-timeout");
    const slow: LiveStageProjectionProvider = () => new Promise(() => { /* never resolves */ });
    const envelope = envelopeOf(await buildWorkflowRunProjection(root, "build", runId, slow, 20)); // 20ms deadline
    expect(envelope.stages.every((r) => r.verification === "recorded-only")).toBe(true);
    expect(envelope.live).toEqual({ outcome: "timed-out", timeoutMs: 20 });
  });

  it("REPORTS the live outcome: applied for an accepted provider, degraded for a throwing one, absent without one", async () => {
    const { root, runId } = await startParkedGatedRun("wf-run-live-outcome");
    const accepted: LiveStageProjectionProvider = async (_r, workflowId, id, expected) => ({ workflowId, runId: id, ...expected, stages: [] });
    const throwing: LiveStageProjectionProvider = async () => { throw new Error("provider exploded"); };
    expect(envelopeOf(await buildWorkflowRunProjection(root, "build", runId, accepted)).live).toEqual({ outcome: "applied" });
    expect(envelopeOf(await buildWorkflowRunProjection(root, "build", runId, throwing)).live).toEqual({ outcome: "degraded" });
    expect(envelopeOf(await buildWorkflowRunProjection(root, "build", runId)).live).toBeUndefined();
  });

  it("threads startViewer providerTimeoutMs to the live route", async () => {
    const { root, runId } = await startParkedGatedRun("wf-run-route-timeout-option");
    const delayed: LiveStageProjectionProvider = async (_r, workflowId, id, expected) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { workflowId, runId: id, ...expected,
        stages: [{ stageId: "review-step", summary: "late", appliedTargets: [], evidenceDigests: [] }] };
    };
    const viewer = await startViewer(
      { root, host: "127.0.0.1", port: 0, providerTimeoutMs: 5 },
      { liveStageProjectionProvider: delayed },
    );
    try {
      const response = await fetch(`http://${viewer.host}:${viewer.port}/api/workflows/build/runs/${runId}`);
      const envelope = (await response.json()) as WorkflowRunProjectionEnvelope;
      expect(stageOf(envelope, "review-step").verification).toBe("recorded-only");
    } finally {
      await viewer.close();
    }
  });

  it("a run whose workflow definition CHANGED projects its own stages without current gate metadata", async () => {
    const { root, runId } = await startParkedGatedRun("wf-run-drifted-def");
    // Redefine `build` with an extra stage: the run's sealed workflowDigest no longer
    // matches the active def, so the roster comes from the run's own stages, gate-less.
    await installWorkflowProfile(root, buildWorkflowProfile([...GATED_STAGES, { id: "extra-step", reads: ["ideas"], writes: [] }]));
    const envelope = envelopeOf(await buildWorkflowRunProjection(root, "build", runId));
    expect(envelope.classification).not.toBe("current");
    expect(stageOf(envelope, "review-step").gate).toBeUndefined(); // no unauthenticated current gate metadata
    expect(envelope.stages.some((s) => s.stageId === "extra-step")).toBe(false); // the def-added stage is NOT shown
  });

  it("a provider CANNOT bypass the anchor by mutating the passed object (frozen copy)", async () => {
    const { root, runId } = await startParkedGatedRun("wf-run-freeze");
    // Reactivate to a profile B (adds `sneaky`), then try to mutate the anchor to B's digest
    // and return B-bound facts. The frozen copy blocks the mutation, so a verified row can
    // only ever appear on the RE-BUILT B roster (which includes `sneaky`) — never spliced
    // onto the pre-reactivation A roster.
    const attack: LiveStageProjectionProvider = async (r, workflowId, id, expected) => {
      await installWorkflowProfile(r, buildWorkflowProfile([...GATED_STAGES, { id: "sneaky", reads: ["ideas"], writes: [] }]));
      const bDigest = (await loadProfile(r)).digest;
      try { (expected as { profileDigest: string }).profileDigest = bDigest; } catch { /* frozen — the point */ }
      return { workflowId, runId: id, stateVersion: expected.stateVersion, profileDigest: bDigest,
        stages: [{ stageId: "review-step", summary: "B-forged", appliedTargets: [], evidenceDigests: [] }] };
    };
    const review = stageOf(envelopeOf(await buildWorkflowRunProjection(root, "build", runId, attack)), "review-step");
    // Splice signature: a verified row carrying the PRE-reactivation gate roster. The frozen
    // anchor forces the first attempt to degrade, so any verified row can only come from the
    // consistent post-drift roster — which, for a run whose def digest changed, is gate-less.
    if (review.verification === "verified") {
      expect(review.gate, "B-verified facts spliced onto the stale gated roster").toBeUndefined();
    }
  });

  it("DEGRADES to recorded-only when the profile keeps being reactivated mid-provider (drift retry)", async () => {
    const { root, runId } = await startParkedGatedRun("wf-run-reactivate");
    let calls = 0;
    const reactivating: LiveStageProjectionProvider = async (r, workflowId, id, expected) => {
      calls += 1;
      await installWorkflowProfile(r, buildWorkflowProfile([...GATED_STAGES, { id: `added-${calls}`, reads: ["ideas"], writes: [] }]));
      return { workflowId, runId: id, stateVersion: expected.stateVersion, profileDigest: expected.profileDigest,
        stages: [{ stageId: "review-step", summary: "raced", appliedTargets: [], evidenceDigests: [] }] };
    };
    const rows = envelopeOf(await buildWorkflowRunProjection(root, "build", runId, reactivating)).stages;
    expect(rows.every((r) => r.verification === "recorded-only")).toBe(true);
    expect(calls).toBeGreaterThan(1); // it RETRIED, then degraded
  });

  it("DEGRADES to recorded-only when a verified array carries duplicates", async () => {
    const { root, runId } = await startParkedGatedRun("wf-run-dup");
    await expectDegradesToRecordedOnly(root, runId, async (_r, workflowId, id, expected) => ({
      workflowId, runId: id, stateVersion: expected.stateVersion, profileDigest: expected.profileDigest,
      stages: [{ stageId: "review-step", summary: "dup", appliedTargets: ["page:x/y", "page:x/y"], evidenceDigests: [] }],
    }));
  });

  it("DEGRADES to recorded-only when a verified pdfRef has a malformed content address", async () => {
    const { root, runId } = await startParkedGatedRun("wf-run-badref");
    await expectDegradesToRecordedOnly(root, runId, async (_r, workflowId, id, expected) => ({
      workflowId, runId: id, stateVersion: expected.stateVersion, profileDigest: expected.profileDigest,
      stages: [{ stageId: "review-step", summary: "bad-ref", appliedTargets: [], evidenceDigests: [],
        pdfRef: { artifactType: "paper-build", slug: "s", sha256: "not-a-hash", member: "main.pdf" } }],
    }));
  });

  it("captures each provider field in ONE read (check/use): a stateful getter cannot forge verified data", async () => {
    const { root, runId } = await startParkedGatedRun("wf-run-toctou");
    let summaryReads = 0;
    // A stateful getter: valid on the first read (validation), forged on any later read.
    // The single-pass snapshot must emit the value it validated, never a re-read.
    const stateful: LiveStageProjectionProvider = async (_r, workflowId, id, expected) => ({
      workflowId, runId: id, stateVersion: expected.stateVersion, profileDigest: expected.profileDigest,
      stages: [{ stageId: "review-step", appliedTargets: [], evidenceDigests: [],
        get summary() { summaryReads += 1; return summaryReads <= 1 ? "first-read" : "x".repeat(9_000); } } as never],
    });
    const review = stageOf(envelopeOf(await buildWorkflowRunProjection(root, "build", runId, stateful)), "review-step");
    if (review.verification === "verified") {
      expect(review.summary, "a re-read forged value was emitted as verified").toBe("first-read");
    }
  });

  it("a historical tombstone with an ERASED log reports its stages as unknown, not fabricated pending", async () => {
    const { root, runId } = await startParkedGatedRun("wf-run-tombstone");
    const read = await readRun(root, runId);
    if (read.status !== "ok") throw new Error("run not readable");
    // A terminal tombstone legitimately carries an empty stageLog with an unchanged digest;
    // the `?? "pending"` fallback would fabricate progress, so its stages must read "unknown".
    await writeRun(root, { ...read.run, status: "cancelled", stageLog: [] });
    const envelope = envelopeOf(await buildWorkflowRunProjection(root, "build", runId));
    expect(envelope.classification).toBe("historical");
    expect(stageOf(envelope, "review-step").status).toBe("unknown");
  });
});

const { start: startViewerProcess } = useViewerProcessLifecycle();

describe("llmwiki view — /api/workflows/:workflowId/runs/:runId (subprocess)", () => {
  it("serves the generic per-run projection with recorded-only rows and no-store", async () => {
    const root = await makeTempRoot("wf-run-route");
    await installWorkflowProfile(root); // the plain WORKFLOW_PROFILE build workflow
    const run = await startWorkflow(root, "build", {});
    const handle = await startViewerProcess(root);
    const { status, body } = await fetchJson(handle, `/api/workflows/build/runs/${run.runId}`);
    expect(status).toBe(200);
    const envelope = body as WorkflowRunProjectionEnvelope;
    expect(envelope.workflowId).toBe("build");
    expect(envelope.runId).toBe(run.runId);
    expect(envelope.stages.length).toBeGreaterThan(0);
    expect(envelope.stages.every((s) => s.verification === "recorded-only")).toBe(true);
    const raw = await fetch(`http://${handle.host}:${handle.port}/api/workflows/build/runs/${run.runId}`);
    expect(raw.headers.get("Cache-Control")).toBe("no-store");
    expect(raw.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
  });

  it("serves the P9.4 client asset and the run-list route the journey UI reads, CSP unchanged", async () => {
    const root = await makeTempRoot("wf-run-asset");
    await installWorkflowProfile(root);
    const handle = await startViewerProcess(root);
    for (const name of ["viewer-stage-facts.js", "viewer-experiment-compat.js"]) {
      const asset = await fetch(`http://${handle.host}:${handle.port}/assets/${name}`);
      expect(asset.status).toBe(200);
      expect(asset.headers.get("Content-Type")).toContain("application/javascript");
      expect(asset.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
    }
    const runs = await fetchJson(handle, "/api/workflow-runs");
    expect(runs.status).toBe(200);
    expect(Array.isArray((runs.body as { runs: unknown[] }).runs)).toBe(true);
  });

  it("returns a JSON 404 for a malformed workflow-run path", async () => {
    const root = await makeTempRoot("wf-run-route-404");
    await installWorkflowProfile(root);
    const handle = await startViewerProcess(root);
    const { status } = await fetchJson(handle, "/api/workflows/build/runs"); // missing runId segment
    expect(status).toBe(404);
  });
});
