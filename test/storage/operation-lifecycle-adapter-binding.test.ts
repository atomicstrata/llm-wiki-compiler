/**
 * @file test/storage/operation-lifecycle-adapter-binding.test.ts
 * @description The lifecycle operation adapter's verdicts as ONE body over
 * `LifecycleAdapterStores` (`defineLifecycleAdapter`), none of which takes a
 * project root, against the shipped `lifecycleAdapter`.
 *
 * HOW IT IS BUILT. The existing adapter fixtures build a draft -> published
 * context over a fresh tracked root with the declaring profile, and the page is
 * written in each real state. The shipped adapter's preflight, observe and
 * verify on disk must equal the body's over memory stores answering that same
 * state. For apply, the authority's own refusal of an invalid transition is
 * captured on disk and handed to the memory store, so both classify the same
 * error. Memory stores that log every call pin each branch: no active
 * lifecycle, the page's unreadable/absent arms, a duplicate or missing bound
 * event, an unreadable event store, the apply failure classes, and a successful
 * transition re-observed. The last case shows the shipped adapter reaching each
 * incumbent with the context's root.
 *
 * NOT SHOWN HERE: the lifecycle authority and the confined page reader
 * themselves; their suites and `lifecycle-adapter.test.ts` show those.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "bun:test";
import { appendBoundEventLocked } from "../../src/events/store.js";
import * as eventsRead from "../../src/events/store-read.js";
import type { AdapterContext } from "../../src/operation-bundles/adapter-types.js";
import { defineLifecycleAdapter, lifecycleAdapter, type LifecycleAdapterStores } from "../../src/operation-bundles/adapters/lifecycle.js";
import * as shared from "../../src/operation-bundles/adapters/shared.js";
import type { LifecycleOperationMutation } from "../../src/operation-bundles/types.js";
import * as lifecycleApply from "../../src/trust/lifecycle-apply.js";
import { writeProfileFile } from "../fixtures/profile-fixtures.js";
import { tempRootTracker } from "../temp-roots.js";
import {
  digestOf, expectApplyFaultsUnavailable, LIFECYCLE_OTHER, LIFECYCLE_POST, LIFECYCLE_PRE, LIFECYCLE_PROFILE, lifecycleMutation, makeBinding, makeContext,
} from "../operation-bundles/adapter-fixtures.js";

const tracker = tempRootTracker();
afterEach(async () => { vi.restoreAllMocks(); await tracker.cleanup(); });

/** A draft -> published context over a fresh tracked root, its page written as `page`, with `bound` audit events. */
async function lifecycleContext(page: Buffer, bound = 0) {
  const root = await tracker.create("operation-lifecycle-adapter-", { real: true });
  await writeProfileFile(root, LIFECYCLE_PROFILE);
  await mkdir(path.join(root, "wiki", "docs"), { recursive: true });
  await writeFile(path.join(root, "wiki", "docs", "a.md"), page);
  const set = makeBinding();
  for (let i = 0; i < bound; i += 1) {
    await appendBoundEventLocked(root, { type: "lifecycle-transition", origin: "sdk", payload: { entityType: "docs", slug: "a", to: "published" }, at: "2026-07-19T00:00:00.000Z" }, set.onDisk);
  }
  return { root, ctx: makeContext(root, lifecycleMutation(set), set) as AdapterContext<LifecycleOperationMutation> };
}

/** What the memory stores answer. A successful apply moves the page to POST with one bound event. */
interface LifecycleWorld { profile?: typeof LIFECYCLE_PROFILE | null; page?: shared.LeafDigest; bound?: number | Error; applyFault?: Error }

/** Memory lifecycle stores; each call logged. */
function memoryStores(ctx: AdapterContext, log: string[], world: LifecycleWorld = {}): LifecycleAdapterStores {
  let transitioned = false;
  const event = { type: "lifecycle-transition", operationBinding: { mutationId: ctx.auditBinding.mutationId } };
  return {
    loadProfile: async () => { log.push("profile"); return world.profile === null ? undefined : world.profile ?? LIFECYCLE_PROFILE; },
    readEntityPage: async (def, slug) => {
      log.push(`page ${def.directory}/${slug}`);
      return transitioned ? { kind: "ok", digest: digestOf(LIFECYCLE_POST) } : world.page ?? { kind: "ok", digest: digestOf(LIFECYCLE_PRE) };
    },
    readEvents: async () => {
      log.push("events");
      if (world.bound instanceof Error) throw world.bound;
      return { events: Array(transitioned ? 1 : world.bound ?? 0).fill(event) } as never;
    },
    applyLifecycle: async (planned) => { log.push(`apply ${planned.slug} -> ${planned.toState}`); if (world.applyFault) throw world.applyFault; transitioned = true; },
  };
}

/** Run one verb over fresh memory stores: the verdict and the log. */
async function over(ctx: AdapterContext, verb: "preflight" | "observe" | "apply" | "verify", world: LifecycleWorld = {}) {
  const log: string[] = [];
  return [await defineLifecycleAdapter(() => memoryStores(ctx, log, world))[verb](ctx), log];
}

describe("the lifecycle adapter as a root-free body", () => {
  it("D1 answers each real page state as the shipped adapter does on disk", async () => {
    for (const [page, bound] of [[LIFECYCLE_PRE, 0], [LIFECYCLE_POST, 1], [LIFECYCLE_POST, 0], [LIFECYCLE_OTHER, 0]] as const) {
      const { ctx } = await lifecycleContext(page, bound);
      const world = { page: { kind: "ok", digest: digestOf(page) } as shared.LeafDigest, bound };
      for (const verb of ["preflight", "observe", "verify"] as const) {
        expect((await over(ctx as AdapterContext, verb, world))[0]).toEqual(await lifecycleAdapter[verb](ctx as AdapterContext));
      }
    }
  });

  it("D2 classifies the authority's own refusal of an invalid transition exactly as the shipped adapter does", async () => {
    const { root, ctx } = await lifecycleContext(LIFECYCLE_OTHER);
    const refusal = await lifecycleApply.applyLifecycleLocked(root, { kind: "lifecycle-transition", entityType: "docs", slug: "a", toState: "published" }).catch((error: Error) => error);
    expect(refusal).toBeInstanceOf(Error);
    const [memory, log] = await over(ctx as AdapterContext, "apply", { applyFault: refusal as Error });
    expect([memory, log]).toEqual([await lifecycleAdapter.apply(ctx as AdapterContext), ["apply a -> published"]]);
  });

  it("P1 no active lifecycle is unavailable before the page is read", async () => {
    const { ctx } = await lifecycleContext(LIFECYCLE_PRE);
    expect(await over(ctx as AdapterContext, "preflight", { profile: null })).toEqual([{ status: "unavailable", detail: "entity type has no active lifecycle" }, ["profile"]]);
    expect(await over(ctx as AdapterContext, "observe", { profile: null })).toEqual([{ outcome: "unavailable", detail: "entity type has no active lifecycle" }, ["profile"]]);
  });

  it("O1 an unreadable or absent page, an unreadable event store and a duplicate event each stop there", async () => {
    const { ctx } = await lifecycleContext(LIFECYCLE_PRE);
    const post = { kind: "ok", digest: digestOf(LIFECYCLE_POST) } as shared.LeafDigest;
    const at = (world: LifecycleWorld) => over(ctx as AdapterContext, "observe", world);
    expect(await at({ page: { kind: "unavailable" } })).toEqual([{ outcome: "unavailable", detail: "lifecycle page is unreadable" }, ["profile", "page wiki/docs/a"]]);
    expect((await at({ page: { kind: "absent" } }))[0]).toEqual({ outcome: "conflict", detail: "lifecycle page is absent" });
    expect(await at({ page: post, bound: new Error("EIO") })).toEqual([{ outcome: "unavailable", detail: "event store is unreadable" }, ["profile", "page wiki/docs/a", "events"]]);
    expect((await at({ page: post, bound: 2 }))[0]).toEqual({ outcome: "conflict", detail: "duplicate lifecycle event for mutation" });
  });

  it("A1 a transition re-observes to applied; an unavailable or unknown fault is unavailable with no re-observe", async () => {
    const { ctx } = await lifecycleContext(LIFECYCLE_PRE);
    expect(await over(ctx as AdapterContext, "apply")).toEqual([{ status: "applied", postStateDigest: digestOf(LIFECYCLE_POST) },
      ["apply a -> published", "profile", "page wiki/docs/a", "events"]]);
    const unavailable = new lifecycleApply.LifecycleTransitionUnavailableError("no-page", "page is gone");
    expect(await over(ctx as AdapterContext, "apply", { applyFault: unavailable })).toEqual([{ status: "unavailable", detail: unavailable.message }, ["apply a -> published"]]);
    await expectApplyFaultsUnavailable(async (applyFault) => (await over(ctx as AdapterContext, "apply", { applyFault }))[0], [new Error("disk full")]);
  });
});

describe("the shipped lifecycle adapter", () => {
  it("Z1 the body over memory reaches no incumbent; the shipped adapter reaches each with the context's root", async () => {
    const { root, ctx } = await lifecycleContext(LIFECYCLE_OTHER);
    const spies = [vi.spyOn(shared, "loadProfileOrUndefined"), vi.spyOn(shared, "confinedLeafDigest"), vi.spyOn(eventsRead, "readEvents"), vi.spyOn(lifecycleApply, "applyLifecycleLocked")];
    await over(ctx as AdapterContext, "apply");
    await over(ctx as AdapterContext, "observe", { page: { kind: "ok", digest: digestOf(LIFECYCLE_POST) } });
    expect(spies.map((spy) => spy.mock.calls.length)).toEqual([0, 0, 0, 0]);
    await lifecycleAdapter.apply(ctx as AdapterContext);
    await lifecycleAdapter.observe(ctx as AdapterContext);
    expect(spies.map((spy) => spy.mock.calls[0]?.[0])).toEqual([root, root, root, root]);
    expect((spies[3]!.mock.calls[0]?.[2] as { mutationId: string }).mutationId).toBe(ctx.auditBinding.mutationId);
  });
});
