/**
 * @file test/operations-packs/provider-phase-lowering.test.ts
 * @description Lowering a `provider` phase: the pin AND the resource envelope
 * are sealed into the plan from the pack's own declaration.
 *
 * WHY BOTH MUST BE SEALED. The plan digest is what an operator approves. A plan
 * whose provider were resolved at run time could reach a different provider
 * than the one approved; a plan whose ceilings were resolved at run time could
 * ask for more than was approved. Either makes the digest a weaker promise than
 * it appears to be, so a role missing either declaration is REFUSED rather than
 * defaulted to "whichever provider is installed" or "whatever budget exists".
 *
 * THE PACK REQUESTS; THE GRANT STILL DECIDES. Sealing a requested envelope is
 * not the pack granting itself budget — the operator's grant caps independently
 * at invocation, so the effective ceiling is the smaller of the two. That is the
 * same shape `requestedGrantKinds` already uses.
 */

import { describe, expect, it } from "vitest";
import { lowerPhase } from "../../src/operations-packs/compiler-lowering.js";
import { createHostHandlerRegistry } from "../../src/operations-packs/handlers/registry.js";
import { PackParseError } from "../../src/operations-packs/problems.js";
import { dg } from "./pack-fixture.js";
import { compilableRecipe, requestWithRecipe } from "./compile-fixture.js";
import { compilePackAction } from "../../src/operations-packs/compiler.js";
import type { ProviderRequirementV2 } from "../../src/operations-packs/types.js";
import type { PackPhaseV2 } from "../../src/operations-packs/recipe-types.js";

const REQUESTED = {
  maxBrokerRequestsPerAttempt: 3, maxTokensPerAttempt: 4096,
  maxCostMicrosPerAttempt: 50_000, maxWallTimeMsPerAttempt: 30_000,
};

/** One provider requirement, varied per case. */
function requirement(overrides: Partial<ProviderRequirementV2> = {}): ProviderRequirementV2 {
  return {
    roleId: "primary-model", disposition: "required", capabilityId: "model.chat",
    capabilityContractDigest: dg("cap-contract"),
    allowedProviderPins: [dg("pin-a")], defaultProviderPin: dg("pin-a"),
    requiredReadinessDimensions: [], requestedGrantKinds: ["model-invoke"],
    fallbackPolicy: { kind: "refuse" }, requestedBounds: REQUESTED,
    ...overrides,
  } as ProviderRequirementV2;
}

/** One provider phase naming that role. */
function providerPhase(): PackPhaseV2 {
  return {
    phaseId: "extract", kind: "provider", dependencies: [], disposition: "required",
    inputBindings: [{ bindingId: "source", source: "action-input", ref: "text" }],
    outputSchema: [{ fieldId: "entities", valueKind: "evidence-ref" }],
    bounds: { maxItems: 16, maxOutputBytes: 65_536 }, missingInputDisposition: "fail",
    body: { providerRoleId: "primary-model", requestTemplateRef: "render.extract-request" },
  } as unknown as PackPhaseV2;
}

/** Lower the provider phase against the given requirements. */
function lower(requirements: ProviderRequirementV2[]) {
  return lowerPhase(providerPhase(), {
    resolve: createHostHandlerRegistry().resolve,
    completenessClasses: new Set<string>(),
    providerRequirements: new Map(requirements.map((r) => [r.roleId, r])),
  });
}

describe("lowering a provider phase", () => {
  it("seals the declared pin, capability, and OUTPUT CONTRACT into the plan", () => {
    const { phase } = lower([requirement()]);
    // The complete executor, not a subset: a field appearing here that the plan
    // did not seal is exactly the drift this assertion exists to catch.
    expect(phase.executor).toEqual({
      kind: "provider-capability", providerPinDigest: dg("pin-a"),
      capabilityId: "model.chat", capabilityContractDigest: dg("cap-contract"),
      // The fields themselves travel, not just their digest, because a successor
      // decodes the provider's answer against them.
      outputSchema: [{ fieldId: "entities", valueKind: "evidence-ref" }],
      maximumOutputItems: 16,
      // The template the request is rendered from travels too: without it the
      // runtime cannot ask what the plan says it asks, and a host would have to
      // invent the question.
      requestTemplateRef: "render.extract-request",
    });
  });

  it("seals the REQUESTED envelope, so approving the plan approves that ceiling", () => {
    const { phase } = lower([requirement()]);
    expect(phase.bounds.maximumBrokerRequestsPerAttempt).toBe(3);
    expect(phase.bounds.maximumTokensPerAttempt).toBe(4096);
    expect(phase.bounds.maximumCostMicrosPerAttempt).toBe(50_000);
  });

  it("keeps external effects at zero — an envelope does not grant them implicitly", () => {
    expect(lower([requirement()]).phase.bounds.maximumEffectsPerAttempt).toBe(0);
  });

  it("REFUSES a role with no default pin rather than picking one", () => {
    expect(() => lower([requirement({ defaultProviderPin: undefined })]))
      .toThrow(PackParseError);
  });

  it("REFUSES a role with no requested envelope rather than running unbounded", () => {
    expect(() => lower([requirement({ requestedBounds: undefined })]))
      .toThrow(PackParseError);
  });

  it("REFUSES a phase naming a role the pack never declared", () => {
    expect(() => lower([])).toThrow(PackParseError);
  });

  it("carries NO execute-time binding — the host supplies the provider leg", () => {
    // A host-handler family is dispatched by the runtime itself; a provider leg
    // comes from the runner's `legFor`, so this compiler names no transport.
    expect(lower([requirement()]).binding).toBeUndefined();
  });
});

describe("the provider request is sealed by the plan digest", () => {
  /** A compile request whose recipe carries one provider phase. */
  function requestWithProviderPhase(templateRef: string) {
    const recipe = compilableRecipe();
    recipe.phases.push({
      phaseId: "extract", kind: "provider", dependencies: [], disposition: "required",
      inputBindings: [], outputSchema: [{ fieldId: "entities", valueKind: "string" }],
      bounds: { maxItems: 1, maxOutputBytes: 4096 }, missingInputDisposition: "fail",
      body: { providerRoleId: "primary-model", requestTemplateRef: templateRef },
    } as never);
    return requestWithRecipe(recipe);
  }

  it("REFUSES a provider phase whose request template the pack never ships", async () => {
    // A phase naming a role but no resolvable request would compile to "ask this
    // provider something unspecified" — nothing a digest could seal, and nothing
    // a reviewer could approve.
    await expect(compilePackAction(requestWithProviderPhase("render.not-shipped")))
      .rejects.toThrow(/unknown render template/);
  });

  it("folds the request template into the recipe digest", async () => {
    // The property that makes sealing meaningful: the question the provider is
    // asked must be inside the digest an operator approves, exactly as a
    // rendered page's template already is.
    const compiled = await compilePackAction(requestWithProviderPhase("render.provider-request"));
    expect(compiled.plan.recipeDigest).toBeDefined();
    // And the template travels with the compiled action, so the run cannot
    // resolve a different one later.
    expect(compiled.renderTemplates["render.provider-request"]).toBeDefined();
  });
});
