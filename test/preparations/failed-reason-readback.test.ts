/**
 * @file Generic durable failure reporting witness. The real attempt executor
 * commits a leg failure, and the operator's show service reads the persisted
 * code and detail. No standalone product or in-memory result substitutes for
 * the durable read path; product-specific invocation witnesses are archived.
 */
import { afterEach, describe, expect, it } from "vitest";
import { executePhaseAttempt } from "../../src/preparations/attempts/execute.js";
import { showPreparationOperation } from "../../src/preparations/service-show.js";
import { attemptRequest, stagePreparation, succeededLeg, type StagedPreparation } from "./attempt-fixture.js";

const staged: StagedPreparation[] = [];
afterEach(async () => { await Promise.all(staged.splice(0).map(run => run.cleanup())); });

describe("failed leg facts survive into the operator read path", () => {
  it.each([
    ["provider-grant-missing", "provider grant store is unavailable"],
    ["pack-input-list-length-mismatch", "list fields do not agree on length"],
  ])("retains %s and its detail", async (problem, problemDetail) => {
    const run = await stagePreparation();
    staged.push(run);
    const result = await executePhaseAttempt(attemptRequest(run, {
      leg: async () => ({ ...succeededLeg(), phaseState: "failed", problem, problemDetail }),
    }));
    expect(result.status).toBe("committed");
    const shown = await showPreparationOperation(run.root, { runId: run.binding.runId });
    expect(shown.status, JSON.stringify(shown)).toBe("shown");
    if (shown.status !== "shown") throw new Error("show refused");
    expect(shown.run.phases.find(phase => phase.logicalPhaseId === "collect"))
      .toMatchObject({ state: "failed", problem, problemDetail });
  });
});
