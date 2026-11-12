/**
 * @file test/storage/operation-relation-adapter-binding.test.ts
 * @description The relation operation adapter's verdicts as ONE body over
 * `RelationAdapterStores` (`defineRelationAdapter`), none of which takes a
 * project root, against the shipped `relationAdapter`.
 *
 * HOW IT IS BUILT. The existing adapter fixtures build a relation-create
 * context over a fresh tracked root with the declaring profile. The shipped
 * adapter walks it on disk (preflight, observe, apply, verify) while the body
 * walks the same context over ONE memory graph that records a bound relation and
 * its child event on create. The verdicts must be equal. Memory stores that log
 * every call pin each branch: no profile, invalid content, the declared-digest
 * and promise refusals, an unreadable store, duplicate authority, a present
 * relation without its event, an unbound satisfaction that names its record, and
 * the append's outcomes. The last case shows the shipped adapter reaching each
 * incumbent with the context's root.
 *
 * NOT SHOWN HERE: the operation-aware relation seam and the readers themselves;
 * their suites and `relation-adapter.test.ts` show those.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import * as eventsRead from "../../src/events/store-read.js";
import type { AdapterContext } from "../../src/operation-bundles/adapter-types.js";
import { defineRelationAdapter, relationAdapter, type RelationAdapterStores } from "../../src/operation-bundles/adapters/relation.js";
import * as shared from "../../src/operation-bundles/adapters/shared.js";
import type { RelationOperationMutation } from "../../src/operation-bundles/types.js";
import * as operationWrite from "../../src/relations/operation-write.js";
import { buildRelationRef } from "../../src/relations/store.js";
import * as relationsRead from "../../src/relations/store-read.js";
import { writeProfileFile } from "../fixtures/profile-fixtures.js";
import { tempRootTracker } from "../temp-roots.js";
import { makeBinding, makeContext, RELATION_INPUT, RELATION_PROFILE, relationMutation } from "../operation-bundles/adapter-fixtures.js";

const tracker = tempRootTracker();
afterEach(async () => { vi.restoreAllMocks(); await tracker.cleanup(); });

/** A relation-create context over a fresh tracked root with the declaring profile. */
async function relationContext(relationType = "related") {
  const root = await tracker.create("operation-relation-adapter-", { real: true });
  await writeProfileFile(root, RELATION_PROFILE);
  const set = makeBinding();
  return { root, ctx: makeContext(root, relationMutation(set, relationType), set) as AdapterContext<RelationOperationMutation> };
}

/** What the memory graph holds or answers, where a case says so. */
interface RelationWorld {
  profile?: null; records?: Array<{ bound: boolean }>; events?: number; readFault?: Error;
  append?: operationWrite.RelationOperationApply | Error;
}

/** A memory graph recording a bound relation and its child event on create; each call logged. */
function memoryStores(ctx: AdapterContext, log: string[], world: RelationWorld = {}): RelationAdapterStores {
  const binding = { mutationId: ctx.auditBinding.mutationId };
  const record = (bound: boolean) => ({ ref: buildRelationRef(RELATION_PROFILE, RELATION_INPUT, "rel_x"), ...(bound ? { operationBinding: binding } : {}) });
  const records = (world.records ?? []).map(({ bound }) => record(bound));
  let events = world.events ?? 0;
  return {
    loadProfile: async () => { log.push("profile"); return world.profile === null ? undefined : RELATION_PROFILE; },
    readRelations: async () => { log.push("relations"); if (world.readFault) throw world.readFault; return { records: [...records] } as never; },
    readEvents: async () => { log.push("events"); return { events: Array(events).fill({ operationBinding: binding }) } as never; },
    appendForOperation: async (_profile, input, _binding, promisedId) => {
      log.push(`append ${input.type} ${promisedId}`);
      if (world.append instanceof Error) throw world.append;
      if (world.append) return world.append;
      records.push(record(true));
      events += 1;
      return { status: "created", ref: record(true).ref, event: {} as never };
    },
  };
}

/** Run one verb over a fresh memory graph: the verdict and the log. */
async function over(ctx: AdapterContext, verb: "preflight" | "observe" | "apply" | "verify", world: RelationWorld = {}) {
  const log: string[] = [];
  return [await defineRelationAdapter(() => memoryStores(ctx, log, world))[verb](ctx), log];
}

describe("the relation adapter as a root-free body", () => {
  it("D1 walks preflight, observe, apply and verify to the same verdicts as the shipped adapter on disk", async () => {
    const { ctx } = await relationContext();
    const log: string[] = [];
    const stores = memoryStores(ctx as AdapterContext, log);
    const memory = defineRelationAdapter(() => stores);
    for (const verb of ["preflight", "observe", "apply", "verify"] as const) {
      expect(await memory[verb](ctx as AdapterContext)).toEqual(await relationAdapter[verb](ctx as AdapterContext));
    }
    const observed = ["relations", "events", "profile"];
    expect(log).toEqual(["profile", ...observed, "profile", "append related rel_x", ...observed]);
  });

  it("P1 no profile is unavailable; content the profile rejects parks preflight and fails the declared digest", async () => {
    const { ctx } = await relationContext();
    expect(await over(ctx as AdapterContext, "preflight", { profile: null })).toEqual([{ status: "unavailable", detail: "no profile is active" }, ["profile"]]);
    expect((await over(ctx as AdapterContext, "observe", { profile: null }))[0]).toEqual({ outcome: "unavailable", detail: "no profile is active" });
    const { ctx: undeclared } = await relationContext("undeclared");
    expect((await over(undeclared as AdapterContext, "preflight"))[0]).toMatchObject({ status: "park", code: "bundle-precondition-conflict" });
    expect(await over(undeclared as AdapterContext, "observe")).toEqual([{ outcome: "conflict", detail: "relation postcondition digest is not the declared content hash" }, ["relations", "events"]]);
  });

  it("O1 an unreadable store, duplicate authority, a missing event and an unbound satisfaction each classify there", async () => {
    const { ctx } = await relationContext();
    const post = ctx.mutation.postcondition.digest;
    const at = async (world: RelationWorld) => (await over(ctx as AdapterContext, "observe", world))[0];
    expect(await at({ readFault: new Error("EIO") })).toEqual({ outcome: "unavailable", detail: "relation or event store is unreadable" });
    expect(await at({ records: [{ bound: true }, { bound: true }], events: 1 })).toEqual({ outcome: "conflict", detail: "duplicate relation authority for mutation" });
    expect(await at({ records: [{ bound: false }] })).toEqual({ outcome: "partially-applied", auditRepairOnly: true, detail: "relation present, child audit event missing" });
    expect(await at({ records: [{ bound: false }], events: 1 })).toEqual({ outcome: "applied", postStateDigest: post, boundToMutation: false, detail: "content satisfied by existing relation rel_x" });
  });

  it("A1 refuses a non-relation promised id before any append; classifies the seam's fault, conflict and named dedupe", async () => {
    const { ctx } = await relationContext();
    const post = ctx.mutation.postcondition.digest;
    const notRel = { ...ctx, mutation: { ...ctx.mutation, postcondition: { ...ctx.mutation.postcondition, recordId: "x_1" } } } as AdapterContext;
    expect(await over(notRel, "apply")).toEqual([{ status: "conflict", detail: "relation postcondition recordId is not a relation id" }, ["profile"]]);
    expect((await over(ctx as AdapterContext, "apply", { append: new Error("lock lost") }))[0]).toEqual({ status: "unavailable", detail: "lock lost" });
    expect((await over(ctx as AdapterContext, "apply", { append: { status: "conflict", detail: "id taken" } }))[0]).toEqual({ status: "conflict", detail: "id taken" });
    const kept = { status: "skipped-idempotent", ref: { id: "rel_old" }, bound: false } as never;
    expect((await over(ctx as AdapterContext, "apply", { append: kept }))[0]).toEqual({ status: "skipped-idempotent", postStateDigest: post, boundToMutation: false, detail: "content satisfied by existing relation rel_old" });
  });
});

describe("the shipped relation adapter", () => {
  it("Z1 the body over memory reaches no incumbent; the shipped adapter reaches each with the context's root", async () => {
    const { root, ctx } = await relationContext();
    const spies = [vi.spyOn(shared, "loadProfileOrUndefined"), vi.spyOn(relationsRead, "readRelationRecords"), vi.spyOn(eventsRead, "readEvents"), vi.spyOn(operationWrite, "appendRelationForOperationLocked")];
    await over(ctx as AdapterContext, "apply");
    await over(ctx as AdapterContext, "observe");
    expect(spies.map((spy) => spy.mock.calls.length)).toEqual([0, 0, 0, 0]);
    await relationAdapter.apply(ctx as AdapterContext);
    await relationAdapter.observe(ctx as AdapterContext);
    expect(spies.map((spy) => spy.mock.calls[0]?.[0])).toEqual([root, root, root, root]);
    expect([(spies[3]!.mock.calls[0]?.[3] as { mutationId: string }).mutationId, spies[3]!.mock.calls[0]?.[4]]).toEqual([ctx.auditBinding.mutationId, "rel_x"]);
  });
});
