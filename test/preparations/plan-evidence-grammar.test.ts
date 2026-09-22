/**
 * @file test/preparations/plan-evidence-grammar.test.ts
 * @description The UNTRUSTED plan grammar enforces the same evidence-descriptor
 * invariants the compiler seals under (P4.2 review fix): a loaded plan is not
 * compiler output — it is a document from disk — so every state the compiler
 * refuses must ALSO refuse at `parsePreparationPlan`, or a hand-edited plan
 * reaches runtime carrying a shape no reviewer ever approved: a reserved
 * pathTableKey (the provider-input assembly would overwrite the sealed table
 * with the rendered request), BOTH evidence kinds on one executor (the
 * authority resolver would hash one builder's specs while the leg feeds the
 * other's), or aliased member columns (one input field claiming two roles).
 */

import { describe, expect, it } from "vitest";
import { parsePreparationPlan } from "../../src/preparations/plan-parse.js";
import { PreparationPlanError } from "../../src/preparations/problems.js";
import { syntheticResearchPack } from "../fixtures/preparations/synthetic-research-pack.js";
import { EVIDENCE_DESCRIPTOR } from "../fixtures/artifact-evidence-fixture.js";

/** A well-formed plan-side source-evidence descriptor, mutable per case. */
function sourceDescriptor(): Record<string, unknown> {
  return {
    pathsField: "paths", digestsField: "digests", byteCountsField: "byte-counts",
    inputIdPrefix: "source", kind: "source-evidence", provenanceLabel: "src-line",
    mediaType: "text/plain", maxItems: 4, maxBytes: 1024, pathTableKey: "sources",
  };
}

/** The synthetic plan with one phase's executor evidence fields overridden. */
function planWithPhaseEvidence(byIndex: ReadonlyMap<number, Record<string, unknown>>): string {
  const document = syntheticResearchPack.planDocument();
  const phases = document.phases as Array<{ executor: Record<string, unknown> }>;
  for (const [index, evidence] of byIndex) {
    phases[index]!.executor = { ...phases[index]!.executor, ...evidence };
  }
  return JSON.stringify(document);
}

/** The common one-phase case: the origin executor carries the evidence. */
function planWithExecutorEvidence(evidence: Record<string, unknown>): string {
  return planWithPhaseEvidence(new Map([[0, evidence]]));
}

describe("the plan grammar refuses what the compiler refuses (evidence descriptors)", () => {
  it("a well-formed artifact-evidence descriptor parses (the refusals below measure the guards, not the fixture)", () => {
    const plan = parsePreparationPlan(planWithExecutorEvidence({ artifactEvidenceDescriptor: { ...EVIDENCE_DESCRIPTOR } }));
    const executor = plan.phases[0]!.executor;
    expect(executor?.kind).toBe("provider-capability");
    if (executor?.kind !== "provider-capability") throw new Error("unreachable");
    expect(executor.artifactEvidenceDescriptor?.pathTableKey).toBe("members");
  });

  it("REFUSES a reserved pathTableKey on either evidence descriptor", () => {
    expect(() => parsePreparationPlan(planWithExecutorEvidence({
      artifactEvidenceDescriptor: { ...EVIDENCE_DESCRIPTOR, pathTableKey: "request" },
    }))).toThrow(PreparationPlanError);
    expect(() => parsePreparationPlan(planWithExecutorEvidence({
      sourceEvidenceDescriptor: { ...sourceDescriptor(), pathTableKey: "templateRef" },
    }))).toThrow(PreparationPlanError);
  });

  it("REFUSES both evidence kinds on one executor", () => {
    expect(() => parsePreparationPlan(planWithExecutorEvidence({
      artifactEvidenceDescriptor: { ...EVIDENCE_DESCRIPTOR },
      sourceEvidenceDescriptor: sourceDescriptor(),
    }))).toThrow(PreparationPlanError);
  });


  it("REFUSES the descriptor shapes the pack grammar refuses: zero caps and non-slug names", () => {
    expect(() => parsePreparationPlan(planWithExecutorEvidence({
      artifactEvidenceDescriptor: { ...EVIDENCE_DESCRIPTOR, maxItems: 0 },
    }))).toThrow(PreparationPlanError);
    expect(() => parsePreparationPlan(planWithExecutorEvidence({
      sourceEvidenceDescriptor: { ...sourceDescriptor(), maxBytes: 0 },
    }))).toThrow(PreparationPlanError);
    // A 128-byte prefix would mint provider input ids no id grammar accepts —
    // refuse where the pack grammar refuses, not at materialization.
    expect(() => parsePreparationPlan(planWithExecutorEvidence({
      artifactEvidenceDescriptor: { ...EVIDENCE_DESCRIPTOR, inputIdPrefix: "M".repeat(128) },
    }))).toThrow(PreparationPlanError);
  });

  it("REFUSES claimed field names and mediaTypes outside the pack grammar", () => {
    // The pack parser demands slug field names and a syntactic media type; a
    // stored plan must not admit what the compiler could never have sealed.
    expect(() => parsePreparationPlan(planWithExecutorEvidence({
      artifactEvidenceDescriptor: { ...EVIDENCE_DESCRIPTOR, memberNamesField: "member_names" },
    }))).toThrow(PreparationPlanError);
    expect(() => parsePreparationPlan(planWithExecutorEvidence({
      sourceEvidenceDescriptor: { ...sourceDescriptor(), pathsField: "paths_field" },
    }))).toThrow(PreparationPlanError);
    // A non-syntactic mediaType previously stranded runs at INVOCATION
    // (provider-bounds-invalid) — refuse it where the plan is admitted.
    expect(() => parsePreparationPlan(planWithExecutorEvidence({
      artifactEvidenceDescriptor: { ...EVIDENCE_DESCRIPTOR, mediaType: "not-media" },
    }))).toThrow(PreparationPlanError);
  });

  it("REFUSES two descriptors of one kind across the WHOLE plan — the compiler's per-action rule", () => {
    expect(() => parsePreparationPlan(planWithPhaseEvidence(new Map([
      [0, { artifactEvidenceDescriptor: { ...EVIDENCE_DESCRIPTOR } }],
      [3, { artifactEvidenceDescriptor: { ...EVIDENCE_DESCRIPTOR } }],
    ])))).toThrow(PreparationPlanError);
  });

  it("REFUSES two descriptors whose claimed input fields COLLIDE — a later capture would overwrite an earlier one's columns", () => {
    expect(() => parsePreparationPlan(planWithPhaseEvidence(new Map([
      [0, { sourceEvidenceDescriptor: { ...sourceDescriptor(), digestsField: "member-digests" } }],
      [3, { artifactEvidenceDescriptor: { ...EVIDENCE_DESCRIPTOR } }],
    ])))).toThrow(PreparationPlanError);
    // DISJOINT claims on two phases stay parseable: the guard measures
    // collision, not coexistence of the two kinds across different phases.
    parsePreparationPlan(planWithPhaseEvidence(new Map([
      [0, { sourceEvidenceDescriptor: sourceDescriptor() }],
      [3, { artifactEvidenceDescriptor: { ...EVIDENCE_DESCRIPTOR } }],
    ])));
  });

  it("REFUSES aliased columns on either descriptor — one input field cannot claim two roles", () => {
    expect(() => parsePreparationPlan(planWithExecutorEvidence({
      artifactEvidenceDescriptor: { ...EVIDENCE_DESCRIPTOR, memberDigestsField: EVIDENCE_DESCRIPTOR.memberNamesField },
    }))).toThrow(PreparationPlanError);
    expect(() => parsePreparationPlan(planWithExecutorEvidence({
      sourceEvidenceDescriptor: { ...sourceDescriptor(), digestsField: "paths" },
    }))).toThrow(PreparationPlanError);
  });
});
