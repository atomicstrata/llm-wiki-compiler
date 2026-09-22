/**
 * @file test/operations-packs/page-evidence-inputid-uniqueness.test.ts
 * @description Two captures may declare distinct captureIds yet materialize the
 * SAME provider inputId; the runtime refuses a duplicate exposure input id only
 * at invocation. This slice moves that refusal EARLY to pack admission, and it
 * must hold at BOTH admission boundaries independently: the byte parser
 * (`parsePageEvidenceDescriptor`) and the compiler lowering (`lowerPhase`, which
 * receives an already-typed descriptor and so is reachable without the parser).
 * Each boundary carries its own witness here, and each is mutation-checked (see
 * the commit) by deleting its guard and watching only its own witness go red.
 */

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { parsePageEvidenceDescriptor } from "../../src/operations-packs/parse-page-evidence.js";
import { lowerPhase } from "../../src/operations-packs/compiler-lowering.js";
import { createHostHandlerRegistry } from "../../src/operations-packs/handlers/registry.js";
import { PackParseError } from "../../src/operations-packs/problems.js";
import type { PackPhaseV2, PageEvidenceDescriptorV2 } from "../../src/operations-packs/recipe-types.js";
import type { ProviderRequirementV2 } from "../../src/operations-packs/types.js";
import type { Sha256Digest } from "../../src/operations-packs/ids.js";

const dg = (seed: string): Sha256Digest =>
  `sha256:${createHash("sha256").update(seed).digest("hex")}` as Sha256Digest;

const TAIL = { kind: "page-evidence", provenanceLabel: "syn", mediaType: "text/plain", maxBytes: 512 } as const;

/** A descriptor whose two page fields materialize the given input ids. */
function twoFieldDescriptor(firstInput: string, secondInput: string): unknown {
  return {
    pathTableKey: "page-evidence-files",
    target: { entityType: "gadgets", slugField: "slug" },
    captures: [
      { form: "page-field", captureId: "spec", field: "spec", inputId: firstInput, ...TAIL },
      { form: "page-field", captureId: "note", field: "note", inputId: secondInput, ...TAIL },
    ],
  };
}

/** A descriptor whose duplicate spans a nested relation-target `then` field. */
function nestedCollisionDescriptor(): unknown {
  return {
    pathTableKey: "page-evidence-files",
    target: { entityType: "gadgets", slugField: "slug" },
    captures: [
      { form: "page-field", captureId: "spec", field: "spec", inputId: "in-shared", ...TAIL },
      { form: "relation-target", captureId: "measured", relationType: "measures", sourceRole: "from",
        targetEntityType: "widgets",
        then: [{ form: "page-field", captureId: "widget-note", field: "note", inputId: "in-shared", ...TAIL }] },
    ],
  };
}

/** A run-binding whose frozenField and output materialize the SAME inputId. */
function runBindingCollisionDescriptor(): unknown {
  return {
    pathTableKey: "page-evidence-files",
    target: { entityType: "gadgets", slugField: "slug" },
    captures: [
      { form: "run-binding", captureId: "run", runIdFrom: "run-ref",
        expect: { actionId: "syn.action", state: "succeeded", slugField: "slug" },
        frozenFields: [{ captureId: "frozen", field: "acc", inputId: "in-dup", ...TAIL }],
        outputs: [{ captureId: "out", logicalPhaseId: "compile", refKind: "artifact-ref",
          refProvenanceLabel: "out-prov", inputId: "in-dup", ...TAIL }] },
    ],
  };
}

describe("PARSE boundary: parsePageEvidenceDescriptor refuses duplicate materialized inputIds", () => {
  it("accepts distinct inputIds (positive control — the guard does not over-fire)", () => {
    expect(() => parsePageEvidenceDescriptor(twoFieldDescriptor("in-spec", "in-note"), "d")).not.toThrow();
  });

  it("REFUSES two captures sharing one inputId, even with distinct captureIds", () => {
    expect(() => parsePageEvidenceDescriptor(twoFieldDescriptor("in-dup", "in-dup"), "d"))
      .toThrow(/repeats a materialized inputId/);
  });

  it("REFUSES a duplicate that spans a nested relation-target `then` field", () => {
    expect(() => parsePageEvidenceDescriptor(nestedCollisionDescriptor(), "d"))
      .toThrow(/repeats a materialized inputId/);
  });

  it("REFUSES a duplicate across a run-binding's frozenField and output", () => {
    expect(() => parsePageEvidenceDescriptor(runBindingCollisionDescriptor(), "d"))
      .toThrow(/repeats a materialized inputId/);
  });
});

/** The minimal provider requirement a page-evidence phase must resolve against. */
function requirement(): ProviderRequirementV2 {
  return {
    roleId: "primary-model", disposition: "required", capabilityId: "model.chat",
    capabilityContractDigest: dg("cap-contract"),
    allowedProviderPins: [dg("pin-a")], defaultProviderPin: dg("pin-a"),
    requiredReadinessDimensions: [], requestedGrantKinds: ["model-invoke"],
    fallbackPolicy: { kind: "refuse" },
    requestedBounds: {
      maxBrokerRequestsPerAttempt: 3, maxTokensPerAttempt: 4096,
      maxCostMicrosPerAttempt: 50_000, maxWallTimeMsPerAttempt: 30_000,
    },
  } as unknown as ProviderRequirementV2;
}

/** A provider phase carrying an ALREADY-TYPED descriptor — no parser in the path. */
function pagePhase(firstInput: string, secondInput: string): PackPhaseV2 {
  return {
    phaseId: "capture", kind: "provider", dependencies: [], disposition: "required",
    inputBindings: [], outputSchema: [{ fieldId: "entities", valueKind: "evidence-ref" }],
    bounds: { maxItems: 16, maxOutputBytes: 65_536 }, missingInputDisposition: "fail",
    body: {
      providerRoleId: "primary-model", requestTemplateRef: "render.capture",
      pageEvidenceDescriptor: twoFieldDescriptor(firstInput, secondInput) as PageEvidenceDescriptorV2,
    },
  } as unknown as PackPhaseV2;
}

function lowerCapture(firstInput: string, secondInput: string) {
  return lowerPhase(pagePhase(firstInput, secondInput), {
    resolve: createHostHandlerRegistry().resolve,
    completenessClasses: new Set<string>(),
    providerRequirements: new Map([["primary-model", requirement()]]),
  });
}

describe("LOWERING boundary: lowerPhase refuses duplicate inputIds on a typed descriptor", () => {
  it("lowers a distinct-inputId descriptor (positive control — otherwise-valid fixture)", () => {
    expect(() => lowerCapture("in-spec", "in-note")).not.toThrow();
  });

  it("REFUSES a duplicate inputId reaching lowering WITHOUT the parser", () => {
    expect(() => lowerCapture("in-dup", "in-dup")).toThrow(PackParseError);
    expect(() => lowerCapture("in-dup", "in-dup")).toThrow(/repeats a materialized inputId/);
  });
});
