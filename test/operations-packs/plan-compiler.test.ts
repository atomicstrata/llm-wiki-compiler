/**
 * @file test/operations-packs/plan-compiler.test.ts
 * @description The deterministic pack-action plan compiler produces a plan that
 * Orchestration V2 accepts and the WOP runtime can actually drive: every
 * authority is sourced from the request, pack, binding, or registered handler
 * registry; every work phase carries a pinned host-handler executor AND the real
 * closed recipe body its family will compute; the handoff capacity declares the
 * full materialization triple the runner refuses a plan without; and the sealed
 * initial input is byte-identical to the evidence staging will materialize from
 * the same seed value.
 */

import { describe, expect, it } from "vitest";
import { compilePackAction } from "../../src/operations-packs/compiler.js";
import {
  createHostHandlerRegistry, hostHandlerRefFor, HOST_HANDLER_FAMILY_IDS,
} from "../../src/operations-packs/handlers/registry.js";
import { canonicalBytes, canonicalDigest } from "../../src/profile/templates/signing/canonical.js";
import { parsePreparationPlan, preparationPlanDigest } from "../../src/preparations/plan-parse.js";
import { computePreparationWorstCase } from "../../src/preparations/plan-bounds.js";
import { prepareStructuredValueInput } from "../../src/preparations/inputs.js";
import { MILESTONE_A_DESIGN_DIGEST } from "../../src/preparations/constants.js";
import {
  buildCompileRequest, compilableRecipe, RECIPE_ID, recipeWithAllWorkKinds, recipeWithGate, requestWithRecipe,
} from "./compile-fixture.js";
import { parseSha256Digest } from "../../src/capability-providers/ids.js";
import type { WorkflowParentRefV1 } from "../../src/preparations/types.js";

const registry = createHostHandlerRegistry();

/**
 * The family every six-kind fixture phase must lower to, written out HERE rather
 * than read from the compiler's lowering table: a control that reads the table it
 * is checking would pass a swapped row.
 */
const EXPECTED_FAMILY_BY_PHASE: Readonly<Record<string, string>> = {
  assemble: "context-assemble", filter: "set-select", check: "rule-evaluate",
  merge: "reconcile", compose: "render-template", propose: "intent-compile",
};

describe("canonical workflowParent graft (P6)", () => {
  const PARENT: WorkflowParentRefV1 = {
    workflowRunId: "journey-1", workflowId: "research-journey",
    workflowDigest: parseSha256Digest(`sha256:${"ab".repeat(32)}`), stageId: "ingest",
  };

  it("omits workflowParent when none is given (unparented actions stay byte-identical)", async () => {
    const { plan } = await compilePackAction(buildCompileRequest());
    expect(plan.workflowParent).toBeUndefined();
  });

  it("folds the parent into the CANONICAL plan and so changes the digest", async () => {
    const bare = await compilePackAction(buildCompileRequest());
    const parented = await compilePackAction({ ...buildCompileRequest(), workflowParent: PARENT });
    expect(parented.plan.workflowParent).toEqual(PARENT);
    // The graft is part of the canonical document the digest covers — a
    // parent-bound run reproduces THIS digest on resume, and it differs from the
    // unparented compile.
    expect(parented.planDigest).not.toBe(bare.planDigest);
    expect(parented.planDigest).toBe(preparationPlanDigest(parented.plan));
  });
});

describe("pack-action plan compiler", () => {
  it("emits a plan whose canonical document reloads to the same digest", async () => {
    const compiled = await compilePackAction(buildCompileRequest());
    expect(compiled.planDocument).toBe(canonicalBytes(compiled.plan).toString("utf8"));
    const reloaded = parsePreparationPlan(compiled.planDocument);
    expect(preparationPlanDigest(reloaded)).toBe(compiled.planDigest);
    expect(compiled.planDigest).toBe(preparationPlanDigest(compiled.plan));
    expect(compiled.actionId).toBe("demo.run");
    expect(compiled.recipeId).toBe(RECIPE_ID);
  });

  it("copies every authority from the binding, pack, and request", async () => {
    const request = buildCompileRequest();
    const { plan } = await compilePackAction(request);
    expect(plan.knowledgeAuthority).toEqual({
      id: "com.example.demo.profile.research", version: "1.0.0",
      digest: request.binding.knowledgeProfileDigest,
      runtimeIdentityDigest: request.knowledgeRuntimeIdentityDigest,
    });
    expect(plan.operationsAuthority).toEqual({
      id: "com.example.demo", version: "1.0.0", digest: request.binding.operationsPackDigest,
      runtimeIdentityDigest: request.operationsRuntimeIdentityDigest,
    });
    expect(plan.safetyFloorDigest).toBe(request.safetyFloorDigest);
    expect(plan.workspaceId).toBe("research");
  });

  it("derives the action authority from the action and the invoked surface", async () => {
    const request = buildCompileRequest();
    const { plan } = await compilePackAction(request);
    const action = request.pack.actions["demo.run"]!;
    expect(plan.actionAuthority).toEqual({
      actionId: "demo.run", actionDescriptorDigest: canonicalDigest(action),
      handlerContractDigest: hostHandlerRefFor("intent-compile").handlerContractDigest,
      requestedSurface: "cli", capabilityClassCeiling: "staged-write",
    });
    // The recipe digest folds the recipe, the resolved render templates AND the
    // resolved canonical projections — all three are what the run will execute
    // — recomputed here independently. A projection decides what the run
    // COMPARES and what it WRITES, so it belongs in the digest exactly as a
    // template body does; this recipe resolves none, hence the empty map.
    expect(plan.recipeDigest).toBe(canonicalDigest({
      recipe: request.pack.recipes[RECIPE_ID],
      renderTemplates: { "render.wiki-page": request.pack.renderTemplates?.["render.wiki-page"] },
      projections: {},
    }));
  });

  it("pins every work phase to its registered family and its real body", async () => {
    const recipe = recipeWithAllWorkKinds();
    const compiled = await compilePackAction(requestWithRecipe(recipe));
    expect(compiled.phaseBindings).toHaveLength(6);
    for (const binding of compiled.phaseBindings) {
      // The expected family comes from this suite's own table, NEVER from the
      // compiler's: reading the lowering table back would pass a swapped row.
      const family = EXPECTED_FAMILY_BY_PHASE[binding.logicalPhaseId]!;
      expect(binding.family).toBe(family);
      const source = recipe.phases.find((phase) => phase.phaseId === binding.logicalPhaseId)!;
      expect(binding.body).toEqual(source.body);
      // The per-phase item cap is recoverable only from this binding — the pure
      // family reads it and the normalized plan phase does not carry it.
      expect(binding.bounds).toEqual({
        maximumItems: source.bounds.maxItems, maximumOutputBytes: source.bounds.maxOutputBytes,
      });
      const phase = compiled.plan.phases.find((item) => item.logicalPhaseId === binding.logicalPhaseId)!;
      expect(phase.executor).toEqual({ kind: "host-handler", ...hostHandlerRefFor(family) });
      expect(registry.resolve(hostHandlerRefFor(family)).descriptor.handlerId).toBe(family);
    }
  });

  it("covers every registered family exactly once across the six kinds", () => {
    expect([...new Set(Object.values(EXPECTED_FAMILY_BY_PHASE))].sort()).toEqual([...HOST_HANDLER_FAMILY_IDS].sort());
  });

  it("lowers dependencies, bindings, schema digests, and dispositions", async () => {
    const { plan } = await compilePackAction(buildCompileRequest());
    const compose = plan.phases.find((phase) => phase.logicalPhaseId === "compose")!;
    expect(compose.role).toBe("work");
    expect(compose.dependsOn).toEqual(["assemble"]);
    expect(compose.disposition).toBe("required");
    expect(compose.inputBindings).toEqual([
      { bindingId: "evidence-in", sourceKind: "phase-output", sourcePhaseId: "assemble" },
    ]);
    expect(compose.outputSchemaDigest).toBe(canonicalDigest([{ fieldId: "draft", valueKind: "string" }]));
    const assemble = plan.phases.find((phase) => phase.logicalPhaseId === "assemble")!;
    expect(assemble.inputBindings).toEqual([{ bindingId: "topic-in", sourceKind: "initial-input" }]);
  });

  it("bounds every phase by its family contract and never by an invented number", async () => {
    const { plan } = await compilePackAction(buildCompileRequest());
    const descriptor = registry.resolve(hostHandlerRefFor("render-template")).descriptor;
    const compose = plan.phases.find((phase) => phase.logicalPhaseId === "compose")!;
    expect(compose.bounds.maximumAttempts).toBe(3);
    expect(compose.bounds.maximumInvocationsPerAttempt).toBe(1);
    expect(compose.bounds.maximumOutputEvidenceBytes).toBe(65536);
    expect(compose.bounds.maximumTimeMsPerInstance).toBe(3 * descriptor.maximumWallTimeMs);
    expect(compose.bounds.maximumEffectsPerAttempt).toBe(0);
    expect(compose.bounds.maximumBrokerRequestsPerAttempt).toBe(0);
    expect(compose.bounds.maximumCheckpointBytes).toBe(0);
  });

  it("declares exactly the worst-case envelope Orchestration V2 computes", async () => {
    const { plan } = await compilePackAction(buildCompileRequest());
    const envelope = computePreparationWorstCase(plan);
    expect(plan.bounds.maximumPhaseInstances).toBe(envelope.phaseInstances);
    expect(plan.bounds.maximumAttempts).toBe(envelope.attempts);
    expect(plan.bounds.maximumInvocations).toBe(envelope.invocations);
    expect(plan.bounds.maximumEvidenceRefs).toBe(envelope.evidenceRefs);
    expect(plan.bounds.maximumEvidenceBytes).toBe(envelope.evidenceBytes);
    expect(plan.bounds.maximumTransitions).toBe(envelope.transitions);
  });

  it("declares the full materialization triple the runner requires", async () => {
    const { plan } = await compilePackAction(buildCompileRequest());
    const capacity = plan.outputContract.handoffCapacity!;
    expect(capacity.milestoneADesignDigest).toBe(MILESTONE_A_DESIGN_DIGEST);
    expect(capacity.maximumMaterializationManifestBytes).toBe(capacity.maximumManifestBytes);
    expect(capacity.maximumMaterializationPayloadRefs).toBe(1);
    expect(capacity.maximumMaterializationPayloadBytes).toBe(65536);
    expect(capacity.includedEvidenceClasses).toEqual([
      { classId: "wiki-page", maximumItems: 256, maximumItemBytes: 131_072, maximumAggregateBytes: 131_072 },
    ]);
    expect(plan.outputContract.producingPhaseIds).toEqual(["propose"]);
  });

  it("reserves the finalization overhead inside the declared evidence envelope", async () => {
    const { plan } = await compilePackAction(buildCompileRequest());
    const capacity = plan.outputContract.handoffCapacity!;
    const phaseRefs = plan.phases.reduce((total, phase) => total + phase.bounds.maximumAttempts + 1, 0);
    expect(plan.bounds.maximumEvidenceRefs).toBe(phaseRefs + 1 + capacity.maximumMaterializationPayloadRefs!);
    const phaseBytes = plan.phases.reduce((total, phase) => total + phase.bounds.maximumOutputEvidenceBytes, 0);
    expect(plan.bounds.maximumEvidenceBytes).toBe(
      phaseBytes + capacity.maximumMaterializationManifestBytes! + capacity.maximumMaterializationPayloadBytes!,
    );
  });

  it("derives the materialization spec from the terminal intent phase", async () => {
    const compiled = await compilePackAction(buildCompileRequest());
    expect(compiled.materializationSpec).toEqual({
      producingPhaseId: "propose", targetProfileClasses: ["wiki-page"], pageProfileClasses: ["wiki-page"],
      outputEvidenceClass: "wiki-page", requiredCompletenessClasses: [],
      maximumPayloadRefs: 1, maximumPayloadBytes: 65536,
      handlerContractDigest: hostHandlerRefFor("intent-compile").handlerContractDigest,
    });
    expect(compiled.materializationSpec.handlerContractDigest)
      .toBe(compiled.plan.actionAuthority.handlerContractDigest);
  });

  it("seals the resolved input as the evidence staging will materialize", async () => {
    const compiled = await compilePackAction(buildCompileRequest());
    const resolved = { topic: "superconductivity", depth: 2 };
    expect(compiled.initialInput.bytes.equals(canonicalBytes(resolved))).toBe(true);
    const staged = prepareStructuredValueInput({
      value: resolved, sourceIdentity: "cli-seed", provenanceLabel: compiled.plan.initialInputSet.provenanceLabel,
      mediaType: compiled.plan.initialInputSet.mediaType, sensitivity: compiled.plan.initialInputSet.sensitivity,
      retention: compiled.plan.initialInputSet.retention, evidenceKind: compiled.plan.initialInputSet.kind,
    });
    expect(compiled.plan.initialInputSet).toEqual(staged.input.evidenceRef);
    expect(compiled.initialInput.ref).toEqual(compiled.plan.initialInputSet);
  });

  it("classifies a sensitive input field as private evidence", async () => {
    const request = buildCompileRequest();
    request.pack.actions["demo.run"]!.inputSchema.topic!.sensitivityDisplay = "sensitive";
    const compiled = await compilePackAction(request);
    expect(compiled.plan.initialInputSet.sensitivity).toBe("private");
    expect(compiled.plan.initialInputSet.retention).toBe("until-handoff");
    expect(compiled.plan.initialInputSet.untrusted).toBe(true);
  });

  it("lowers a gate phase to a closed gate contract with no executor", async () => {
    const compiled = await compilePackAction(requestWithRecipe(recipeWithGate()));
    const review = compiled.plan.phases.find((phase) => phase.logicalPhaseId === "review")!;
    expect(review.role).toBe("gate");
    expect(review.gate).toEqual({ gateId: "review", gateKind: "review-preparation" });
    expect(review.executor).toBeUndefined();
    expect(review.bounds.maximumInvocationsPerAttempt).toBe(0);
    expect(compiled.phaseBindings.map((binding) => binding.logicalPhaseId))
      .toEqual(["assemble", "compose", "propose"]);
  });

  it("lowers a map expansion over the phase output it fans across", async () => {
    const recipe = compilableRecipe();
    recipe.phases[1]!.expansionPolicy = {
      kind: "map", maxItems: 4, duplicateDisposition: "dedupe", overflowDisposition: "record-deficit",
      nonConvergenceDisposition: "fail", completenessClass: "evidence-coverage",
      stableIdentityPolicy: "canonical-item-digest",
    };
    recipe.bounds = { ...recipe.bounds, maxPhaseInvocations: 32 };
    const compiled = await compilePackAction(requestWithRecipe(recipe));
    expect(compiled.plan.phases[1]!.expansion).toEqual({
      kind: "map", sourceEvidenceBinding: "evidence-in", maximumItems: 4,
      itemIdentity: "canonical-item-digest", duplicateDisposition: "deduplicate",
      overflowDisposition: { kind: "count-as-incomplete", completenessClassId: "evidence-coverage" },
    });
  });
});

describe("the materialization spec carries the recipe's required classes", () => {
  it("lists exactly the classes declared required-complete, none of the rest", async () => {
    // The deficit-refusal leg reads this list; a compiler that dropped the
    // dispositions here would silence every recorded deficit downstream.
    const recipe = compilableRecipe();
    recipe.completenessClasses = [
      { classId: "row-validity", disposition: "required-complete" },
      { classId: "evidence-coverage", disposition: "best-effort" },
    ];
    const action = await compilePackAction(requestWithRecipe(recipe));
    expect(action.materializationSpec.requiredCompletenessClasses).toEqual(["row-validity"]);
  });
});
