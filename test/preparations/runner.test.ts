/**
 * @file test/preparations/runner.test.ts
 * @description The host orchestration coordinator (runner design v3 §10):
 * drives one single-phase staged plan through attempt, materialization,
 * finalization, and the handoff seam; refuses materializer contract drift
 * before any leg runs; and proves the restart path consults ONLY persisted
 * evidence — the materializer is removed from wiring entirely and the second
 * invocation reproduces the first's terminal outcome.
 *
 * The compile-time control at the bottom is the acceptance case the design
 * calls structural: a behavioural case cannot observe an argument nobody
 * passes, so the entry signature itself is pinned against obligation material.
 */

import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseSha256Digest } from "../../src/capability-providers/ids.js";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { executePhaseAttempt } from "../../src/preparations/attempts/execute.js";
import { finalizePreparationForHandoff } from "../../src/preparations/finalization.js";
import { derivePhaseInstanceId, singleExpansionIdentity } from "../../src/preparations/ids.js";
import { captureMaterializationResult } from "../../src/preparations/materialization.js";
import { readPreparationEvidenceBytes } from "../../src/preparations/evidence-store.js";
import {
  classifyMaterializationManifests, parseMaterializationManifest,
} from "../../src/preparations/materialization.js";
import {
  runPreparation, runPreparationWithFaults, type PreparationMaterializerV1, type RunPreparationInputV1,
} from "../../src/preparations/runner.js";
import { readPreparationRun } from "../../src/preparations/run-store.js";
import { FIXTURE_PAYLOAD as PAYLOAD, FIXTURE_PAYLOAD_DIGEST as PAYLOAD_DIGEST, declareMaterializationCapacity, materializedResultCandidate } from "./materialization-fixture.js";
import { fixturePlan } from "./store-fixture.js";
import { PIN, fixedResolver, stagePreparation, succeededLeg, type StagedPreparation } from "./attempt-fixture.js";

/** One single-phase runner-managed plan, funded for its own finalization. */
function singlePhasePlan() {
  return fixturePlan((plan) => {
    const phases = plan.phases as Array<Record<string, unknown>>;
    plan.phases = [phases[0]];
    (plan.outputContract as Record<string, unknown>).producingPhaseIds = ["collect"];
    declareMaterializationCapacity(plan);
  });
}

/** A leg that persists one durable evidence object the bundle must depend on. */
function evidenceWritingLeg(staged: StagedPreparation): () => Promise<ReturnType<typeof succeededLeg>> {
  return async () => {
    const tempPath = path.join(os.tmpdir(), `leg-evidence-${staged.binding.runId}`);
    await writeFile(tempPath, PAYLOAD);
    return { ...succeededLeg(), pendingEvidence: [{ tempPath, ref: {
      kind: "provider-output", mediaType: "application/json", provenanceLabel: "draft",
      digest: parseSha256Digest(`sha256:${PAYLOAD_DIGEST}`), byteCount: PAYLOAD.byteLength,
      sensitivity: "ordinary", retention: "until-handoff",
      producer: { kind: "provider", providerPinDigest: parseSha256Digest(PIN), attemptId: "att-1" },
      untrusted: true,
    } }] };
  };
}

/** A real materializer deriving its payload FROM the supplied durable bytes. */
function materializer(): PreparationMaterializerV1 {
  return {
    handlerContractDigest: parseSha256Digest(PIN),
    materialize: ({ evidence }) => {
      const result = materializedResultCandidate(evidence);
      const refs = result.payloadRefs as Array<{ digest: string }>;
      const bytes = evidence.get(refs[0].digest);
      if (bytes === undefined) throw new Error("payload bytes missing from durable evidence");
      return { result, payloads: new Map([[refs[0].digest, bytes]]) };
    },
  };
}

/** A materializer that must never be consulted — the restart control. */
function poisonedMaterializer(): PreparationMaterializerV1 {
  return {
    handlerContractDigest: parseSha256Digest(PIN),
    materialize: () => { throw new Error("materializer consulted on the restart path"); },
  };
}

/** The full runner input over one staged run; capabilities and identity only. */
function runnerInput(staged: StagedPreparation, overrides: Partial<RunPreparationInputV1> = {}): RunPreparationInputV1 {
  let tick = 0;
  return {
    root: staged.root, binding: staged.binding, materializer: materializer(),
    legFor: () => evidenceWritingLeg(staged), authorityResolver: fixedResolver(),
    adapters: new Map() as RunPreparationInputV1["adapters"],
    policyContract: {
      handlerId: "runner-fixture", handlerContractVersion: "1.0.0", handlerContractDigest: PIN,
      exclusionReasonCodes: [], reconciliationReasonCodes: [], proposalKinds: [],
    } as unknown as RunPreparationInputV1["policyContract"],
    principal: { id: "operator", surface: "cli" },
    operationPrincipal: { id: "operator", surface: "cli", grants: ["operation-bundle.approve"] },
    handlerContractDigest: parseSha256Digest(PIN),
    clock: { now: () => new Date(Date.UTC(2026, 6, 21, 1, 0, tick++)).toISOString() },
    ...overrides,
  };
}

let staged: StagedPreparation;
beforeEach(async () => { staged = await stagePreparation(singlePhasePlan()); });
afterEach(() => staged.cleanup());

describe("runPreparation", () => {
  it("resumes persisted finalization after an injected host crash", async () => {
    await expect(runPreparationWithFaults(runnerInput(staged), {
      afterFinalized: async () => { throw new Error("host-crash"); },
    })).rejects.toThrow("host-crash");
    const read = await readPreparationRun(staged.root, staged.binding);
    expect(read.status === "ok" && read.run.state).toBe("handoff-ready");
    expect((await runPreparation(runnerInput(staged))).status).toBe("handed-off");
  });
  it("drives one staged plan through attempt, finalization, and the handoff seam", async () => {
    const result = await runPreparation(runnerInput(staged));

    const read = await readPreparationRun(staged.root, staged.binding);
    if (read.status === "ok") expect(read.run.state).toBe("handed-off");
    expect(result.status).toBe("handed-off");
    if (result.status === "handed-off") expect(result.bundleManifestDigest).toMatch(/^sha256:/);
  });

  it("refuses materializer contract drift before any leg runs", async () => {
    const leg = vi.fn(async () => succeededLeg());
    const drifted = { ...materializer(), handlerContractDigest: `sha256:${"d".repeat(64)}` as never };
    const result = await runPreparation(runnerInput(staged, { materializer: drifted, legFor: () => leg }));

    expect(result).toMatchObject({ status: "refused", reason: expect.stringContaining("contract") });
    expect(leg).not.toHaveBeenCalled();
  });

  it("refuses a plan without the declared materialization limits before any leg runs", async () => {
    const undeclared = await stagePreparation(fixturePlan((plan) => {
      const phases = plan.phases as Array<Record<string, unknown>>;
      plan.phases = [phases[0]];
      (plan.outputContract as Record<string, unknown>).producingPhaseIds = ["collect"];
    }));
    try {
      const leg = vi.fn(async () => succeededLeg());
      const result = await runPreparation(runnerInput(undeclared, { legFor: () => leg }));

      expect(result).toMatchObject({ status: "refused", reason: expect.stringContaining("materialization limits") });
      expect(leg).not.toHaveBeenCalled();
    } finally {
      await undeclared.cleanup();
    }
  });

  it("re-invoking a handed-off run reports the recorded outcome, materializer unconsulted", async () => {
    const first = await runPreparation(runnerInput(staged));
    expect(first.status).toBe("handed-off");
    const poisoned = poisonedMaterializer();
    const consulted = vi.spyOn(poisoned, "materialize");

    const second = await runPreparation(runnerInput(staged, { materializer: poisoned }));

    expect(consulted).not.toHaveBeenCalled();
    expect(second).toEqual(first);
  });

  it("hands off from handoff-ready via persisted evidence with the materializer unwired", async () => {
    // Reach handoff-ready WITHOUT crossing the handoff seam: drive and
    // finalize through the real materializer, then hand the second invocation
    // a poisoned one. Reconstruction must complete the handoff from persisted
    // evidence alone (design §3.4's restart promise, under the same installed
    // contract and adapters).
    const outcome = await executePhaseAttempt({
      root: staged.root, binding: staged.binding,
      phaseInstanceId: derivePhaseInstanceId({ manifestDigest: staged.binding.manifestDigest,
        logicalPhaseId: "collect", expansionIdentity: singleExpansionIdentity() }),
      logicalPhaseId: "collect", attemptIndex: 0, authorityResolver: fixedResolver(),
      leg: evidenceWritingLeg(staged), principal: { id: "operator", surface: "cli" },
      clock: { now: () => "2026-07-21T00:59:58.000Z" },
    });
    expect(outcome.status).toBe("committed");
    const produced = materializer().materialize({ run: undefined as never, evidence: new Map([[PAYLOAD_DIGEST, PAYLOAD]]) });
    const finalized = await finalizePreparationForHandoff({
      root: staged.root, binding: staged.binding,
      result: captureMaterializationResult(produced.result),
      operationPrincipal: { id: "operator", surface: "cli", grants: ["operation-bundle.approve"] },
      handlerContractDigest: parseSha256Digest(PIN), payloads: produced.payloads,
      principal: { id: "operator", surface: "cli" }, at: "2026-07-21T00:59:59.000Z",
    });
    expect(finalized.status).toBe("finalized");

    const poisoned = poisonedMaterializer();
    const consulted = vi.spyOn(poisoned, "materialize");
    const result = await runPreparation(runnerInput(staged, { materializer: poisoned }));

    expect(consulted).not.toHaveBeenCalled();
    expect(result.status).toBe("handed-off");
  });
});

  it("restarts with NO materializer supplied at all", async () => {
    // Review probe: the previous "unwired" case supplied a poisoned but
    // present materializer; genuine omission threw at the contract check.
    const first = await runPreparation(runnerInput(staged));
    expect(first.status).toBe("handed-off");

    const { materializer: _omitted, ...rest } = runnerInput(staged);
    const second = await runPreparation(rest);
    expect(second).toEqual(first);
  });

  it("captures callables and principals before the first await", async () => {
    // Review probes: a method swapped or a principal mutated immediately
    // after invocation must not reach durable state.
    const input = runnerInput(staged);
    const pending = runPreparation(input);
    (input.materializer as { materialize: unknown }).materialize =
      () => { throw new Error("swapped-in materializer ran"); };
    (input.operationPrincipal as { id: string }).id = "substituted-actor";
    // Round-4 sibling probe: the resolver object's method, swapped mid-flight.
    (input.authorityResolver as { resolve: unknown }).resolve =
      async () => ({ status: "drift" });
    const result = await pending;
    expect(result.status).toBe("handed-off");

    // The persisted manifest must record the ORIGINAL actor.
    const read = await readPreparationRun(staged.root, staged.binding);
    if (read.status !== "ok") throw new Error("run unreadable");
    const classified = classifyMaterializationManifests(read.run.evidenceRefs);
    if (classified.status !== "one") throw new Error("expected one manifest");
    const bare = classified.ref.digest.slice("sha256:".length);
    const bytes = await readPreparationEvidenceBytes(staged.root,
      { workspaceId: staged.binding.workspaceId, preparationId: staged.binding.preparationId }, bare, 65_536);
    if (bytes.status !== "ok") throw new Error(`manifest ${bytes.status}`);
    expect(parseMaterializationManifest(bytes.bytes).actor.id).toBe("operator");
  });

  it("resolves the leg per phase from the supplier, not one shared leg", async () => {
    // Unit A: the runner must call legFor(logicalPhaseId) for the driven phase,
    // so a supplier that keys on the phase id is consulted with that id — a
    // single shared leg could never carry heterogeneous executor kinds.
    const asked: string[] = [];
    const legFor = (logicalPhaseId: string) => {
      asked.push(logicalPhaseId);
      return evidenceWritingLeg(staged);
    };
    const result = await runPreparation(runnerInput(staged, { legFor }));

    expect(result.status).toBe("handed-off");
    expect(asked).toContain("collect");
  });

// The structural acceptance case: the entry signature carries no obligation
// material, checked at COMPILE time — a runtime case cannot observe an
// argument nobody passes.
type ForbiddenEntryKeys = "obligations" | "targets" | "proposals" | "authorities" | "completeness" | "payloadRefs";
type EntryKeyLeak = Extract<keyof RunPreparationInputV1, ForbiddenEntryKeys>;
const entrySignatureCarriesNoObligationMaterial: EntryKeyLeak extends never ? true : never = true;
void entrySignatureCarriesNoObligationMaterial;
