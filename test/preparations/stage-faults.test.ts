/**
 * @file test/preparations/stage-faults.test.ts
 * @description Crash-safety contract for the staging creation order: a fault
 * injected after the evidence fsync, after the manifest publication, and before
 * the initial-run write each leaves an inert orphan pair, and a fixed-id replay
 * (same clock, same identities) completes the preparation idempotently with the
 * run authenticating as `planned`.
 */

import { describe, expect, it } from "vitest";
import { useTempRoot } from "../fixtures/temp-root.js";
import { stagePreparationLocked, type StageFaultsForTest } from "../../src/preparations/stage.js";
import { fixturePlan, readReplayedRun, stageRequest } from "./store-fixture.js";
import type { PreparationId, PreparationRunId } from "../../src/preparations/ids.js";

const root = useTempRoot();
const IDS = { preparationId: `prp_${"a".repeat(32)}` as PreparationId, runId: `prr_${"b".repeat(32)}` as PreparationRunId };
const CLOCK = { now: () => new Date("2026-07-20T00:00:00.000Z") };

/** Stage with a crash fault, then replay to completion and read the run. */
async function crashThenReplay(faults: StageFaultsForTest) {
  const request = stageRequest(fixturePlan(), { idsForTest: IDS, clock: CLOCK, faultsForTest: faults });
  await expect(stagePreparationLocked(root.dir, request)).rejects.toThrow();
  const replay = await stagePreparationLocked(root.dir, stageRequest(fixturePlan(), { idsForTest: IDS, clock: CLOCK }));
  if (replay.status !== "staged") throw new Error("replay did not stage");
  const run = await readReplayedRun(root.dir, replay.manifest, IDS);
  return { replay, run };
}

describe("preparation staging crash recovery", () => {
  it("completes idempotently after a fault following the evidence fsync", async () => {
    const { replay, run } = await crashThenReplay({ afterEvidenceSync: async () => { throw new Error("crash after evidence"); } });
    expect(replay.wrote).toBe(true);
    expect(run.status === "ok" && run.run.state).toBe("planned");
  });

  it("completes idempotently after a fault following the manifest publication", async () => {
    const { replay, run } = await crashThenReplay({ afterManifestSync: async () => { throw new Error("crash after manifest"); } });
    expect(replay.wrote).toBe(true);
    expect(run.status === "ok" && run.run.state).toBe("planned");
  });

  it("completes idempotently after a fault before the initial-run write", async () => {
    const { replay, run } = await crashThenReplay({ beforeInitialRunSync: async () => { throw new Error("crash before run"); } });
    expect(replay.wrote).toBe(true);
    expect(run.status === "ok" && run.run.state).toBe("planned");
  });
});
