/** Lifecycle intent/recovery binds the applied projection, not ignored caller data. */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalDigest } from "../src/profile/templates/signing/canonical.js";
import { previewLifecycleLocked } from "../src/trust/lifecycle-apply.js";
import { prepareLifecycleIntent } from "../src/workflows/lifecycle-output-recovery.js";
import { createLocalWorkflowHost } from "../src/local-workflow-host/index.js";
import { submitStageOutput, type LifecycleStageOutput } from "../src/workflows/stage-output.js";
import { writeRun } from "../src/workflows/store.js";
import { kindsProfile, startKindsRun, pageLifecycle } from "./fixtures/seam-fixtures.js";
import { readOkRun } from "./fixtures/workflow-profile.js";

/** Declare one numeric evidence field; all other evidence must be ignored. */
async function fixture() {
  const profile = kindsProfile(["papers"]);
  const def = profile.entities.papers!;
  def.fields!.score = { type: "number" };
  def.lifecycle!.transitionRequirements = { review: ["score"] };
  return startKindsRun("lifecycle-evidence-parity", profile, ["a"]);
}

/** A legal output with one required field and arbitrary undeclared evidence. */
function output(junk: unknown): LifecycleStageOutput {
  return { kind: "lifecycle-transition", entityType: "papers", slug: "a", toState: "review", evidence: { score: 1, junk } };
}

/** Represent a crash after page publication but before the output receipt. */
async function landedIntent(root: string, runId: string, legacy = false): Promise<void> {
  const request = output("first");
  const host = createLocalWorkflowHost();
  const intent = await host.withMutation(root, transaction =>
    prepareLifecycleIntent(root, request, { host, transaction }));
  const preview = await previewLifecycleLocked(root, request);
  const run = await readOkRun(root, runId);
  await writeRun(root, { ...run, pendingOutput: {
    stageId: "run", opId: `${runId}:run:${run.stateVersion}`,
    lifecycle: { ...intent, ...(legacy ? { requestDigest: canonicalDigest(request) } : {}) },
  } });
  await writeFile(path.join(root, "wiki/papers/a.md"), preview.body);
}

describe("lifecycle evidence public parity", () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  it.each([NaN, 1n, circular])("ignores undeclared non-JSON evidence %#", async (junk) => {
    const { root, runId } = await fixture();
    expect((await submitStageOutput(root, runId, output(junk))).applied).toBe(true);
    expect(await pageLifecycle(root, "a")).toBe("review");
    const page = await readFile(path.join(root, "wiki/papers/a.md"), "utf8");
    expect(page).toContain("score: 1");
    expect(page).not.toContain("junk");
  });

  it("settles an already-landed output when only ignored evidence changes", async () => {
    const { root, runId } = await fixture();
    await landedIntent(root, runId);
    const result = await submitStageOutput(root, runId, output(circular));
    expect(result.applied).toBe(true);
    expect(result.run.pendingOutput).toBeUndefined();
  });

  it("can still settle an exact old internal whole-request intent", async () => {
    const { root, runId } = await fixture();
    await landedIntent(root, runId, true);
    expect((await submitStageOutput(root, runId, output("first"))).applied).toBe(true);
  });

  it("refuses recovery when declared evidence changes", async () => {
    const { root, runId } = await fixture();
    await landedIntent(root, runId);
    await expect(submitStageOutput(root, runId, { ...output(null), evidence: { score: 2 } }))
      .rejects.toMatchObject({ name: "StageOutputPendingError" });
  });
});
