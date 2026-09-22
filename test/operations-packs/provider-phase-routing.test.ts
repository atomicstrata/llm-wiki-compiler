/**
 * @file test/operations-packs/provider-phase-routing.test.ts
 * @description Routing a compiled provider phase to the provider leg: the host
 * supplies the invocation, the SEAL still decides which provider runs.
 *
 * THE SUCCEEDING CASE IS THE LOAD-BEARING ONE. Three cases here assert a
 * refusal, and a refusal-only suite would stay green if provider phases simply
 * never executed — which is exactly the state this slice changes. The first case
 * drives a provider phase to `succeeded` through the production runner input, so
 * every refusal below is attributable to the property it perturbs rather than to
 * a path that never worked.
 *
 * IT NEARLY SHIPPED UNREACHABLE. The provider leg requires the sealed exposure
 * digest to equal the content exposure of the input specs sent, and the pack
 * authority resolver sealed the run's INITIAL-INPUT digest for every phase — a
 * value no spec set can equal. Routing alone would therefore have produced a
 * provider phase that always failed closed, and a suite that only asserted
 * refusals would have called that done.
 *
 * The drive is the real one: `assembleRunnerInput` and `runPreparation`, over a
 * durably staged run. Only the provider INVOCATION is the host's stub, because
 * launching a sandboxed provider is the one thing a test cannot do offline.
 */

import { afterEach, describe, expect, it } from "vitest";
import { runPreparation } from "../../src/index.js";
import { compilePackAction } from "../../src/operations-packs/compiler.js";
import { assembleRunnerInput } from "../../src/operations-packs/runtime/runner-input.js";
import type {
  PackProviderInvocationV1, ProviderPhaseExecutorV1,
} from "../../src/operations-packs/runtime/runner-input.js";
import { completed } from "./completed-provider.js";
import type { ProviderInvocationRequestV1 } from "../../src/capability-providers/runtime/invoke.js";
import type { PackRecipeV2 } from "../../src/operations-packs/recipe-types.js";
import { compilableRecipe, requestWithRecipe } from "./compile-fixture.js";
import { bindingProviderRequest, providerLegInputFor } from "./provider-invocation-fixture.js";
import { dg } from "./pack-fixture.js";
import { phaseStates, runnerContext, stageCompiledAction, stagedRunTracker } from "./runtime-fixture.js";

const runs = stagedRunTracker();
afterEach(() => runs.cleanupAll());

/** The provider phase's declared id, and the role the fixture pack declares. */
const PROVIDER_PHASE_ID = "extract";

/** The compilable chain plus one independent provider phase. */
function recipeWithProvider(): PackRecipeV2 {
  const recipe = compilableRecipe();
  recipe.phases = [...recipe.phases, {
    phaseId: PROVIDER_PHASE_ID, kind: "provider", dependencies: [], disposition: "required",
    inputBindings: [], outputSchema: [{ fieldId: "summary", valueKind: "string" }],
    bounds: { maxItems: 1, maxOutputBytes: 4096 }, missingInputDisposition: "fail",
    body: { providerRoleId: "primary-model", requestTemplateRef: "render.provider-request" },
  } as unknown as PackRecipeV2["phases"][number]];
  return recipe;
}

/** Drive the provider-bearing action under one host invocation capability. */
async function driveWith(
  providerInvocation: PackProviderInvocationV1 | undefined,
): Promise<Map<string, string>> {
  const action = await compilePackAction(requestWithRecipe(recipeWithProvider()));
  const staged = runs.add(await stageCompiledAction(action));
  await runPreparation(assembleRunnerInput(action, { ...runnerContext(staged), providerInvocation }));
  return phaseStates(staged);
}

describe("a compiled provider phase reaches the provider leg", () => {
  it("SUCCEEDS when the host supplies an invocation that binds the seal", async () => {
    let invoked = 0;
    const states = await driveWith({
      legInputFor: providerLegInputFor,
      invoke: async (...args) => { invoked += 1; return completed(...args); },
    });
    expect(invoked).toBe(1);
    expect(states.get(PROVIDER_PHASE_ID)).toBe("succeeded");
  });

  it("REFUSES when the host supplies no invocation capability at all", async () => {
    expect((await driveWith(undefined)).get(PROVIDER_PHASE_ID)).toBe("failed");
  });

  it("REFUSES the one phase the host declines, and consults it with the SEALED executor", async () => {
    const seen: ProviderPhaseExecutorV1[] = [];
    const states = await driveWith({
      legInputFor: (executor) => { seen.push(executor); return null; },
      invoke: async () => { throw new Error("must not run"); },
    });
    expect(states.get(PROVIDER_PHASE_ID)).toBe("failed");
    // The host is told which provider the PLAN pinned, not asked to choose one.
    expect(seen.map((executor) => executor.providerPinDigest)).toEqual([dg("pin-a")]);
    expect(seen.map((executor) => executor.capabilityId)).toEqual(["model.chat"]);
  });

  it("FAILS CLOSED without invoking when the host's request names another provider", async () => {
    let invoked = 0;
    // The whole point of the seam: supplying the invocation decides WHETHER a
    // provider runs, never WHICH one. A host swapping the pin must not execute.
    const states = await driveWith({
      legInputFor: (executor) => ({
        request: { ...bindingProviderRequest(executor), expectedIdentity: {
          providerPinDigest: dg("pin-b"), capabilityId: executor.capabilityId,
          capabilitySchemaDigest: executor.capabilityContractDigest,
        } } as ProviderInvocationRequestV1,
        host: {} as never, preparationRunId: "run",
      }),
      invoke: async (...args) => { invoked += 1; return completed(...args); },
    });
    expect(invoked).toBe(0);
    // The seal mismatch THROWS out of the leg — the platform's existing contract
    // for drifted provider authority, shared with the non-pack provider path —
    // so the phase lands in the runner's unresolved state rather than a settled
    // `failed`. The safety property is the line above: the wrong provider never
    // ran. The stranding is a host BUG's cost, not a reachable operator flow.
    expect(states.get(PROVIDER_PHASE_ID)).toBe("recovery-required");
  });
});
