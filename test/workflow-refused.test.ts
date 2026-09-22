/**
 * @file test/workflow-refused.test.ts
 * @description Proves product-declared workflow refusal is evidence-bound,
 * irreversible, and generic: core derives the reason from the installed process
 * bytes and every ordinary lifecycle surface treats the result as terminal.
 */

import { describe, expect, it, vi } from "vitest";
import { createLocalWorkflowHost } from "../src/local-workflow-host/index.js";
import { createLocalWorkflowRuntime } from "../src/workflows/runtime.js";
import { useTempRoot } from "./fixtures/temp-root.js";
import { seedArtifact } from "./fixtures/artifact-seed.js";
import { activateProductLocked } from "../src/products/binding/activate.js";
import { startProductWorkflow } from "../src/workflows/start.js";
import { refuseWorkflow, WorkflowRefusalError } from "../src/workflows/refuse.js";
import { resumeWorkflow } from "../src/workflows/resume.js";
import { advanceWorkflow } from "../src/workflows/advance.js";
import { cancelWorkflow } from "../src/workflows/cancel.js";
import { failWorkflow } from "../src/workflows/fail.js";
import { workflowStatus } from "../src/workflows/status.js";
import { createWiki } from "../src/sdk/wiki.js";
import { runCLI } from "./fixtures/run-cli.js";
import { RunNotActiveError } from "../src/workflows/errors.js";
import {
  buildActivatableProduct, commitBuilt, FIXTURE_PRINCIPAL,
} from "./products/binding-fixture.js";

const root = useTempRoot();
const REPORT_TYPE = "review-report";
const REPORT_FILE = "report.json";
const PROCESS = JSON.stringify({
  schemaVersion: 1,
  processId: "editorial/v1",
  terminalDispositions: [
    { stageId: "observe", verifierResult: "not-approvable", reasonCode: "revision-required" },
  ],
});
const PROFILE = {
  schemaVersion: 1, profileId: "editorial", entities: { docs: { directory: "wiki/docs" } },
  artifacts: { [REPORT_TYPE]: { fileName: REPORT_FILE, contentKind: "json", maxBytes: 4096 } },
  workflows: { build: { stages: [{ id: "observe", reads: ["docs"], writes: [] }] } },
};

/** Activate the process fixture and start one workspace-bound run. */
async function startedRun() {
  const product = buildActivatableProduct("Editorial", PROCESS, PROFILE);
  const digest = await commitBuilt(root.dir, product);
  await activateProductLocked(root.dir, digest, FIXTURE_PRINCIPAL);
  return startProductWorkflow(root.dir, "desk-one", "build", {});
}

/** Retain one healthy report and return its compact artifact ref. */
function reportRef(): Promise<string> {
  return seedArtifact(root.dir, REPORT_TYPE, REPORT_FILE, "review-one", '{"coverage":"incomplete"}', "json");
}

describe("terminal workflow refusal", () => {
  it("uses constructed host observations and terminal persistence for refusal", async () => {
    const run = await startedRun();
    const base = createLocalWorkflowHost();
    const processSource = vi.fn(base.observations.processSource);
    const artifact = vi.fn(base.observations.artifact);
    const writeCandidates = vi.fn(base.records.writeCandidates);
    const runtime = createLocalWorkflowRuntime({ ...base,
      observations: { ...base.observations, processSource, artifact },
      records: { ...base.records, writeCandidates } });
    expect((await runtime.refuse(root.dir, run.runId, {
      verifierResult: "not-approvable", evidenceRef: await reportRef(),
    })).status).toBe("refused");
    expect(processSource).toHaveBeenCalledOnce();
    expect(artifact).toHaveBeenCalledOnce();
    expect(writeCandidates).toHaveBeenCalledOnce();
  });

  it("derives and records the process-declared reason over verified evidence", async () => {
    const started = await startedRun();
    const refused = await refuseWorkflow(root.dir, started.runId, {
      verifierResult: "not-approvable", evidenceRef: await reportRef(),
    });
    expect(refused.status).toBe("refused");
    expect(refused.currentStage).toBeNull();
    expect(refused.refusal).toMatchObject({
      reasonCode: "revision-required", predecessorStateVersion: started.stateVersion,
      processDefinitionDigest: started.processAuthority?.processDefinitionDigest,
    });
    expect(refused.events.at(-1)).toMatchObject({ type: "run-refused", decision: "revision-required" });
  });

  it("refuses an undeclared result or unhealthy evidence without ending the run", async () => {
    const run = await startedRun();
    await expect(refuseWorkflow(root.dir, run.runId, {
      verifierResult: "clean", evidenceRef: await reportRef(),
    })).rejects.toMatchObject({ reason: "terminal-disposition-not-declared" });
    await expect(refuseWorkflow(root.dir, run.runId, {
      verifierResult: "not-approvable", evidenceRef: `${REPORT_TYPE}/missing@sha256:${"0".repeat(64)}`,
    })).rejects.toBeInstanceOf(WorkflowRefusalError);
    expect((await workflowStatus(root.dir, run.runId))[0].run?.status).toBe("pending");
  });

  it("cannot be resumed, advanced, cancelled, or refused again", async () => {
    const run = await startedRun();
    await refuseWorkflow(root.dir, run.runId, {
      verifierResult: "not-approvable", evidenceRef: await reportRef(),
    });
    await expect(resumeWorkflow(root.dir, run.runId)).rejects.toBeInstanceOf(RunNotActiveError);
    await expect(advanceWorkflow(root.dir, run.runId)).rejects.toBeInstanceOf(RunNotActiveError);
    await expect(cancelWorkflow(root.dir, run.runId)).rejects.toBeInstanceOf(RunNotActiveError);
    await expect(failWorkflow(root.dir, run.runId, "retry")).rejects.toBeInstanceOf(RunNotActiveError);
    await expect(refuseWorkflow(root.dir, run.runId, {
      verifierResult: "not-approvable", evidenceRef: await reportRef(),
    })).rejects.toBeInstanceOf(RunNotActiveError);
    expect((await workflowStatus(root.dir, run.runId))[0].classification).toBe("historical");
  });

  it("cannot be reopened through the CLI or SDK resume surfaces", async () => {
    const run = await startedRun();
    await refuseWorkflow(root.dir, run.runId, {
      verifierResult: "not-approvable", evidenceRef: await reportRef(),
    });
    const cli = await runCLI(["workflow", "resume", run.runId], root.dir);
    expect(cli.code).not.toBe(0);
    expect(cli.stderr).toMatch(/refused/);
    await expect(createWiki({ root: root.dir }).resumeWorkflow(run.runId))
      .rejects.toBeInstanceOf(RunNotActiveError);
  });
});
