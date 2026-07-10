/**
 * @file test/profile/artifact-requirements-load.test.ts
 * @description Fail-closed LOAD validation of `transitionArtifactRequirements`:
 * the ajv schema accepts a well-formed block (locked here, finalized in Task 3), the
 * M1 semantic gate rejects an UNENFORCEABLE declaration (Task 7), and the M3
 * DAG-ordering check surfaces an ADVISORY warning (not a load failure — remediation
 * Task 2) when a workflow produces a required artifact same-or-later than the page
 * that needs it, or never produces it at all (out-of-band production).
 */
import { describe, it, expect } from "vitest";
import { validateProfile, ProfileValidationError } from "../../src/profile/validate.js";
import { researchArtifactPreconditionProfile, RESEARCH_ARTIFACT_TYPE } from "../fixtures/artifact-precondition-profiles.js";
import type { WorkflowDef } from "../../src/profile/types.js";

describe("transitionArtifactRequirements — schema acceptance", () => {
  it("loads a well-formed required-artifact precondition", () => {
    expect(() => validateProfile(researchArtifactPreconditionProfile())).not.toThrow();
  });

  it("rejects an unknown sub-property (additionalProperties:false)", () => {
    const p = researchArtifactPreconditionProfile();
    (p.entities.experiments.lifecycle!.transitionArtifactRequirements!.complete[0] as Record<string, unknown>).bogus = 1;
    expect(() => validateProfile(p)).toThrow(ProfileValidationError);
  });
});

describe("transitionArtifactRequirements — M1 unenforceable-declaration rejection", () => {
  it("rejects a precondition on a NON-artifactRef field (the enforcer cannot resolve it)", () => {
    const p = researchArtifactPreconditionProfile();
    p.entities.experiments.lifecycle!.transitionArtifactRequirements!.complete[0].field = "title";
    expect(() => validateProfile(p)).toThrow(/artifactRef/);
  });

  it("rejects a precondition naming an UNDECLARED artifact type", () => {
    const p = researchArtifactPreconditionProfile();
    p.entities.experiments.lifecycle!.transitionArtifactRequirements!.complete[0].artifactType = "no-such-type";
    expect(() => validateProfile(p)).toThrow(/not a declared artifact type/);
  });

  it("rejects a precondition whose artifactType is outside the field's declared scope", () => {
    const p = researchArtifactPreconditionProfile();
    p.artifacts!["other-type"] = { fileName: "o.json", contentKind: "json", maxBytes: 1024 };
    p.entities.experiments.lifecycle!.transitionArtifactRequirements!.complete[0].artifactType = "other-type";
    expect(() => validateProfile(p)).toThrow(/outside the declared scope/);
  });

  it("rejects a precondition keyed on an UNKNOWN lifecycle state", () => {
    const p = researchArtifactPreconditionProfile();
    p.entities.experiments.lifecycle!.transitionArtifactRequirements = { nonesuch: [{ field: "result", artifactType: "experiment-result" }] };
    expect(() => validateProfile(p)).toThrow(/unknown state/);
  });

  it("rejects a precondition on an artifactRef[] field (single artifactRef only in v0)", () => {
    const p = researchArtifactPreconditionProfile();
    p.entities.experiments.fields!.results = { type: "artifactRef[]", artifactTypes: [RESEARCH_ARTIFACT_TYPE] };
    p.entities.experiments.lifecycle!.transitionArtifactRequirements!.complete[0].field = "results";
    expect(() => validateProfile(p)).toThrow(/artifactRef\[\]|single artifactRef/);
  });
});

/** Add a 2-stage workflow producing the artifact in `produceStageIndex` and writing the page in stage 1. */
function withOrderingWorkflow(produceUpstream: boolean): ReturnType<typeof researchArtifactPreconditionProfile> {
  const p = researchArtifactPreconditionProfile();
  const produce = { id: "produce", reads: [], writes: [], artifactWrites: ["experiment-result"] } as unknown as WorkflowDef["stages"][number];
  const writePage = { id: "write-exp", reads: [], writes: ["experiments"] } as WorkflowDef["stages"][number];
  p.workflows = { exp: { stages: produceUpstream ? [produce, writePage] : [writePage, produce] } };
  return p;
}

/** A workflow that writes the gated page but never produces the required artifact in ANY stage — standing in for out-of-band production (a human, the CLI, or a different workflow). */
function withOutOfBandProfile(): ReturnType<typeof researchArtifactPreconditionProfile> {
  const p = researchArtifactPreconditionProfile();
  const writePage = { id: "write-exp", reads: [], writes: ["experiments"] } as WorkflowDef["stages"][number];
  p.workflows = { exp: { stages: [writePage] } };
  return p;
}

describe("transitionArtifactRequirements — M3 DAG ordering (advisory)", () => {
  it("loads (no throw) with an advisory warning when the required artifact is produced in the SAME-or-LATER stage as the page", () => {
    const { warnings } = validateProfile(withOrderingWorkflow(false));
    expect(warnings.some((w) => /upstream|before the page/i.test(w))).toBe(true);
  });

  it("loads with no ordering warning when the required artifact is produced in an UPSTREAM stage", () => {
    const { warnings } = validateProfile(withOrderingWorkflow(true));
    expect(warnings.some((w) => /upstream|before the page/i.test(w))).toBe(false);
  });

  it("loads (no throw) with an advisory warning for a SINGLE stage that both writes the page and declares the artifact in its own artifactWrites", () => {
    // Check-then-add: a stage's `writes` is checked against artifacts produced
    // so far BEFORE that same stage's own `artifactWrites` is folded in, so a
    // stage can never satisfy its own requirement — same-stage is same-or-later.
    const p = researchArtifactPreconditionProfile();
    const stage = { id: "produce-and-write", reads: [], writes: ["experiments"], artifactWrites: ["experiment-result"] } as unknown as WorkflowDef["stages"][number];
    p.workflows = { exp: { stages: [stage] } };
    const { warnings } = validateProfile(p);
    expect(warnings.some((w) => /upstream|before the page/i.test(w))).toBe(true);
  });

  it("loads (no throw) with an advisory warning when the required artifact is produced OUT OF BAND (no workflow stage ever produces it)", () => {
    const { warnings } = validateProfile(withOutOfBandProfile());
    expect(warnings.some((w) => /upstream|before the page/i.test(w))).toBe(true);
  });
});
