/**
 * @file test/operations-packs/plan-compiler-refusals.test.ts
 * @description Every construct the compiler cannot lower honestly is REFUSED, not
 * approximated. A deferred authority (a provider pin, an orchestration join
 * executor, a repeat continuation rule, a context evidence class) raises the
 * typed deferral; a recipe or action that is internally inconsistent, understates
 * its own envelope, or exceeds a host contract raises the typed parse refusal.
 * The point of the sweep is that no case in it silently produces a plan: a
 * compiled plan that could not run is worse than a refusal.
 */

import { describe, expect, it } from "vitest";
import { compilePackAction } from "../../src/operations-packs/compiler.js";
import type { CompilePackActionRequestV1 } from "../../src/operations-packs/compiler-types.js";
import { PackDeferredError, PackParseError } from "../../src/operations-packs/problems.js";
import type { PackPhaseV2, PackRecipeV2 } from "../../src/operations-packs/recipe-types.js";
import {
  buildCompileRequest, compilableRecipe, RECIPE_ID, gatePhase, requestWithRecipe,
} from "./compile-fixture.js";

/** Build a request whose recipe has been mutated by `mutate`. */
function withMutatedRecipe(mutate: (recipe: PackRecipeV2) => void): CompilePackActionRequestV1 {
  const recipe = compilableRecipe();
  mutate(recipe);
  return requestWithRecipe(recipe);
}

/** Build a request whose action has been mutated by `mutate`. */
function withMutatedAction(
  mutate: (action: CompilePackActionRequestV1["pack"]["actions"][string]) => void,
): CompilePackActionRequestV1 {
  const request = buildCompileRequest();
  mutate(request.pack.actions["demo.run"]!);
  return request;
}

/** One extra render phase that keeps the intent phase from being terminal. */
function trailingPhase(): PackPhaseV2 {
  return {
    phaseId: "publish", kind: "render", dependencies: ["propose"], disposition: "required",
    inputBindings: [{ bindingId: "proposed", source: "phase-output", ref: "propose.mutation" }],
    outputSchema: [{ fieldId: "page", valueKind: "string" }],
    bounds: { maxItems: 1, maxOutputBytes: 1024 }, missingInputDisposition: "fail",
    body: {
      templateRef: "render.wiki-page", formatId: "markdown",
      escapingPolicyId: "per-node", inputEvidenceRefs: ["mutation"],
    },
  };
}

/** Each case names the exact refusal it must provoke, so none passes by accident. */
type RefusalCase = readonly [string, () => CompilePackActionRequestV1, string];

const DEFERRALS: readonly RefusalCase[] = [
  ["a join phase", () => withMutatedRecipe((recipe) => {
    recipe.phases[1] = {
      ...recipe.phases[1]!, kind: "join", body: { variant: "ordered-evidence-set" },
    } as PackPhaseV2;
  }), "join executor"],
  ["a bounded-repeat expansion", () => withMutatedRecipe((recipe) => {
    recipe.phases[1]!.expansionPolicy = {
      kind: "bounded-repeat", maxIterations: 3, duplicateDisposition: "dedupe",
      overflowDisposition: "fail", nonConvergenceDisposition: "fail",
      completenessClass: "evidence-coverage", stableIdentityPolicy: "host-id",
    };
  }), "continuation rule"],
  ["a context-evidence input binding", () => withMutatedRecipe((recipe) => {
    recipe.phases[1]!.inputBindings = [{ bindingId: "evidence-in", source: "context-evidence", ref: "source" }];
  }), "context evidence-class authority"],
  ["a non fail-closed missing-input disposition", () => withMutatedRecipe((recipe) => {
    recipe.phases[1]!.missingInputDisposition = "treat-as-empty";
  }), "no plan representation"],
  ["a keep-first duplicate disposition", () => withMutatedRecipe((recipe) => {
    recipe.phases[1]!.expansionPolicy = {
      kind: "map", maxItems: 2, duplicateDisposition: "keep-first", overflowDisposition: "fail",
      nonConvergenceDisposition: "fail", completenessClass: "evidence-coverage",
      stableIdentityPolicy: "host-id",
    };
  }), "no keep-first duplicate disposition"],
  ["an ephemeral-read action", () => withMutatedAction((action) => {
    action.execution = {
      kind: "preparation", executionMode: "ephemeral-read",
      recipeRef: RECIPE_ID, outputContractRef: "demo.output",
    };
  }), "cannot declare the handoff"],
  ["a configuration action", () => withMutatedAction((action) => {
    action.execution = { kind: "configuration", flowRef: "demo.configure" };
  }), "configuration flow authority"],
];

const REFUSALS: readonly RefusalCase[] = [
  ["an unregistered gate kind", () => {
    const recipe = compilableRecipe();
    const gate = gatePhase();
    gate.body = { gateKindId: "confirm-everything" };
    recipe.phases = [recipe.phases[0]!, recipe.phases[1]!, gate, { ...recipe.phases[2]!, dependencies: ["review"] }];
    return requestWithRecipe(recipe);
  }, "unregistered gate kind"],
  ["an action the pack does not declare", () => ({ ...buildCompileRequest(), actionId: "demo.absent" }), "pack declares no action demo.absent"],
  ["a recipe the pack does not declare", () => withMutatedAction((action) => {
    action.execution = {
      kind: "preparation", executionMode: "durable-preparation",
      recipeRef: "demo.absent", outputContractRef: "demo.output",
    };
  }), "pack declares no recipe demo.absent"],
  ["an input field the action does not declare", () =>
    ({ ...buildCompileRequest(), input: { topic: "physics", colour: "blue" } }), "action declares no input field colour"],
  ["a missing required input", () => ({ ...buildCompileRequest(), input: {} }), "required action input topic is missing"],
  ["an input value outside its declared range", () =>
    ({ ...buildCompileRequest(), input: { topic: "physics", depth: 9 } }), "input.depth must be within [1, 5]"],
  ["an override of a non-overridable field", () => {
    const request = withMutatedAction((action) => {
      action.inputSchema.depth = {
        kind: "integer", required: false, overridable: false,
        sensitivityDisplay: "normal", minimum: 1, maximum: 5, default: 2,
      };
    });
    return { ...request, input: { topic: "physics", depth: 4 } };
  }, "action input depth is not overridable"],
  ["a surface the action requests no capability on", () =>
    ({ ...buildCompileRequest(), requestedSurface: "mcp" }), "no capability on the mcp surface"],
  ["a recipe with no intent phase", () => withMutatedRecipe((recipe) => {
    recipe.phases = [recipe.phases[0]!, recipe.phases[1]!];
  }), "exactly one intent phase"],
  ["a recipe with two intent phases", () => withMutatedRecipe((recipe) => {
    recipe.phases = [...recipe.phases, { ...recipe.phases[2]!, phaseId: "propose-again" }];
  }), "exactly one intent phase"],
  ["a non-terminal intent phase", () => withMutatedRecipe((recipe) => {
    recipe.phases = [...recipe.phases, trailingPhase()];
  }), "intent phase must be terminal"],
  ["an atomicity class no host-handler plan can hold", () => withMutatedRecipe((recipe) => {
    recipe.atomicityClass = "external-effect-only";
  }), "local-bundle-only atomicity"],
  ["an understated invocation ceiling", () => withMutatedRecipe((recipe) => {
    recipe.bounds = { ...recipe.bounds, maxPhaseInvocations: 4 };
  }), "below its own compiled worst case"],
  ["a phase output bound its family cannot emit", () => withMutatedRecipe((recipe) => {
    recipe.phases[1]!.bounds = { maxItems: 1, maxOutputBytes: 300_000 };
  }), "exceed the render-template contract"],
  ["an output envelope over the Milestone A item cap", () => withMutatedRecipe((recipe) => {
    recipe.bounds = { ...recipe.bounds, maxOutputBytes: 17 * 1024 * 1024 };
  }), "Milestone A payload item cap"],
  ["more phases than one plan may carry", () => withMutatedRecipe((recipe) => {
    const chain = Array.from({ length: 63 }, (_unused, index) => ({
      ...recipe.phases[0]!, phaseId: `assemble-${index}`,
      dependencies: index === 0 ? [] : [`assemble-${index - 1}`],
    }));
    recipe.phases = [...chain, { ...recipe.phases[1]!, dependencies: ["assemble-62"] }, recipe.phases[2]!];
  }), "more phases than one plan may carry"],
  ["a map phase with no phase output to fan over", () => withMutatedRecipe((recipe) => {
    recipe.phases[0]!.expansionPolicy = {
      kind: "map", maxItems: 2, duplicateDisposition: "dedupe", overflowDisposition: "fail",
      nonConvergenceDisposition: "fail", completenessClass: "evidence-coverage",
      stableIdentityPolicy: "host-id",
    };
  }), "exactly one phase output to fan over"],
  ["an undeclared completeness class", () => withMutatedRecipe((recipe) => {
    recipe.phases[1]!.expansionPolicy = {
      kind: "map", maxItems: 2, duplicateDisposition: "dedupe", overflowDisposition: "record-deficit",
      nonConvergenceDisposition: "fail", completenessClass: "unknown-class",
      stableIdentityPolicy: "host-id",
    };
  }), "undeclared completeness class"],
  ["an unregistered stable-identity policy", () => withMutatedRecipe((recipe) => {
    recipe.phases[1]!.expansionPolicy = {
      kind: "map", maxItems: 2, duplicateDisposition: "dedupe", overflowDisposition: "fail",
      nonConvergenceDisposition: "fail", completenessClass: "evidence-coverage",
      stableIdentityPolicy: "first-seen",
    };
  }), "unregistered stable-identity policy"],
  ["an action requiring a gate its recipe omits", () => withMutatedAction((action) => {
    action.requiredGates = ["confirm-cost"];
  }), "requires an undeclared gate"],
];

describe("plan compiler deferrals", () => {
  it("refuses a recipe phase claiming the reserved action-input identity", async () => {
    // The identity is reserved by the evidence-decoding convention: a phase
    // publishing under it would collide with the real action input when chained.
    const recipe = compilableRecipe();
    recipe.phases[0]!.phaseId = "action-input";
    recipe.phases[1]!.dependencies = ["action-input"];
    recipe.phases[1]!.inputBindings = [{ bindingId: "in", source: "phase-output", ref: "action-input.evidence" }];
    await expect(compilePackAction(requestWithRecipe(recipe))).rejects.toThrow(/reserved by the evidence-decoding convention/);
  });

  it("refuses a recipe phase claiming the reserved source- identity prefix", async () => {
    // Multi-source inputs decode under `source-<i>` identities, so a phase
    // named `source-0` would publish a wrapped item that collides with a list
    // item under intent's first-arrival dedupe — silently dropping one.
    const recipe = compilableRecipe();
    recipe.phases[0]!.phaseId = "source-0";
    recipe.phases[1]!.dependencies = ["source-0"];
    recipe.phases[1]!.inputBindings = [{ bindingId: "in", source: "phase-output", ref: "source-0.evidence" }];
    await expect(compilePackAction(requestWithRecipe(recipe))).rejects.toThrow(/reserved for multi-source input items/);
  });

  it("refuses a NON-page intent group naming a page-shaped projection AT COMPILE", async () => {
    // The runtime refuses this too, but only once the terminal intent RUNS — by
    // which point the incompatibility has been sealed into a plan. A pack
    // shipping this shape must fail at composition, not at execution.
    const pageProjection = {
      "project.page": {
        projectionId: "project.page",
        targetProfileClass: "wiki-page",
        // TWO mappings with the offender SECOND: a guard checking only the
        // first mapping would pass a single-mapping fixture.
        fieldMappings: [
          { targetField: "title", source: "phase-input", ref: "title" },
          { targetField: "resultSummary", source: "phase-input", ref: "summary" },
        ],
      },
    };
    const relationRequest = withMutatedRecipe((recipe) => {
      const propose = recipe.phases.find((phase) => phase.kind === "intent")!;
      const group = (propose.body as unknown as { intents: Record<string, unknown>[] }).intents[0]!;
      group.mutationKind = "relation-upsert";
      group.projectionRef = "project.page";
    });
    Object.assign(relationRequest.pack, { projections: pageProjection });
    await expect(compilePackAction(relationRequest)).rejects.toThrow(/is not a slug/);

    // A SECOND non-page kind, so a guard hard-coded to `relation-upsert` alone
    // does not survive: the rule is "not a PAGE draft", not "is a relation".
    const catalogRequest = withMutatedRecipe((recipe) => {
      const propose = recipe.phases.find((phase) => phase.kind === "intent")!;
      const group = (propose.body as unknown as { intents: Record<string, unknown>[] }).intents[0]!;
      group.mutationKind = "catalog-append";
      group.projectionRef = "project.page";
    });
    Object.assign(catalogRequest.pack, { projections: pageProjection });
    await expect(compilePackAction(catalogRequest)).rejects.toThrow(/is not a slug/);

    // CONTROL: the SAME projection compiles for a PAGE group, so the refusal is
    // attributable to the mutation KIND rather than to the projection itself.
    const pageRequest = withMutatedRecipe((recipe) => {
      const propose = recipe.phases.find((phase) => phase.kind === "intent")!;
      const group = (propose.body as unknown as { intents: Record<string, unknown>[] }).intents[0]!;
      group.projectionRef = "project.page";
    });
    Object.assign(pageRequest.pack, { projections: pageProjection });
    await expect(compilePackAction(pageRequest)).resolves.toBeDefined();
  });

  it.each(DEFERRALS)("defers %s", async (_name, build, reason) => {
    const compiled = compilePackAction(build());
    await expect(compiled).rejects.toBeInstanceOf(PackDeferredError);
    await expect(compiled).rejects.toThrow(reason);
  });
});

describe("plan compiler refusals", () => {
  it.each(REFUSALS)("refuses %s", async (_name, build, reason) => {
    const compiled = compilePackAction(build());
    await expect(compiled).rejects.toBeInstanceOf(PackParseError);
    await expect(compiled).rejects.toThrow(reason);
  });
});

describe("a provider phase is no longer categorically deferred", () => {
  it("REFUSES an incomplete role declaration as an authoring error, not a deferral", async () => {
    // Provider phases now lower (see provider-phase-lowering.test.ts). What is
    // refused is an INCOMPLETE declaration — this fixture's role names no
    // `requestedBounds` — and it is a PackParseError because the pack is
    // wrong, not because the host lacks a capability. Lowering it anyway would
    // seal an unbounded envelope behind an approved plan digest.
    const request = withMutatedRecipe((recipe) => {
      recipe.phases[1] = {
        ...recipe.phases[1]!, kind: "provider",
        body: { providerRoleId: "primary-model", requestTemplateRef: "render.provider-request" },
      } as PackPhaseV2;
    });
    // The incomplete declaration is made HERE rather than inherited from the
    // fixture: relying on the fixture being incomplete meant this case silently
    // stopped testing anything the moment the fixture gained an envelope.
    const role = request.pack.providerRequirements.find((r) => r.roleId === "primary-model")!;
    delete (role as { requestedBounds?: unknown }).requestedBounds;
    await expect(compilePackAction(request)).rejects.toThrow(/requestedBounds/);
  });
});

describe("a select body's completeness class must be declared", () => {
  it("REFUSES a typoed class instead of counting deficits nothing will read", async () => {
    // The materializer matches required classes by exact string, so a select
    // recording invalid-row deficits under "row-validty" would compile and its
    // required refusal would never fire — the silent drop, one typo away.
    const recipe = compilableRecipe();
    recipe.completenessClasses = [{ classId: "row-validity", disposition: "required-complete" }];
    recipe.phases = [
      recipe.phases[0]!,
      { ...recipe.phases[0]!, phaseId: "filter", kind: "select", body: {
        operation: "dedupe", identityFields: ["item-id"], sortFields: [],
        filterPredicateIds: ["exactly-one-present"],
        overflowDisposition: "fail", completenessClass: "row-validty",
      } } as PackPhaseV2,
      recipe.phases[1]!, recipe.phases[2]!,
    ];
    const compiled = compilePackAction(requestWithRecipe(recipe));
    await expect(compiled).rejects.toBeInstanceOf(PackParseError);
    await expect(compiled).rejects.toThrow("phase filter names an undeclared completeness class: row-validty");
  });
});
