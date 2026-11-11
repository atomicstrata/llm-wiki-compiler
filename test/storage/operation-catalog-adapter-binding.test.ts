/**
 * @file test/storage/operation-catalog-adapter-binding.test.ts
 * @description The catalog operation adapter's verdicts as ONE body over
 * `CatalogAdapterStores` (`defineCatalogAdapter`), none of which takes a project
 * root, against the shipped `catalogAdapter`.
 *
 * HOW IT IS BUILT. The existing adapter fixtures build a catalog-create context
 * over a fresh tracked root with its payload published. The shipped adapter
 * walks it on disk (preflight, observe, apply, verify) while the body walks the
 * same context over ONE memory catalog that keeps what is appended. The verdicts
 * must be equal. Memory stores that log every call pin each branch: the payload
 * gate, the observation by mutation identity, the closed record's refusal, the
 * append's bound skip and failure classes, and verify. The last case shows the
 * shipped adapter reaching the founding store and payload reader with the
 * context's root.
 *
 * NOT SHOWN HERE: the founding catalog store itself; its suites and
 * `catalog-adapter.test.ts` show that.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AdapterContext } from "../../src/operation-bundles/adapter-types.js";
import { catalogAdapter, defineCatalogAdapter, type CatalogAdapterStores } from "../../src/operation-bundles/adapters/catalog.js";
import * as shared from "../../src/operation-bundles/adapters/shared.js";
import * as catalogStore from "../../src/operation-bundles/catalog-store.js";
import type { CatalogOperationMutation } from "../../src/operation-bundles/types.js";
import { tempRootTracker } from "../temp-roots.js";
import { CATALOG_PAYLOAD, catalogMutation, makeBinding, makeContext, publishPayload, WORKSPACE_ID } from "../operation-bundles/adapter-fixtures.js";

const tracker = tempRootTracker();
afterEach(async () => { vi.restoreAllMocks(); await tracker.cleanup(); });

/** A catalog-create context over a fresh tracked root, its payload published. */
async function catalogContext() {
  const root = await tracker.create("operation-catalog-adapter-", { real: true });
  const set = makeBinding();
  await publishPayload(root, set.bundleId, CATALOG_PAYLOAD);
  return { root, ctx: makeContext(root, catalogMutation(set), set) as AdapterContext<CatalogOperationMutation> };
}

/** What the memory stores answer instead of the kept catalog, where a case says so. */
interface CatalogWorld { payload?: shared.PayloadRead; catalog?: catalogStore.CatalogStoreRead; append?: catalogStore.CatalogAppendResult | Error }

/** A memory catalog keeping what is appended; each call logged. */
function memoryStores(log: string[], world: CatalogWorld = {}): CatalogAdapterStores {
  const records: catalogStore.CatalogRecord[] = [];
  return {
    readPayload: async () => { log.push("payload"); return world.payload ?? { kind: "ok", bytes: CATALOG_PAYLOAD }; },
    readCatalog: async () => { log.push("catalog"); return world.catalog ?? (records.length === 0 ? { status: "absent" } : { status: "ok", records: [...records] }); },
    append: async (_ws, record) => {
      log.push(`append ${record.logicalRecordId}`);
      if (world.append instanceof Error) throw world.append;
      records.push(record);
      return world.append ?? "created";
    },
  };
}

/** Run one verb over a fresh memory catalog: the verdict and the log. */
async function over(ctx: AdapterContext, verb: "preflight" | "observe" | "apply" | "verify", world: CatalogWorld = {}) {
  const log: string[] = [];
  return [await defineCatalogAdapter(() => memoryStores(log, world))[verb](ctx), log];
}

describe("the catalog adapter as a root-free body", () => {
  it("D1 walks preflight, observe, apply and verify to the same verdicts as the shipped adapter on disk", async () => {
    const { ctx } = await catalogContext();
    const log: string[] = [];
    const stores = memoryStores(log);
    const memory = defineCatalogAdapter(() => stores);
    for (const verb of ["preflight", "observe", "apply", "verify"] as const) {
      expect(await memory[verb](ctx as AdapterContext)).toEqual(await catalogAdapter[verb](ctx as AdapterContext));
    }
    expect(log).toEqual(["payload", "catalog", "payload", "append rec-a", "catalog"]);
  });

  it("P1 preflight needs a readable JSON payload", async () => {
    const { ctx } = await catalogContext();
    expect(await over(ctx as AdapterContext, "preflight", { payload: { kind: "absent" } })).toEqual([{ status: "unavailable", detail: "catalog payload is unreadable" }, ["payload"]]);
    expect(await over(ctx as AdapterContext, "preflight", { payload: { kind: "ok", bytes: Buffer.from("not json") } }))
      .toEqual([{ status: "park", code: "bundle-precondition-conflict", detail: "catalog payload is not JSON" }, ["payload"]]);
  });

  it("O1 an unreadable or invalid catalog is unavailable; only this mutation's record counts as applied", async () => {
    const { ctx } = await catalogContext();
    const at = async (catalog: catalogStore.CatalogStoreRead) => (await over(ctx as AdapterContext, "observe", { catalog }))[0];
    expect(await at({ status: "unavailable", detail: "x" } as never)).toEqual({ outcome: "unavailable", detail: "catalog is unreadable" });
    expect(await at({ status: "invalid", detail: "x" })).toEqual({ outcome: "unavailable", detail: "catalog is unreadable" });
    expect(await at({ status: "ok", records: [] })).toEqual({ outcome: "not-applied" });
    expect((await over(ctx as AdapterContext, "verify", { catalog: { status: "absent" } }))[0]).toEqual({ status: "mismatch", detail: "catalog postcondition not met" });
  });

  it("A1 an unbuildable record is a conflict before any append; the same record is a bound skip; an append fault is classified", async () => {
    const { ctx } = await catalogContext();
    const post = ctx.mutation.postcondition.digest;
    const [invalid, log] = await over(ctx as AdapterContext, "apply", { payload: { kind: "ok", bytes: Buffer.from("not json") } });
    expect([(invalid as { status: string }).status, log]).toEqual(["conflict", ["payload"]]);
    expect((await over(ctx as AdapterContext, "apply", { append: "same" }))[0]).toEqual({ status: "skipped-idempotent", postStateDigest: post, boundToMutation: true });
    expect((await over(ctx as AdapterContext, "apply", { append: new Error("catalog invalid") }))[0]).toEqual({ status: "unavailable", detail: "catalog invalid" });
    expect((await over(ctx as AdapterContext, "apply", { append: new Error("concurrent change") }))[0]).toEqual({ status: "conflict", detail: "concurrent change" });
  });
});

describe("the shipped catalog adapter", () => {
  it("Z1 the body over memory reaches no store; the shipped adapter reaches each with the context's root", async () => {
    const { root, ctx } = await catalogContext();
    const spies = [vi.spyOn(shared, "readBundlePayload"), vi.spyOn(catalogStore, "readCatalogStore"), vi.spyOn(catalogStore, "appendCatalogRecordLocked")];
    await over(ctx as AdapterContext, "apply");
    await over(ctx as AdapterContext, "observe");
    expect(spies.map((spy) => spy.mock.calls.length)).toEqual([0, 0, 0]);
    await catalogAdapter.apply(ctx as AdapterContext);
    await catalogAdapter.observe(ctx as AdapterContext);
    expect(spies.map((spy) => spy.mock.calls[0]?.slice(0, 2))).toEqual([[root, WORKSPACE_ID], [root, WORKSPACE_ID], [root, WORKSPACE_ID]]);
    expect((spies[2]!.mock.calls[0]?.[2] as catalogStore.CatalogRecord).logicalRecordId).toBe("rec-a");
  });
});
