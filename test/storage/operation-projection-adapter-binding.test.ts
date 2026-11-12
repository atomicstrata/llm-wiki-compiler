/**
 * @file test/storage/operation-projection-adapter-binding.test.ts
 * @description The projection operation adapter's verdicts as ONE body over
 * `ProjectionAdapterStores` (`defineProjectionAdapter`), none of which takes a
 * project root, against the shipped `projectionAdapter`.
 *
 * HOW IT IS BUILT. The existing adapter fixtures build a required projection
 * context over a fresh tracked root. The shipped adapter walks it on disk
 * (preflight, observe, apply, verify) while the body walks the same context over
 * ONE memory stores instance that answers the store's classification. The
 * verdicts must be equal. Memory stores that log every call pin each branch:
 * the render-digest gate that reads nothing, every store classification, the
 * write's same/created and failure classes, and verify. The last case shows the
 * shipped adapter reaching the founding store with the context's root.
 *
 * NOT SHOWN HERE: the founding projection store itself; its suites and
 * `projection-adapter.test.ts` show that.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AdapterContext } from "../../src/operation-bundles/adapter-types.js";
import { defineProjectionAdapter, projectionAdapter, type ProjectionAdapterStores } from "../../src/operation-bundles/adapters/projection.js";
import * as projectionStore from "../../src/operation-bundles/projection-store.js";
import type { ProjectionOperationMutation } from "../../src/operation-bundles/types.js";
import { tempRootTracker } from "../temp-roots.js";
import { makeBinding, makeContext, projectionMutation } from "../operation-bundles/adapter-fixtures.js";

const tracker = tempRootTracker();
afterEach(async () => { vi.restoreAllMocks(); await tracker.cleanup(); });

/** A required projection context over a fresh tracked root. */
async function projectionContext() {
  const root = await tracker.create("operation-projection-adapter-", { real: true });
  const set = makeBinding();
  return { root, ctx: makeContext(root, projectionMutation(set), set) as AdapterContext<ProjectionOperationMutation> };
}

/** What the memory stores answer: the classifications in order (the last repeats), and the write's result or fault. */
interface ProjectionWorld { observed?: projectionStore.ProjectionObservation[]; write?: projectionStore.ProjectionWriteResult | Error }

/** Memory projection stores; each call logged. */
function memoryStores(log: string[], world: ProjectionWorld = {}): ProjectionAdapterStores {
  const observed = [...(world.observed ?? [{ status: "absent" }, { status: "same", marker: {} as never }])];
  return {
    observe: async (target) => { log.push(`observe ${target.output}`); return (observed.length > 1 ? observed.shift() : observed[0])!; },
    write: async (target) => { log.push(`write ${target.criticality}`); if (world.write instanceof Error) throw world.write; return world.write ?? "created"; },
  };
}

/** Run one verb over fresh memory stores: the verdict and the log. */
async function over(ctx: AdapterContext, verb: "preflight" | "observe" | "apply" | "verify", world: ProjectionWorld = {}) {
  const log: string[] = [];
  return [await defineProjectionAdapter(() => memoryStores(log, world))[verb](ctx), log];
}

describe("the projection adapter as a root-free body", () => {
  it("D1 walks preflight, observe, apply and verify to the same verdicts as the shipped adapter on disk", async () => {
    const { ctx } = await projectionContext();
    const log: string[] = [];
    const stores = memoryStores(log);
    const memory = defineProjectionAdapter(() => stores);
    for (const verb of ["preflight", "observe", "apply", "verify"] as const) {
      expect(await memory[verb](ctx as AdapterContext)).toEqual(await projectionAdapter[verb](ctx as AdapterContext));
    }
    expect(log).toEqual(["observe out.json", "write required", "observe out.json"]);
  });

  it("P1 a render that does not hash to the declared output parks preflight and refuses apply, reading and writing nothing", async () => {
    const { ctx } = await projectionContext();
    const drifted = { ...ctx, mutation: { ...ctx.mutation, postcondition: { digest: `sha256:${"9".repeat(64)}` } } } as AdapterContext;
    expect(await over(drifted, "preflight")).toEqual([{ status: "park", code: "bundle-precondition-conflict", detail: "projection render digest mismatch" }, []]);
    expect(await over(drifted, "apply")).toEqual([{ status: "conflict", detail: "projection render digest mismatch" }, []]);
  });

  it("O1 maps every store classification: absent and replaceable are not applied, same is applied unbound", async () => {
    const { ctx } = await projectionContext();
    const post = ctx.mutation.postcondition.digest;
    const at = async (observed: projectionStore.ProjectionObservation) => (await over(ctx as AdapterContext, "observe", { observed: [observed] }))[0];
    expect(await at({ status: "replaceable", marker: {} as never })).toEqual({ outcome: "not-applied" });
    expect(await at({ status: "same", marker: {} as never })).toEqual({ outcome: "applied", postStateDigest: post, boundToMutation: false });
    expect(await at({ status: "conflict", detail: "foreign output" })).toEqual({ outcome: "conflict", detail: "foreign output" });
    expect(await at({ status: "unavailable", detail: "sidecar unreadable" } as never)).toEqual({ outcome: "unavailable", detail: "sidecar unreadable" });
    expect((await over(ctx as AdapterContext, "verify", { observed: [{ status: "absent" }] }))[0]).toEqual({ status: "mismatch", detail: "projection postcondition not met" });
  });

  it("A1 an identical write is an unbound skip; a write fault is unavailable or a conflict by its message", async () => {
    const { ctx } = await projectionContext();
    const post = ctx.mutation.postcondition.digest;
    expect((await over(ctx as AdapterContext, "apply", { write: "same" }))[0]).toEqual({ status: "skipped-idempotent", postStateDigest: post, boundToMutation: false });
    expect((await over(ctx as AdapterContext, "apply", { write: "replaced" }))[0]).toEqual({ status: "applied", postStateDigest: post });
    expect((await over(ctx as AdapterContext, "apply", { write: new Error("store unavailable") }))[0]).toEqual({ status: "unavailable", detail: "store unavailable" });
    expect((await over(ctx as AdapterContext, "apply", { write: new Error("parent swapped") }))[0]).toEqual({ status: "conflict", detail: "parent swapped" });
  });
});

describe("the shipped projection adapter", () => {
  it("Z1 the body over memory reaches no store; the shipped adapter reaches it with the context's root and target", async () => {
    const { root, ctx } = await projectionContext();
    const spies = [vi.spyOn(projectionStore, "observeProjection"), vi.spyOn(projectionStore, "writeProjectionLocked")];
    await over(ctx as AdapterContext, "apply");
    await over(ctx as AdapterContext, "observe");
    expect(spies.map((spy) => spy.mock.calls.length)).toEqual([0, 0]);
    await projectionAdapter.apply(ctx as AdapterContext);
    await projectionAdapter.observe(ctx as AdapterContext);
    expect(spies.map((spy) => spy.mock.calls[0]?.slice(0, 2))).toEqual([
      [root, expect.objectContaining({ output: "out.json", criticality: "required", outputDigest: ctx.mutation.postcondition.digest })],
      [root, expect.objectContaining({ output: "out.json", criticality: "required", outputDigest: ctx.mutation.postcondition.digest })],
    ]);
  });
});
