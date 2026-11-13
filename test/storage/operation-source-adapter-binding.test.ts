/**
 * @file test/storage/operation-source-adapter-binding.test.ts
 * @description The retained-source operation adapter's verdicts as ONE body over
 * `SourceAdapterStores` (`defineSourceAdapter`), none of which takes a project
 * root, against the shipped `sourceAdapter`.
 *
 * HOW IT IS BUILT. A real source bundle is staged on disk. The shipped adapter
 * walks it on disk (preflight, observe, apply, verify) while the body walks the
 * same context over ONE memory stores instance, which answers the retained
 * payload as read there and keeps the retained leaf. The verdicts must be equal.
 * Memory stores that log every call pin each branch: the content-address gate,
 * the payload digest, the observation's invalid-path/unreadable/mismatch arms,
 * the create-or-same publication and its failure classes, and that an invalid
 * workspace still rejects rather than reading as unavailable. The last case shows
 * the shipped adapter reaching each incumbent with the context's root.
 *
 * NOT SHOWN HERE: the durable leaf reader and the create-only store themselves;
 * the source-store and executor suites show those.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AdapterContext } from "../../src/operation-bundles/adapter-types.js";
import * as shared from "../../src/operation-bundles/adapters/shared.js";
import { defineSourceAdapter, sourceAdapter, type SourceAdapterStores } from "../../src/operation-bundles/adapters/source.js";
import * as durableLeaf from "../../src/operation-bundles/durable-leaf.js";
import { readOperationManifest } from "../../src/operation-bundles/manifest-store.js";
import * as sourceStore from "../../src/operation-bundles/source-store.js";
import type { SourceRetainMutation } from "../../src/operation-bundles/types.js";
import { stageSourceBundle, WORKSPACE } from "../operation-bundles/executor-fixtures.js";
import { tempRootTracker } from "../temp-roots.js";

const tracker = tempRootTracker();
afterEach(async () => { vi.restoreAllMocks(); await tracker.cleanup(); });

const BYTES = Buffer.from("retained source\n");

/** A staged source bundle and the adapter context for its one mutation, with its payload as read on disk. */
async function sourceContext() {
  const root = await tracker.create("operation-source-adapter-", { real: true });
  const staged = await stageSourceBundle(root, BYTES);
  const read = await readOperationManifest(root, WORKSPACE, staged.bundleId);
  if (read.status !== "ok") throw new Error("staged manifest unreadable");
  const mutation = read.manifest.mutations[0] as SourceRetainMutation;
  const ctx = { root, workspaceId: WORKSPACE, manifest: read.manifest, mutation, authority: {}, auditBinding: {}, clock: { now: () => new Date() } } as unknown as AdapterContext<SourceRetainMutation>;
  return { root, ctx, payload: await shared.readBundlePayload(root, WORKSPACE, staged.bundleId, mutation.payloadRef) };
}
type SourceCase = Awaited<ReturnType<typeof sourceContext>>;

/** What the memory stores answer. `leaves` are the retained reads in order (the last repeats); an Error rejects. */
interface SourceWorld { payload?: shared.PayloadRead; leaves?: Array<{ kind: string; body?: Buffer } | Error>; write?: "created" | "same" | Error; badWorkspace?: boolean }

/** Memory source stores over a case; each call logged. */
function memoryStores(seed: SourceCase, log: string[], world: SourceWorld = {}): SourceAdapterStores {
  const leaves = [...(world.leaves ?? [{ kind: "absent" }, { kind: "ok", body: BYTES }])];
  return {
    readPayload: async () => { log.push("payload"); return world.payload ?? seed.payload; },
    retainedSources: () => {
      log.push("sources");
      if (world.badWorkspace) throw new Error("invalid workspace id");
      return { read: async () => { log.push("leaf"); const next = (leaves.length > 1 ? leaves.shift() : leaves[0])!; if (next instanceof Error) throw next; return next as never; } };
    },
    writeRetained: async () => { log.push("write"); if (world.write instanceof Error) throw world.write; return world.write ?? "created"; },
  };
}

/** Run one verb over fresh memory stores: the verdict (or rejection) and the log. */
async function over(seed: SourceCase, verb: "preflight" | "observe" | "apply" | "verify", world: SourceWorld = {}, ctx = seed.ctx) {
  const log: string[] = [];
  const verdict = await defineSourceAdapter(() => memoryStores(seed, log, world))[verb](ctx as AdapterContext).catch((error: Error) => error.message);
  return [verdict, log];
}

describe("the source adapter as a root-free body", () => {
  it("D1 walks preflight, observe, apply and verify to the same verdicts as the shipped adapter on disk", async () => {
    const seed = await sourceContext();
    const log: string[] = [];
    const stores = memoryStores(seed, log);
    const memory = defineSourceAdapter(() => stores);
    for (const verb of ["preflight", "observe", "apply", "verify"] as const) {
      expect(await memory[verb](seed.ctx as AdapterContext)).toEqual(await sourceAdapter[verb](seed.ctx as AdapterContext));
    }
    expect(log).toEqual(["payload", "sources", "leaf", "payload", "write", "sources", "leaf"]);
  });

  it("P1 parks a non-content-address target before any read, and gates the payload on presence and digest", async () => {
    const seed = await sourceContext();
    const notHex = { ...seed.ctx, mutation: { ...seed.ctx.mutation, target: { ...seed.ctx.mutation.target, digest: "../escape" } } };
    expect(await over(seed, "preflight", {}, notHex)).toEqual([{ status: "park", code: "bundle-precondition-conflict", detail: "retained source target is not a content-address digest" }, []]);
    expect(await over(seed, "observe", {}, notHex)).toEqual([{ outcome: "conflict", detail: "retained source target is not a content-address digest" }, []]);
    expect(await over(seed, "preflight", { payload: { kind: "absent" } })).toEqual([{ status: "unavailable", detail: "retained source payload is unreadable" }, ["payload"]]);
    expect(await over(seed, "preflight", { payload: { kind: "ok", bytes: Buffer.from("x") } })).toEqual([{ status: "park", code: "bundle-precondition-conflict", detail: "retained source payload digest mismatch" }, ["payload"]]);
  });

  it("O1 observes an invalid path, an unreadable leaf and a digest mismatch, and an invalid workspace still rejects", async () => {
    const seed = await sourceContext();
    const at = async (leaf: SourceWorld["leaves"]) => (await over(seed, "observe", { leaves: leaf }))[0];
    expect(await at([new Error("EINVAL")])).toEqual({ outcome: "unavailable", detail: "retained source path is invalid" });
    expect(await at([{ kind: "unavailable" }])).toEqual({ outcome: "unavailable", detail: "retained source is unreadable" });
    expect(await at([{ kind: "ok", body: Buffer.from("x") }])).toEqual({ outcome: "conflict", detail: "retained source digest mismatch" });
    expect(await over(seed, "observe", { badWorkspace: true })).toEqual(["invalid workspace id", ["sources"]]);
  });

  it("A1 publishes create-only: identical bytes are an unbound skip; a write fault is unavailable or a conflict by its message", async () => {
    const seed = await sourceContext();
    const post = seed.ctx.mutation.postcondition.digest;
    expect((await over(seed, "apply", { write: "same" }))[0]).toEqual({ status: "skipped-idempotent", postStateDigest: post, boundToMutation: false });
    expect((await over(seed, "apply", { write: new Error("store unavailable") }))[0]).toEqual({ status: "unavailable", detail: "store unavailable" });
    expect((await over(seed, "apply", { write: new Error("collision") }))[0]).toEqual({ status: "conflict", detail: "collision" });
    expect((await over(seed, "verify", { leaves: [{ kind: "absent" }] }))[0]).toEqual({ status: "mismatch", detail: "retained source postcondition not met" });
  });

  it("A2 reads the postcondition digest once, AFTER the write and inside its classification, so a faulting read is classified", async () => {
    const seed = await sourceContext();
    const post = seed.ctx.mutation.postcondition.digest;
    const log: string[] = [];
    const watched = (fault?: Error) => ({
      ...seed.ctx, mutation: { ...seed.ctx.mutation, postcondition: { get digest() { log.push("digest"); if (fault) throw fault; return post; } } },
    }) as AdapterContext;
    const adapter = defineSourceAdapter(() => memoryStores(seed, log));
    expect(await adapter.apply(watched())).toEqual({ status: "applied", postStateDigest: post });
    expect(log).toEqual(["payload", "write", "digest"]);
    log.length = 0;
    expect(await adapter.apply(watched(new Error("digest gone")))).toEqual({ status: "conflict", detail: "digest gone" });
    expect(log).toEqual(["payload", "write", "digest"]);
  });
});

describe("the shipped source adapter", () => {
  it("Z1 the body over memory reaches no incumbent; the shipped adapter reaches each with the context's root", async () => {
    const seed = await sourceContext();
    const spies = [vi.spyOn(shared, "readBundlePayload"), vi.spyOn(durableLeaf, "readDurableOperationLeafBuffer"), vi.spyOn(sourceStore, "writeRetainedSourceCreateOnly")];
    await over(seed, "apply");
    await over(seed, "observe");
    expect(spies.map((spy) => spy.mock.calls.length)).toEqual([0, 0, 0]);
    await sourceAdapter.apply(seed.ctx as AdapterContext);
    await sourceAdapter.observe(seed.ctx as AdapterContext);
    expect(spies.map((spy) => spy.mock.calls[0]?.[0])).toEqual([seed.root, seed.root, seed.root]);
    expect(spies[2]!.mock.calls[0]?.[1]).toEqual({ workspaceId: WORKSPACE, digest: seed.ctx.mutation.target.digest });
  });
});
