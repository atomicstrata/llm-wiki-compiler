/**
 * @file test/preparations/pack-journeys.test.ts
 * @description The Chunk 3 pack journeys (unit I) — TWO deliberately DISSIMILAR
 * packs driven end to end through the ONE unchanged `runPreparation`, which is
 * how genericity is proven (design v3 §1, PO-INV-40). The RESEARCH pack fans out
 * over a map and gates once (collect → expand[MAP] → review[GATE] → assemble),
 * exercising units A (leg dispatch), B (fan-out), C (gate lifecycle), and D
 * (readiness order); it also discharges review finding R-1 — an overflow past the
 * map cap is a completeness deficit the materializer derives from the full source
 * evidence the runner supplies. The EDITORIAL pack is linear with an OPTIONAL
 * render phase and a review-selection gate (draft → render → approve[GATE] →
 * publish), unit E's optional rendering. The two share no graph, gate kind,
 * vocabulary, or completeness class — only the runner and the leg/input harness.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { rm } from "node:fs/promises";
import path from "node:path";
import { runPreparation } from "../../src/index.js";
import type { PreparationMaterializerV1 } from "../../src/preparations/runner.js";
import { readPreparationRun } from "../../src/preparations/run-store.js";
import { scanOperationInventory } from "../../src/operation-bundles/capacity.js";
import { parseSha256Digest } from "../../src/capability-providers/ids.js";
import type { AttemptLegOutcomeV1 } from "../../src/preparations/attempts/types.js";
import { stagePreparation, stagePreparationIn, type StagedPreparation } from "./attempt-fixture.js";
import { adapters as fullAdapters, contract as fullContract } from "./task7-fixture.js";
import { fullMaterialization } from "./handoff-fixture.js";
import {
  JOURNEY_DIGEST, decideGate, evidenceLeg, failingLeg, journeyInput, journeyMaterializer, journeyPlan,
  optionalClassRecord, resumeThroughGate, tryDecideGate,
} from "./journey-fixture.js";

/** Whether any instance of a logical phase settled `succeeded`. */
async function phaseSucceeded(staged: StagedPreparation, logicalPhaseId: string): Promise<boolean> {
  const read = await readPreparationRun(staged.root, staged.binding);
  return read.status === "ok"
    && read.run.phaseSummaries.some((s) => s.logicalPhaseId === logicalPhaseId && s.state === "succeeded");
}

// ── Research pack: a map fan-out gated once ─────────────────────────────────

/**
 * collect (provider) → expand (host-handler MAP over the collected items) →
 * screen (single, aggregates the fan-out) → review (GATE over screen) → assemble
 * (host-handler, producing). The gate reads `screen`, NOT the map: a gate must
 * bind a SINGLE authoritative output, not one arbitrary fan-out instance. The
 * base fixture's trailing `join` role is replaced by executed work phases.
 */
function researchPlan() {
  return journeyPlan((object) => {
    const phases = object.phases as Record<string, unknown>[];
    const bounds = phases[1].bounds;
    const work = (logicalPhaseId: string, dependsOn: string[], source: string) => ({
      logicalPhaseId, role: "work", dependsOn, disposition: "required",
      executor: { kind: "host-handler", handlerId: `${logicalPhaseId}er`, handlerContractVersion: "1", handlerContractDigest: JOURNEY_DIGEST },
      inputBindings: [{ bindingId: `${logicalPhaseId}-in`, sourceKind: "phase-output", sourcePhaseId: source }],
      expansion: { kind: "single" }, bounds,
    });
    object.phases = [phases[0], phases[1],
      work("screen", ["expand"], "expand"),
      { logicalPhaseId: "review", role: "gate", dependsOn: ["screen"], disposition: "required",
        gate: { gateId: "review", gateKind: "review-preparation" },
        inputBindings: [{ bindingId: "reviewed", sourceKind: "phase-output", sourcePhaseId: "screen" }],
        expansion: { kind: "single" }, bounds },
      work("assemble", ["review"], "screen"),
    ];
    (object.outputContract as Record<string, unknown>).producingPhaseIds = ["assemble"];
    Object.assign(object.bounds as Record<string, number>, {
      maximumPhaseInstances: 16, maximumAttempts: 32, maximumInvocations: 32, maximumTransitions: 96,
      maximumEvidenceRefs: 48, maximumEvidenceBytes: 524_288, maximumTokens: 3200, maximumTimeMs: 32_000,
      maximumCostMicros: 320,
    });
  });
}

/** Per-phase legs: collect emits the item list the map fans over; the rest emit a draft. */
function researchLegFor(runId: string, items: readonly unknown[]): (logicalPhaseId: string) => () => Promise<AttemptLegOutcomeV1> {
  const collected = Buffer.from(JSON.stringify(items));
  const draft = Buffer.from(JSON.stringify({ draft: "unit" }));
  return (logicalPhaseId) =>
    logicalPhaseId === "collect" ? evidenceLeg(runId, "collect", collected) : evidenceLeg(runId, logicalPhaseId, draft);
}

/** What the materializer derived, so a test can assert the deficit end to end. */
interface CompletenessProbe { planned: number; overflow: number; }

/** The count of collected source items, read back from the durable evidence the runner supplied. */
function sourceItemCount(evidence: ReadonlyMap<string, Buffer>): number {
  for (const bytes of evidence.values()) {
    try {
      const value: unknown = JSON.parse(bytes.toString("utf8"));
      if (Array.isArray(value)) return value.length;
    } catch { /* not the item list */ }
  }
  return 0;
}

/**
 * Derives completeness from the FULL source evidence — the count of collected
 * items the runner handed it — not from the number of map instances that ran.
 * This is R-1: the runner supplies every evidence object, so an overflow past the
 * cap is derivable at materialization.
 */
function researchMaterializer(probe: CompletenessProbe): PreparationMaterializerV1 {
  return journeyMaterializer(({ evidence }) => {
    const planned = sourceItemCount(evidence);
    const included = Math.min(planned, 4);
    probe.planned = planned; probe.overflow = planned - included;
    const ids = (count: number) => Array.from({ length: count }, (_, index) => `s${index}`);
    return { targetIdentity: "docs/a", completeness: optionalClassRecord("screened-sources", ids(planned), ids(included), "overflow") };
  });
}

function researchInput(
  staged: StagedPreparation, items: readonly unknown[], opts: { probe?: CompletenessProbe } = {},
) {
  return journeyInput(staged, {
    legFor: researchLegFor(staged.binding.runId, items),
    materializer: researchMaterializer(opts.probe ?? { planned: 0, overflow: 0 }),
    decodeExpansionItems: (_id, evidence) => JSON.parse(evidence.toString("utf8")) as unknown[],
  });
}

describe("research-pack journey", () => {
  let staged: StagedPreparation;
  beforeEach(async () => { staged = await stagePreparation(researchPlan()); });
  afterEach(() => staged.cleanup());

  it("suspends at the review gate after collect and the expand fan-out", async () => {
    const first = await runPreparation(researchInput(staged, [{ id: "s0" }, { id: "s1" }, { id: "s2" }]));
    expect(first.status).toBe("suspended-at-gate");
  });

  it("resumes and hands off once the review gate is approved", async () => {
    const result = await resumeThroughGate(staged, researchInput(staged, [{ id: "s0" }, { id: "s1" }, { id: "s2" }]), "review");
    expect(result.status, "reason" in result ? result.reason : "").toBe("handed-off");
  });

  it("discharges R-1: an overflow past the map cap is a deficit derived from the runner-supplied evidence", async () => {
    const items = Array.from({ length: 6 }, (_, index) => ({ id: `s${index}` }));
    const probe: CompletenessProbe = { planned: 0, overflow: 0 };
    const result = await resumeThroughGate(staged, researchInput(staged, items, { probe }), "review");

    expect(result.status, "reason" in result ? result.reason : "").toBe("handed-off");
    expect(probe.planned).toBe(6); // the materializer saw ALL six collected items, not just the four driven
    expect(probe.overflow).toBe(2); // two past the cap → a real completeness deficit, derivable end to end
  });

  it("hands off a FULL seven-kind Milestone A obligation with reconciliation, and the bundle outlives the preparation (blocker #5)", async () => {
    // The materializer emits the complete obligation — page target + payload, an
    // entity-fact proposal, its accept reconciliation, selections, completeness —
    // compiled against a real contract. Reaching handed-off proves the whole
    // obligation (reconciliation included) compiled through the runner.
    const input = journeyInput(staged, {
      legFor: researchLegFor(staged.binding.runId, [{ id: "s0" }]),
      materializer: { handlerContractDigest: parseSha256Digest(JOURNEY_DIGEST), materialize: () => fullMaterialization("ada") },
      decodeExpansionItems: (_id, evidence) => JSON.parse(evidence.toString("utf8")) as unknown[],
      policyContract: fullContract, adapters: fullAdapters,
    });
    await runPreparation(input);
    await decideGate(staged, "review", "approved");
    const result = await runPreparation(input);
    expect(result.status, "reason" in result ? result.reason : "").toBe("handed-off");
    const before = await scanOperationInventory(staged.root);
    expect(before.problems).toHaveLength(0);
    expect(before.completeBundleIds.size).toBe(1);
    const bundleId = [...before.completeBundleIds][0]!;
    // The bundle actually CARRIES the reconciliation resolving the proposal — an empty
    // reconciliation set reddens here (and drops the bundle from completeBundleIds).
    expect(before.manifests[0]?.reconciliations.length ?? 0).toBeGreaterThan(0);
    // Self-contained: after the preparation's durable state is removed, the Milestone A
    // bundle is still COMPLETE and problem-free (a missing/uncopied payload would drop it).
    await rm(path.join(staged.root, "preparations"), { recursive: true, force: true });
    const after = await scanOperationInventory(staged.root);
    expect(after.problems).toHaveLength(0);
    expect(after.completeBundleIds.has(bundleId)).toBe(true);
  });

  it("refuses to decide a gate that reads a fanned-out phase, not just the first item (blocker #6)", async () => {
    // The base fixture gates `review` directly on the `expand` MAP. After fan-out
    // there are several `expand` summaries; the gate must refuse rather than bind
    // its proof to one arbitrary item the operator never reviewed as the whole.
    const staged2 = await stagePreparation(journeyPlan(() => {}));
    try {
      await runPreparation(researchInput(staged2, [{ id: "s0" }, { id: "s1" }])); // suspend at review over the fan-out
      const decided = await tryDecideGate(staged2, "review");
      expect(decided).toMatchObject({ status: "refused", reason: expect.stringContaining("fanned-out") });
    } finally { await staged2.cleanup(); }
  });

  it("does NOT resume past a gate whose LATEST decision is a rejection (blocker #2)", async () => {
    const input = researchInput(staged, [{ id: "s0" }, { id: "s1" }]);
    await runPreparation(input); // suspend at review
    await decideGate(staged, "review", "approved");
    await decideGate(staged, "review", "rejected"); // a later rejection must win
    const result = await runPreparation(input);
    expect(result.status).toBe("suspended-at-gate");
    expect(await phaseSucceeded(staged, "assemble")).toBe(false);
  });
});

// ── Editorial pack: linear, with an optional render phase ───────────────────

/**
 * draft (provider) → render (host-handler, OPTIONAL) → approve (review-selection
 * GATE) → publish (host-handler, producing), in its own workspace vocabulary.
 * Rebuilt entirely so it shares no graph with research.
 */
function editorialPlan() {
  return journeyPlan((object) => {
    const bounds = (object.phases as Record<string, unknown>[])[0].bounds;
    object.workspaceId = "editorial";
    object.phases = [
      { logicalPhaseId: "draft", role: "work", dependsOn: [], disposition: "required",
        executor: { kind: "provider-capability", providerPinDigest: JOURNEY_DIGEST, capabilityId: "compose", capabilityContractDigest: JOURNEY_DIGEST },
        inputBindings: [{ bindingId: "seed", sourceKind: "initial-input" }], expansion: { kind: "single" }, bounds },
      { logicalPhaseId: "render", role: "work", dependsOn: ["draft"], disposition: "optional",
        executor: { kind: "host-handler", handlerId: "renderer", handlerContractVersion: "1", handlerContractDigest: JOURNEY_DIGEST },
        inputBindings: [{ bindingId: "drafted", sourceKind: "phase-output", sourcePhaseId: "draft" }], expansion: { kind: "single" }, bounds },
      { logicalPhaseId: "approve", role: "gate", dependsOn: ["draft"], disposition: "required",
        gate: { gateId: "approve", gateKind: "review-selection" },
        inputBindings: [{ bindingId: "drafted", sourceKind: "phase-output", sourcePhaseId: "draft" }], expansion: { kind: "single" }, bounds },
      { logicalPhaseId: "publish", role: "work", dependsOn: ["approve", "render"], disposition: "required",
        executor: { kind: "host-handler", handlerId: "publisher", handlerContractVersion: "1", handlerContractDigest: JOURNEY_DIGEST },
        inputBindings: [{ bindingId: "drafted", sourceKind: "phase-output", sourcePhaseId: "draft" }], expansion: { kind: "single" }, bounds },
    ];
    const contract = object.outputContract as Record<string, unknown>;
    contract.producingPhaseIds = ["publish"];
    (contract.handoffCapacity as Record<string, unknown>).includedEvidenceClasses =
      [{ classId: "approve", maximumItems: 10, maximumItemBytes: 1_048_576, maximumAggregateBytes: 4_194_304 }];
  });
}

/** A well-formed prior bundle id the editorial edition can declare it supersedes (unit G). */
const SUPERSEDED_BUNDLE = "bnd_01J00000000000000000000000";

/**
 * The editorial input; an optional `supersedesBundleId` lets the materializer
 * declare a superseding local intent (unit G) the runner threads to the handoff.
 */
function editorialInput(staged: StagedPreparation, opts: { supersedesBundleId?: string; failPhase?: string } = {}) {
  const bytes = Buffer.from(JSON.stringify({ editorial: "unit" }));
  return journeyInput(staged, {
    legFor: (logicalPhaseId) =>
      logicalPhaseId === opts.failPhase ? failingLeg() : evidenceLeg(staged.binding.runId, logicalPhaseId, bytes),
    materializer: journeyMaterializer(({ run }) => {
      // Completeness reflects the OPTIONAL render's real outcome: rendered when it
      // succeeded, a skipped deficit when it did not — an optional deficit warns,
      // it does not block handoff.
      const rendered = run.phaseSummaries.some((s) => s.logicalPhaseId === "render"
        && (s.state === "succeeded" || s.state === "succeeded-with-warnings"));
      return {
        targetIdentity: "editions/a",
        completeness: optionalClassRecord("rendered", ["r0"], rendered ? ["r0"] : [], "skipped"),
        ...(opts.supersedesBundleId === undefined ? {} : { supersedesBundleId: opts.supersedesBundleId }),
      };
    }),
  });
}

describe("editorial-pack journey", () => {
  let staged: StagedPreparation;
  beforeEach(async () => { staged = await stagePreparation(editorialPlan()); });
  afterEach(() => staged.cleanup());

  it("suspends at the approve gate after draft and the optional render", async () => {
    const first = await runPreparation(editorialInput(staged));
    expect(first.status).toBe("suspended-at-gate");
  });

  it("resumes and hands off once the approve gate is approved", async () => {
    const result = await resumeThroughGate(staged, editorialInput(staged), "approve");
    expect(result.status, "reason" in result ? result.reason : "").toBe("handed-off");
  });

  it("returns a TYPED refusal (not a throw) when superseding an unknown bundle (unit G, blocker #7)", async () => {
    // The supersede id reaches bundle-graph validation — which happens ONLY if the
    // runner threaded it through to the handoff. An unknown predecessor is a data
    // refusal the runner surfaces as a result, never an escaping exception.
    const result = await resumeThroughGate(staged, editorialInput(staged, { supersedesBundleId: SUPERSEDED_BUNDLE }), "approve");
    expect(result).toMatchObject({ status: "refused", reason: expect.stringContaining("predecessor") });
  });

  it("completes a real supersession of a prior edition's bundle (unit G, blocker #7)", async () => {
    // First edition hands off, creating a bundle in the project inventory.
    const first = await resumeThroughGate(staged, editorialInput(staged), "approve");
    expect(first.status, "reason" in first ? first.reason : "").toBe("handed-off");
    const read = await readPreparationRun(staged.root, staged.binding);
    const priorBundleId = read.status === "ok" ? read.run.handoff?.bundleId : undefined;
    expect(priorBundleId).toBeDefined();
    // A second edition in the SAME project supersedes that real bundle, and hands off.
    const edition2 = await stagePreparationIn(staged.root, editorialPlan());
    const second = await resumeThroughGate(edition2, editorialInput(edition2, { supersedesBundleId: priorBundleId! }), "approve");
    expect(second.status, "reason" in second ? second.reason : "").toBe("handed-off");
  });

  it("does NOT run a dependent after a required predecessor failed (blocker #1)", async () => {
    // draft (required) commits FAILED — its output evidence is absent, but the
    // editorial legs ignore inputs, so without a durable-readiness guard `render`
    // would still run. It must not: a required predecessor that did not succeed
    // blocks its dependents.
    const result = await runPreparation(editorialInput(staged, { failPhase: "draft" }));
    expect(result.status).toBe("blocked");
    expect(await phaseSucceeded(staged, "render")).toBe(false);
  });

  it("hands off when the OPTIONAL render fails — it does not block (blocker #3)", async () => {
    // render (optional) fails, but approve/publish read draft (required), so the
    // run still reaches handoff. Were render `required`, this would block instead —
    // which is what makes the optionality real rather than declarative.
    const result = await resumeThroughGate(staged, editorialInput(staged, { failPhase: "render" }), "approve");
    expect(result.status, "reason" in result ? result.reason : "").toBe("handed-off");
    expect(await phaseSucceeded(staged, "render")).toBe(false);
    expect(await phaseSucceeded(staged, "publish")).toBe(true);
  });
});
