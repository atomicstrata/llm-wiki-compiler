/**
 * @file test/storage/connector-stage-binding.test.ts
 * @description Connector replacement staging as ONE body over its three steps,
 * `stageConnectorCandidateWith`, with no project directory: the receipt batch
 * captured first, every retained predecessor re-proved BEFORE staging, the exact
 * staging request, and what a failure means (recovery-required is returned,
 * anything else rethrows the staging error). The bound composition
 * (`connectorStageStepsOver`) is shown running the lower root-free bodies, and
 * the root form reaching the incumbents.
 *
 * NOT SHOWN HERE: custody observation, staging and restoration themselves; the
 * candidate-custody, staging, supersession and connector-run suites show those.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import * as candidateCustody from "../../src/compiler/candidate-custody.js";
import type { CandidateCustodyReceipt, CandidateCustodyState, CandidateStoreMoveReads } from "../../src/compiler/candidate-custody.js";
import { ConnectorCandidateBatchOverflowError } from "../../src/connectors/candidate-batch.js";
import * as supersession from "../../src/connectors/candidate-supersession.js";
import type { CandidateMovePort, CandidateSupersessionResult } from "../../src/connectors/candidate-supersession.js";
import {
  connectorStageStepsOver, stageConnectorCandidate, stageConnectorCandidateWith,
  type ConnectorStageRequest, type ConnectorStageSteps,
} from "../../src/connectors/stage-candidate.js";
import type { ProfilePack } from "../../src/profile/types.js";
import type { StagedChange } from "../../src/trust/staged-change.js";
import * as staging from "../../src/trust/staging.js";
import type { EntityPageStagingSteps } from "../../src/trust/staging.js";

afterEach(() => { vi.restoreAllMocks(); });

/** One inert receipt; the steps here are scripted, so nothing reads it. */
const receipt = (index: number): CandidateCustodyReceipt => ({
  fileId: `candidate-${index}`, byteCount: 1, sha256: "a".repeat(64), fileIdentity: { dev: 1, ino: index + 1 }, storeIdentity: { dev: 1, ino: 1 },
});
const PROFILE = { profileId: "fixture" } as unknown as ProfilePack;
const NOW = () => new Date("2026-01-01T00:00:00.000Z");
const MOVER = { move: async () => true } as unknown as CandidateMovePort;
const DRAFT = {
  entityType: "papers", slug: "replacement", body: "---\ntitle: Replacement\n---\nBody\n",
  provenance: { connectorId: "fixture", connectorVersion: "1" } as never,
};
const CHANGE = { id: "staged-1" } as unknown as StagedChange;
const request = (receipts: CandidateCustodyReceipt[]): ConnectorStageRequest =>
  ({ draft: DRAFT, profile: PROFILE, archivedReceipts: receipts, mover: MOVER, now: NOW, policy: "bounded" });

/** Scripted steps: each predecessor answers `state`; staging answers or throws `stageFault`; restoration answers `restored`. */
function stepsOf(log: string[], answers: { state?: CandidateCustodyState; stageFault?: Error; restored?: CandidateSupersessionResult } = {}): ConnectorStageSteps {
  return {
    observeCustody: async (given, policy) => { log.push(`observe ${given.fileId} ${policy}`); return answers.state ?? "archived"; },
    stage: async () => { log.push("stage"); if (answers.stageFault) throw answers.stageFault; return CHANGE; },
    restore: async (receipts, mover, policy) => {
      log.push(`restore ${receipts.map((given) => given.fileId).join(",")} ${mover === MOVER} ${policy}`);
      return answers.restored ?? { kind: "failed-and-restored" };
    },
  };
}

describe("connector staging over its three steps", () => {
  it("C1 re-proves each predecessor in order, then stages the exact connector request", async () => {
    const log: string[] = [];
    const steps = stepsOf(log);
    const stage = vi.spyOn(steps, "stage");
    expect(await stageConnectorCandidateWith(steps, request([receipt(0), receipt(1)]))).toEqual({ kind: "staged", change: CHANGE });
    expect(log).toEqual(["observe candidate-0 bounded", "observe candidate-1 bounded", "stage"]);
    expect(stage.mock.calls).toEqual([[{
      entityType: "papers", slug: "replacement", body: DRAFT.body, profile: PROFILE, existingStagedCount: 0, now: NOW,
      reviewMode: "connector", heldReasons: [{ code: "connector-fetched" }], connectorProvenance: DRAFT.provenance, freshCandidateId: true,
    }]]);
    const fresh = stepsOf([]);
    const freshStage = vi.spyOn(fresh, "stage");
    await stageConnectorCandidateWith(fresh, request([]));
    expect(freshStage.mock.calls[0]?.[0].freshCandidateId).toBe(false);
  });

  it("C2 a predecessor that is not archived refuses before staging, after restoring every captured receipt", async () => {
    const log: string[] = [];
    await expect(stageConnectorCandidateWith(stepsOf(log, { state: "restored" }), request([receipt(0), receipt(1)])))
      .rejects.toBeInstanceOf(candidateCustody.CandidateCustodyUnavailableError);
    expect(log).toEqual(["observe candidate-0 bounded", "restore candidate-0,candidate-1 true bounded"]);
  });

  it("C3 a staging failure rethrows unless restoration reports recovery-required, which is returned", async () => {
    const fault = new Error("staging failed");
    const log: string[] = [];
    await expect(stageConnectorCandidateWith(stepsOf(log, { stageFault: fault }), request([receipt(0)]))).rejects.toBe(fault);
    expect(log).toEqual(["observe candidate-0 bounded", "stage", "restore candidate-0 true bounded"]);
    const stuck: CandidateSupersessionResult = { kind: "recovery-required", candidateIds: ["candidate-0"] };
    expect(await stageConnectorCandidateWith(stepsOf([], { stageFault: fault, restored: stuck }), request([receipt(0)]))).toEqual(stuck);
  });

  it("C4 an oversized receipt batch refuses before any step, with nothing to restore", async () => {
    const log: string[] = [];
    const receipts = Array.from({ length: 201 }, (_, index) => receipt(index));
    await expect(stageConnectorCandidateWith(stepsOf(log), request(receipts))).rejects.toBeInstanceOf(ConnectorCandidateBatchOverflowError);
    expect(log).toEqual([]);
  });
});

describe("the bound composition and the root form", () => {
  it("O1 the composition runs custody observation, staging and restoration over their own root-free bodies", async () => {
    const observe = vi.spyOn(candidateCustody, "observeCandidateCustodyFrom").mockResolvedValue("archived");
    const stageWith = vi.spyOn(staging, "stageEntityPageWith").mockRejectedValue(new Error("staging failed"));
    const restoreFrom = vi.spyOn(supersession, "restoreArchivedCandidatesFrom").mockResolvedValue({ kind: "failed-and-restored" });
    const seams = { custody: {} as CandidateStoreMoveReads, staging: {} as EntityPageStagingSteps, moveRoot: "/host/selected" };
    await expect(stageConnectorCandidateWith(connectorStageStepsOver(seams), request([receipt(0)]))).rejects.toThrow("staging failed");
    expect(observe.mock.calls).toEqual([[seams.custody, receipt(0), "bounded"]]);
    expect(stageWith.mock.calls[0]?.[0]).toBe(seams.staging);
    expect(restoreFrom.mock.calls).toEqual([[seams.custody, "/host/selected", [receipt(0)], MOVER, "bounded"]]);
  });

  it("Z1 the bound route reaches no incumbent, while the root form reaches each with its root first", async () => {
    const spies = {
      observe: vi.spyOn(candidateCustody, "observeCandidateCustody").mockResolvedValue("archived"),
      stage: vi.spyOn(staging, "stageEntityPage").mockRejectedValue(new Error("staging failed")),
      restore: vi.spyOn(supersession, "restoreArchivedCandidates").mockResolvedValue({ kind: "failed-and-restored" }),
    };
    await expect(stageConnectorCandidateWith(stepsOf([], { stageFault: new Error("x") }), request([receipt(0)]))).rejects.toThrow("x");
    expect(Object.values(spies).map((spy) => spy.mock.calls.length)).toEqual([0, 0, 0]);
    await expect(stageConnectorCandidate("/project", DRAFT, PROFILE, [receipt(0)], MOVER, NOW, undefined, "public")).rejects.toThrow("staging failed");
    expect(spies.observe.mock.calls).toEqual([["/project", receipt(0), "public"]]);
    expect(spies.stage.mock.calls[0]?.[0]).toBe("/project");
    expect(spies.restore.mock.calls).toEqual([["/project", [receipt(0)], MOVER, "public"]]);
  });
});
