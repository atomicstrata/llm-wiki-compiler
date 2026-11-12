/**
 * @file test/storage/operation-page-adapter-binding.test.ts
 * @description The page operation adapter's four verdicts as ONE body over
 * `PageAdapterStores` (`definePageAdapter`), none of which takes a project root,
 * against the shipped `pageAdapter`.
 *
 * HOW IT IS BUILT. A real page-update bundle is staged on disk over a real page.
 * The shipped adapter walks it on disk (preflight, observe, apply, verify) while
 * the body walks the same context over memory stores, which answer the retained
 * payload as read there and keep the page's digest. The verdicts must be equal.
 * Memory stores that log every call pin each branch: the payload gate, the
 * observation of absent/pre/post/neither, the planner's clearance and operation
 * match, the post-apply re-read, and verify. The last case shows the shipped
 * adapter reaching each incumbent with the context's root.
 *
 * NOT SHOWN HERE: the trust planner, the page authority and the confined page
 * read themselves; the page journey and trust suites show those.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AdapterContext } from "../../src/operation-bundles/adapter-types.js";
import { definePageAdapter, pageAdapter, type PageAdapterStores } from "../../src/operation-bundles/adapters/page.js";
import * as shared from "../../src/operation-bundles/adapters/shared.js";
import { readOperationManifest } from "../../src/operation-bundles/manifest-store.js";
import type { OperationDigest, PageOperationMutation } from "../../src/operation-bundles/types.js";
import * as trustExecutor from "../../src/trust/executor.js";
import * as planner from "../../src/trust/planner.js";
import { payloadDigest, stagePageUpdateBundle, WORKSPACE } from "../operation-bundles/executor-fixtures.js";
import { tempRootTracker } from "../temp-roots.js";

const tracker = tempRootTracker();
afterEach(async () => { vi.restoreAllMocks(); await tracker.cleanup(); });

const FROM = Buffer.from("---\ntitle: P\n---\nOld body.\n"), TO = Buffer.from("---\ntitle: P\n---\nNew body.\n");
const digestOf = (bytes: Buffer) => `sha256:${payloadDigest(bytes)}` as OperationDigest;

/** A real page with a staged update bundle over it, and the adapter context for its one mutation. */
async function pageContext() {
  const root = await tracker.create("operation-page-adapter-", { real: true });
  await mkdir(path.join(root, "wiki", "concepts"), { recursive: true });
  await writeFile(path.join(root, "wiki", "concepts", "p.md"), FROM);
  const staged = await stagePageUpdateBundle(root, "concepts", "p", FROM, TO);
  const read = await readOperationManifest(root, WORKSPACE, staged.bundleId);
  if (read.status !== "ok") throw new Error("staged manifest unreadable");
  const mutation = read.manifest.mutations[0] as PageOperationMutation;
  const ctx = { root, workspaceId: WORKSPACE, manifest: read.manifest, mutation, authority: {}, auditBinding: {}, clock: { now: () => new Date() } } as unknown as AdapterContext<PageOperationMutation>;
  const payload = await shared.readBundlePayload(root, WORKSPACE, staged.bundleId, mutation.payloadRef);
  return { root, ctx, payload };
}
type PageCase = Awaited<ReturnType<typeof pageContext>>;

/** What the memory stores answer. `pages` are the page digests in read order (the last repeats). */
interface PageWorld { payload?: shared.PayloadRead; pages?: shared.LeafDigest[]; plan?: { decision: string; planned: Array<{ operation: string }> } }

/** Memory page stores over a case; each call logged. */
function memoryStores(seed: PageCase, log: string[], world: PageWorld = {}): PageAdapterStores {
  const pages = [...(world.pages ?? [{ kind: "ok", digest: digestOf(FROM) }, { kind: "ok", digest: digestOf(TO) }])];
  return {
    readPayload: async () => { log.push("payload"); return world.payload ?? seed.payload; },
    readPageDigest: async () => { log.push("page"); return (pages.length > 1 ? pages.shift() : pages[0])!; },
    planPage: async (input) => { log.push(`plan ${input.allowOverwrite}`); return (world.plan ?? { decision: "allow", planned: [{ operation: "update" }] }) as never; },
    applyPlanned: async () => { log.push("land"); },
  };
}

/** Walk one verb over memory: the verdict and the log. */
async function over(seed: PageCase, verb: "preflight" | "observe" | "apply" | "verify", world: PageWorld = {}, ctx = seed.ctx) {
  const log: string[] = [];
  return [await definePageAdapter(() => memoryStores(seed, log, world))[verb](ctx as AdapterContext), log];
}

describe("the page adapter as a root-free body", () => {
  it("D1 walks preflight, observe, apply and verify to the same verdicts as the shipped adapter on disk", async () => {
    const seed = await pageContext();
    const log: string[] = [];
    // ONE stores instance for the whole walk, so the page reads FROM before the effect and TO after it.
    const stores = memoryStores(seed, log, { pages: [{ kind: "ok", digest: digestOf(FROM) }, { kind: "ok", digest: digestOf(TO) }] });
    const memory = definePageAdapter(() => stores);
    for (const verb of ["preflight", "observe", "apply", "verify"] as const) {
      expect(await memory[verb](seed.ctx as AdapterContext)).toEqual(await pageAdapter[verb](seed.ctx as AdapterContext));
    }
    expect(log).toEqual(["payload", "page", "payload", "plan true", "land", "page", "page"]);
  });

  it("P1 preflight refuses an unreadable or missing payload and parks one whose digest is not the postcondition", async () => {
    const seed = await pageContext();
    expect(await over(seed, "preflight", { payload: { kind: "unavailable" } })).toEqual([{ status: "unavailable", detail: "page payload is unreadable" }, ["payload"]]);
    expect(await over(seed, "preflight", { payload: { kind: "absent" } })).toEqual([{ status: "unavailable", detail: "page payload is missing" }, ["payload"]]);
    expect(await over(seed, "preflight", { payload: { kind: "ok", bytes: Buffer.from("other") } }))
      .toEqual([{ status: "park", code: "bundle-precondition-conflict", detail: "page payload digest mismatch" }, ["payload"]]);
  });

  it("O1 observes the precondition as not applied, the postcondition as applied unbound, and anything else as a conflict", async () => {
    const seed = await pageContext();
    const at = (page: shared.LeafDigest) => over(seed, "observe", { pages: [page] }).then(([verdict]) => verdict);
    expect(await at({ kind: "ok", digest: digestOf(FROM) })).toEqual({ outcome: "not-applied" });
    expect(await at({ kind: "ok", digest: digestOf(TO) })).toEqual({ outcome: "applied", postStateDigest: digestOf(TO), boundToMutation: false });
    expect(await at({ kind: "ok", digest: digestOf(Buffer.from("x")) })).toEqual({ outcome: "conflict", detail: "page digest matches neither precondition nor postcondition" });
    expect(await at({ kind: "absent" })).toEqual({ outcome: "conflict", detail: "expected existing page is absent" });
    expect(await at({ kind: "unavailable" })).toEqual({ outcome: "unavailable", detail: "page is unreadable" });
  });

  it("A1 apply refuses an uncleared or mismatched plan before landing, and proves the postcondition by re-reading", async () => {
    const seed = await pageContext();
    expect(await over(seed, "apply", { plan: { decision: "review", planned: [] } })).toEqual([{ status: "conflict", detail: "page not cleared for live write (review)" }, ["payload", "plan true"]]);
    expect(await over(seed, "apply", { plan: { decision: "allow", planned: [{ operation: "create" }] } })).toEqual([{ status: "conflict", detail: "planned operation does not match the manifest" }, ["payload", "plan true"]]);
    expect((await over(seed, "apply", { pages: [{ kind: "unavailable" }] }))[0]).toEqual({ status: "unavailable", detail: "page could not be re-read after apply" });
    expect((await over(seed, "apply", { pages: [{ kind: "ok", digest: digestOf(FROM) }] }))[0]).toEqual({ status: "conflict", detail: "post-apply page digest mismatch" });
    expect(await over(seed, "apply", { payload: { kind: "absent" } })).toEqual([{ status: "unavailable", detail: "page payload is unreadable" }, ["payload"]]);
  });

  it("V1 verify needs the postcondition; a delete is verified absent or refused as still present", async () => {
    const seed = await pageContext();
    expect((await over(seed, "verify", { pages: [{ kind: "absent" }] }))[0]).toEqual({ status: "mismatch", detail: "page postcondition digest not met" });
    const deleting = { ...seed.ctx, mutation: { ...seed.ctx.mutation, operation: "delete", postcondition: { kind: "absent" } } } as never;
    expect((await over(seed, "verify", { pages: [{ kind: "absent" }] }, deleting))[0]).toEqual({ status: "verified-absent" });
    expect((await over(seed, "verify", { pages: [{ kind: "ok", digest: digestOf(FROM) }] }, deleting))[0]).toEqual({ status: "mismatch", detail: "page still present after delete" });
    expect((await over(seed, "observe", { pages: [{ kind: "absent" }] }, deleting))[0]).toEqual({ outcome: "applied", boundToMutation: false });
  });
});

describe("the shipped page adapter", () => {
  it("Z1 the body over memory reaches no incumbent; the shipped adapter reaches each with the context's root", async () => {
    const seed = await pageContext();
    const spies = [vi.spyOn(shared, "readBundlePayload"), vi.spyOn(shared, "readPageDigest"), vi.spyOn(planner, "planPageMutation"), vi.spyOn(trustExecutor, "applyApprovedMutationsLocked")];
    await over(seed, "apply");
    expect(spies.map((spy) => spy.mock.calls.length)).toEqual([0, 0, 0, 0]);
    await pageAdapter.apply(seed.ctx as AdapterContext);
    expect(spies.map((spy) => spy.mock.calls[0]?.[0])).toEqual([seed.root, seed.root, expect.objectContaining({ root: seed.root, allowOverwrite: true, deleting: false }), seed.root]);
    expect(spies[0]!.mock.calls[0]?.slice(1)).toEqual([WORKSPACE, seed.ctx.manifest.bundleId, seed.ctx.mutation.payloadRef]);
  });
});
