/**
 * @file test/products/product-service-capture.test.ts
 * @description The MUTATION WITNESSES for the three product-service hardening
 * fixes an adversarial review found. Each case performs the exact abuse the fix
 * exists to stop, so reverting that one line turns this suite red rather than
 * leaving it green over a guard nobody exercises.
 *
 *  - INPUT DEEP-CAPTURE. The service deep-captures the caller's nested input
 *    record before its first await. Without it the compiler reads the caller's
 *    own object several awaits later, so a field mutated in between changes the
 *    plan the run is sealed against. The case races exactly that and pins the
 *    result to the ORIGINAL value's plan digest — with a discriminating control
 *    proving the mutated value compiles to a DIFFERENT digest, so the equality
 *    cannot pass by both inputs meaning the same thing.
 *  - CLOCK PINNING. The service binds `clock.now` at construction. Without it a
 *    caller retaining the deps object can replace the method afterwards and
 *    restamp a run's durable timestamps. The case replaces it and reads the
 *    runner-authored transition back off disk.
 *  - GATED-RECIPE REFUSAL. A gate suspends a run, and only re-driving that SAME
 *    run after an operator decision resumes it; this surface stages a fresh run
 *    per call, so a gated action would strand. The case pairs the refusal with
 *    the identical NON-gated product resolving, so the guard is shown to read the
 *    gate rather than to refuse everything.
 */

import { describe, expect, it } from "vitest";
import type { PackActionInputValueV2 } from "../../src/operations-packs/types.js";
import { readPreparationRun } from "../../src/preparations/run-store.js";
import { resolvePreparationRun } from "../../src/preparations/service-run-lookup.js";
import type { PreparationRunV1 } from "../../src/preparations/run-types.js";
import type {
  ProductInvocationRequestV1, ProductPreviewResultV1, ProductServiceV1,
} from "../../src/products/service.js";
import type { BuiltProductPackage } from "./product-package-fixture.js";
import {
  activatedProject, buildVerticalProduct, gatedVerticalPack, misplacedEntityProduct,
  undeclaredTargetVerticalPack, verticalClock, verticalService,
  VERTICAL_ACTION_ID, VERTICAL_CLOCK_YEAR, VERTICAL_WORKSPACE_ID,
} from "./product-vertical-fixture.js";

/** One invocation request whose nested input record the caller still owns. */
function requestFor(topic: string): ProductInvocationRequestV1 {
  return { workspaceId: VERTICAL_WORKSPACE_ID, token: VERTICAL_ACTION_ID, input: { topic } };
}

/** The plan digest one preview settled on, or the refusal that stopped it. */
function planDigestOf(result: ProductPreviewResultV1): string {
  if (result.status === "refused") throw new Error(`preview refused: ${result.reason}`);
  return result.action.planDigest;
}

/** The plan digest the service compiles for one topic, uncontended. */
async function digestFor(service: ProductServiceV1, topic: string): Promise<string> {
  return planDigestOf(await service.preview(requestFor(topic)));
}

/** The durable run record one invocation produced. */
async function durableRun(root: string, runId: string): Promise<PreparationRunV1> {
  const located = await resolvePreparationRun(root, runId);
  if (!located.ok) throw new Error(`run lookup ${located.failure}`);
  const read = await readPreparationRun(root, located.binding);
  if (read.status !== "ok") throw new Error(`run ${read.status}`);
  return read.run;
}

describe("product service: caller input is captured before the first await", () => {
  it("compiles the value the caller passed, never one mutated after the call", async () => {
    const project = await activatedProject();
    const service = verticalService(project.root);
    const original = await digestFor(service, "original");
    // DISCRIMINATING CONTROL: the two values genuinely compile to different plans,
    // so the equality below cannot pass by the mutation being a no-op.
    expect(await digestFor(service, "mutated")).not.toBe(original);

    // The NESTED record the caller still owns — the exact object the outer request
    // capture reads by own data descriptor and hands on.
    const input: Record<string, PackActionInputValueV2> = { topic: "original" };
    const inFlight = service.preview({ workspaceId: VERTICAL_WORKSPACE_ID, token: VERTICAL_ACTION_ID, input });
    // Synchronous, so it lands after the service's capture and before the compile
    // await that reads the input. Without the deep capture the compiler sees this.
    input.topic = "mutated";

    expect(planDigestOf(await inFlight)).toBe(original);
    await project.cleanup();
  });
});

describe("product service: the clock is pinned at construction", () => {
  it("stamps the run with the clock it was built with, not a later replacement", async () => {
    const project = await activatedProject();
    const clock = verticalClock();
    const service = verticalService(project.root, ["preparation.run"], clock);
    // The caller retains the deps object it passed and swaps the method afterwards.
    clock.now = () => "2099-01-01T00:00:00.000Z";

    const result = await service.invoke(requestFor("superconductivity"));
    if (result.status !== "handed-off") throw new Error(`invoke: ${JSON.stringify(result)}`);
    const run = await durableRun(project.root, result.runId);

    // `handoff-ready` is authored by the runner from the clock the service pinned.
    const finalized = run.transitions.find((entry) => entry.type === "handoff-ready");
    expect(finalized?.at.startsWith(VERTICAL_CLOCK_YEAR)).toBe(true);
    expect(run.transitions.some((entry) => entry.at.startsWith("2099"))).toBe(false);
    await project.cleanup();
  });
});

/** Assert BOTH product verbs refuse `product` with `reasonPart`, and stage nothing. */
async function expectBothVerbsRefused(product: BuiltProductPackage, reasonPart: string): Promise<void> {
  const project = await activatedProject(product);
  const service = verticalService(project.root, ["preparation.run"]);
  const previewed = await service.preview(requestFor("superconductivity"));
  const invoked = await service.invoke(requestFor("superconductivity"));
  expect(previewed.status).toBe("refused");
  expect(previewed.status === "refused" && previewed.reason).toContain(reasonPart);
  expect(invoked.status).toBe("refused");
  expect(invoked.status === "refused" && invoked.reason).toContain(reasonPart);
  await project.cleanup();
}

/** The discriminating control: the standard vertical (declared target in its own directory, no gate) resolves. */
async function expectStandardVerticalResolves(): Promise<void> {
  const project = await activatedProject();
  const service = verticalService(project.root);
  expect((await service.preview(requestFor("superconductivity"))).status).not.toBe("refused");
  await project.cleanup();
}

describe("product service: a recipe declaring a review gate", () => {
  // A gated recipe used to be refused on both verbs: the surface staged a fresh
  // run per call and had no route back from a suspended one, so declining beat
  // stranding. It now DRIVES the run to its gate and reports `awaiting-review`,
  // because `resume` re-drives that same run once an operator has answered — the
  // route exists, so refusing would withhold the very review the gate is for.
  it("DRIVES to the gate and reports awaiting-review rather than refusing", async () => {
    const project = await activatedProject(buildVerticalProduct(gatedVerticalPack()));
    const service = verticalService(project.root, ["preparation.run"]);
    const outcome = await service.invoke(requestFor("superconductivity"));
    expect(outcome.status, JSON.stringify(outcome)).toBe("awaiting-review");
    if (outcome.status !== "awaiting-review") throw new Error("unreachable");
    expect(outcome.gateIds.length).toBeGreaterThan(0);
    await project.cleanup();
  });
  // Only the recipe differs from the standard vertical, so the behaviour above and a
  // resolution here isolate the gate rather than a guard refusing everything.
  it("does not refuse the SAME product without the gate", () => expectStandardVerticalResolves());
});

describe("product service: an action targeting an entity type the profile never declares", () => {
  // The obligation would otherwise author a `page` create for an entity type the
  // installed product's profile does not declare, which the page adapter would
  // later write unchecked; the resolver refuses it against the loaded profile.
  it("is refused on both verbs before any run stages, so no invalid mutation is authored", () =>
    expectBothVerbsRefused(buildVerticalProduct(undeclaredTargetVerticalPack()), "entity type"));
  // Only the target profile class differs from the standard vertical.
  it("does not refuse the SAME action whose target the profile DOES declare", () =>
    expectStandardVerticalResolves());
});

describe("product service: an entity declared OUTSIDE the wiki/<entityType> directory", () => {
  // The type IS declared, so the round-2 check passes; but its profile stores it
  // under `wiki/pages` while the page create writes `wiki/wiki-page`, so the bundle
  // would propose a write outside the entity's own declared namespace. The resolver
  // refuses on the DIRECTORY, and the reason names it — distinct from the
  // undeclared-type refusal above.
  it("is refused on both verbs, because its create would write outside its declared directory", () =>
    expectBothVerbsRefused(misplacedEntityProduct(), "directory"));
  // Only the declared directory differs from the standard vertical (which declares
  // its entity under wiki/<entityType>), so a refusal above and a resolution here
  // isolate the directory check rather than a guard refusing every declared entity.
  it("does not refuse the SAME action whose entity IS declared under wiki/<entityType>", () =>
    expectStandardVerticalResolves());
});
