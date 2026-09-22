/**
 * @file test/preparations/abandonment.test.ts
 * @description The valid-run abandonment contract (design section 25.1). A
 * valid-HMAC `recovery-required` run terminates as `abandoned` only under explicit
 * residual-state confirmation, with residual findings recomputed from durable
 * state; every other durable read or a missing confirmation fails closed without a
 * transition, and the recompute understates nothing.
 */

import { describe, expect, it } from "vitest";
import { useTempRoot } from "../fixtures/temp-root.js";
import {
  abandonPreparationRunLocked, deriveResidualFindings, PreparationAbandonmentError,
} from "../../src/preparations/abandonment.js";
import { readPreparationRun } from "../../src/preparations/run-store.js";
import type { PreparationRunV1 } from "../../src/preparations/run-types.js";
import { driveToRecoveryRequired, LIFECYCLE_ACTOR, stagePreparation, tamperRun } from "./lifecycle-fixture.js";

const AT = "2026-07-20T01:00:00.000Z";
const abandon = (root: string, binding: Parameters<typeof abandonPreparationRunLocked>[1]["binding"], confirmResidualState = true) =>
  abandonPreparationRunLocked(root, { binding, actor: LIFECYCLE_ACTOR, at: AT, confirmResidualState });

describe("valid-run abandonment", () => {
  const root = useTempRoot();

  it("terminates a confirmed recovery-required run as abandoned", async () => {
    const { binding } = await stagePreparation(root.dir);
    await driveToRecoveryRequired(root.dir, binding);
    const run = await abandon(root.dir, binding);
    expect(run.state).toBe("abandoned");
    const read = await readPreparationRun(root.dir, binding);
    expect(read.status === "ok" && read.run.state).toBe("abandoned");
  });

  it("fails closed without explicit residual-state confirmation", async () => {
    const { binding } = await stagePreparation(root.dir);
    await driveToRecoveryRequired(root.dir, binding);
    await expect(abandon(root.dir, binding, false)).rejects.toMatchObject({ code: "confirmation-required" });
    expect((await readPreparationRun(root.dir, binding)).status === "ok").toBe(true);
    const read = await readPreparationRun(root.dir, binding);
    expect(read.status === "ok" && read.run.state).toBe("recovery-required");
  });

  it("refuses to abandon a run that is not recovery-required", async () => {
    const { binding } = await stagePreparation(root.dir);
    await expect(abandon(root.dir, binding)).rejects.toMatchObject({ code: "not-recovery-required" });
  });

  it("refuses to abandon an integrity-invalid run", async () => {
    const { binding } = await stagePreparation(root.dir);
    await driveToRecoveryRequired(root.dir, binding);
    await tamperRun(root.dir, binding);
    await expect(abandon(root.dir, binding)).rejects.toBeInstanceOf(PreparationAbandonmentError);
    await expect(abandon(root.dir, binding)).rejects.toMatchObject({ code: "run-unavailable" });
  });
});

describe("residual finding recompute", () => {
  it("recomputes every unsettled phase, checkpoint, effect, and broker obligation", () => {
    const run = {
      transitions: [], handoff: undefined,
      phaseSummaries: [{ state: "running", phaseInstanceId: `phi_${"a".repeat(64)}`, checkpointDigest: `sha256:${"b".repeat(64)}` }],
      effectSummaries: [{ outcome: "started" }, { outcome: "applied" }],
      brokerRequestSummaries: [{ state: "started" }, { state: "settled" }],
    } as unknown as PreparationRunV1;
    const codes = deriveResidualFindings(run).map((finding) => finding.code);
    expect(codes).toContain("unresolved-phase");
    expect(codes).toContain("unresolved-checkpoint");
    expect(codes).toContain("unresolved-effect-started");
    expect(codes).toContain("unresolved-broker-started");
    expect(codes).not.toContain("unresolved-effect-applied");
  });
});
