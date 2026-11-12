/**
 * @file test/storage/operation-artifact-adapter-binding.test.ts
 * @description The artifact operation adapter's verdicts as ONE body over
 * `ArtifactAdapterStores` (`defineArtifactAdapter`), none of which takes a
 * project root, against the shipped `artifactAdapter`.
 *
 * HOW IT IS BUILT. The existing adapter fixtures build an artifact-create
 * context over a fresh tracked root with the declaring profile and payload
 * written. The shipped adapter walks it on disk (preflight, observe, apply,
 * verify) with the trusted-write grant, while the body walks the same context
 * over ONE memory artifact store that lands the bytes, the manifest and the
 * bound event on apply. The verdicts must be equal. Memory stores that log every
 * call pin each branch: the undeclared type, the payload digest, an invalid
 * path, the manifest/body/event arms, a duplicate or missing bound event, and
 * the apply failure classes. The last case shows the shipped adapter reaching
 * each incumbent with the context's root.
 *
 * NOT SHOWN HERE: the artifact authority, the artifact readers and the event
 * store themselves; their suites and `artifact-adapter.test.ts` show those.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import { restoreEnv, stubEnv } from "../stubs.js";
import * as artifactApply from "../../src/artifacts/apply.js";
import { ArtifactWriteDeniedError, ArtifactWriteRefusedError } from "../../src/artifacts/apply-guards.js";
import * as artifactStore from "../../src/artifacts/store.js";
import * as eventsRead from "../../src/events/store-read.js";
import type { AdapterContext } from "../../src/operation-bundles/adapter-types.js";
import { artifactAdapter, defineArtifactAdapter, type ArtifactAdapterStores } from "../../src/operation-bundles/adapters/artifact.js";
import * as shared from "../../src/operation-bundles/adapters/shared.js";
import type { ArtifactOperationMutation } from "../../src/operation-bundles/types.js";
import { writeProfileFile } from "../fixtures/profile-fixtures.js";
import { tempRootTracker } from "../temp-roots.js";
import {
  ARTIFACT_BODY, ARTIFACT_PROFILE, artifactMutation, expectApplyFaultsUnavailable, makeBinding, makeContext, publishPayload, WORKSPACE_ID,
} from "../operation-bundles/adapter-fixtures.js";

const tracker = tempRootTracker();
afterEach(async () => { vi.restoreAllMocks(); restoreEnv(); await tracker.cleanup(); });

/** An artifact-create context over a fresh tracked root, with its declaring profile and payload written. */
async function artifactContext() {
  const root = await tracker.create("operation-artifact-adapter-", { real: true });
  await writeProfileFile(root, ARTIFACT_PROFILE);
  const set = makeBinding();
  await publishPayload(root, set.bundleId, Buffer.from(ARTIFACT_BODY, "utf8"));
  return { root, ctx: makeContext(root, artifactMutation(set), set) as AdapterContext<ArtifactOperationMutation> };
}

/** What the memory artifact store answers instead of its own state, where a case says so. */
interface ArtifactWorld {
  profile?: typeof ARTIFACT_PROFILE | null; badPath?: boolean; manifest?: artifactStore.ManifestRead; body?: artifactStore.ArtifactBodyRead;
  bound?: number | Error; applyFault?: Error;
}

/** A memory artifact store that lands bytes, manifest and one bound event on apply; each call logged. */
function memoryStores(ctx: AdapterContext, log: string[], world: ArtifactWorld = {}): ArtifactAdapterStores {
  let landed = false;
  const event = { type: "artifact-write", operationBinding: { mutationId: ctx.auditBinding.mutationId } };
  return {
    loadProfile: async () => { log.push("profile"); return world.profile === null ? undefined : world.profile ?? ARTIFACT_PROFILE; },
    readPayload: async () => { log.push("payload"); return { kind: "ok", bytes: Buffer.from(ARTIFACT_BODY, "utf8") }; },
    location: (type, id, file) => { log.push(`location ${type}/${id}/${file}`); if (world.badPath) throw new Error("unsafe slug"); return { bytesPath: "b", manifestPath: "m", expectedDir: "d", relativeDir: "r" }; },
    readManifest: async () => { log.push("manifest"); return world.manifest ?? (landed ? { kind: "ok", manifest: {} as never } : { kind: "absent" }); },
    readBody: async (_location, maxBytes) => { log.push(`body ${maxBytes}`); return world.body ?? { kind: "ok", body: ARTIFACT_BODY } as never; },
    readEvents: async () => {
      log.push("events");
      if (world.bound instanceof Error) throw world.bound;
      return { events: Array(world.bound ?? (landed ? 1 : 0)).fill(event) } as never;
    },
    applyArtifact: async (planned) => { log.push(`apply ${planned.artifactType}/${planned.slug}`); if (world.applyFault) throw world.applyFault; landed = true; },
  };
}

/** Run one verb over a fresh memory store: the verdict and the log. */
async function over(ctx: AdapterContext, verb: "preflight" | "observe" | "apply" | "verify", world: ArtifactWorld = {}) {
  const log: string[] = [];
  return [await defineArtifactAdapter(() => memoryStores(ctx, log, world))[verb](ctx), log];
}

describe("the artifact adapter as a root-free body", () => {
  it("D1 walks preflight, observe, apply and verify to the same verdicts as the shipped adapter on disk", async () => {
    stubEnv("LLMWIKI_TRUSTED_WRITE", "research");
    const { ctx } = await artifactContext();
    const log: string[] = [];
    const stores = memoryStores(ctx as AdapterContext, log);
    const memory = defineArtifactAdapter(() => stores);
    for (const verb of ["preflight", "observe", "apply", "verify"] as const) {
      expect(await memory[verb](ctx as AdapterContext)).toEqual(await artifactAdapter[verb](ctx as AdapterContext));
    }
    const observed = ["profile", "location note/a/note.txt", "manifest"];
    expect(log).toEqual(["profile", "payload", ...observed, "payload", "apply note/a", ...observed, "body 65536", "events",
      ...observed, "body 65536", "events"]);
  });

  it("P1 an undeclared type is unavailable before any read; a payload off the declared digest parks", async () => {
    const { ctx } = await artifactContext();
    expect(await over(ctx as AdapterContext, "preflight", { profile: null })).toEqual([{ status: "unavailable", detail: "artifact type is undeclared" }, ["profile"]]);
    expect(await over(ctx as AdapterContext, "observe", { profile: null })).toEqual([{ outcome: "unavailable", detail: "artifact type is undeclared" }, ["profile"]]);
    const drifted = { ...ctx, mutation: { ...ctx.mutation, postcondition: { ...ctx.mutation.postcondition, digest: `sha256:${"7".repeat(64)}` } } } as AdapterContext;
    expect((await over(drifted, "preflight"))[0]).toEqual({ status: "park", code: "bundle-precondition-conflict", detail: "artifact payload digest mismatch" });
  });

  it("O1 maps an invalid path, an unreadable manifest or body, a missing body and a digest mismatch, each stopping there", async () => {
    const { ctx } = await artifactContext();
    const present = { kind: "ok", manifest: {} } as never;
    const at = (world: ArtifactWorld) => over(ctx as AdapterContext, "observe", world);
    expect(await at({ badPath: true })).toEqual([{ outcome: "unavailable", detail: "artifact path is invalid" }, ["profile", "location note/a/note.txt"]]);
    expect((await at({ manifest: { kind: "malformed" } }))[0]).toEqual({ outcome: "unavailable", detail: "artifact manifest is unreadable" });
    expect((await at({ manifest: present, body: { kind: "oversize", actualBytes: 1 } }))[0]).toEqual({ outcome: "unavailable", detail: "artifact body is unreadable" });
    expect((await at({ manifest: present, body: { kind: "absent" } as never }))[0]).toEqual({ outcome: "partially-applied", detail: "manifest present, body missing" });
    expect((await at({ manifest: present, body: { kind: "ok", body: "other" } as never }))[0]).toEqual({ outcome: "conflict", detail: "artifact body digest mismatch" });
  });

  it("E1 requires exactly one bound event: none is an audit repair, two a conflict, an unreadable store unavailable", async () => {
    const { ctx } = await artifactContext();
    const present = { kind: "ok", manifest: {} } as never;
    const at = async (bound: number | Error) => (await over(ctx as AdapterContext, "observe", { manifest: present, bound }))[0];
    expect(await at(0)).toEqual({ outcome: "partially-applied", auditRepairOnly: true, detail: "artifact present, audit event missing" });
    expect(await at(2)).toEqual({ outcome: "conflict", detail: "duplicate artifact event for mutation" });
    expect(await at(new Error("EIO"))).toEqual({ outcome: "unavailable", detail: "event store is unreadable" });
  });

  it("A1 classifies the authority's refusals: denied is a conflict, refused and any other fault unavailable, with no re-observe", async () => {
    const { ctx } = await artifactContext();
    const denied = new ArtifactWriteDeniedError("note", "deny" as never, ["blocked"]);
    expect(await over(ctx as AdapterContext, "apply", { applyFault: denied })).toEqual([{ status: "conflict", detail: denied.message }, ["payload", "apply note/a"]]);
    await expectApplyFaultsUnavailable(async (applyFault) => (await over(ctx as AdapterContext, "apply", { applyFault }))[0],
      [new ArtifactWriteRefusedError("note"), new Error("disk full")]);
  });
});

describe("the shipped artifact adapter", () => {
  it("Z1 the body over memory reaches no incumbent; the shipped adapter reaches each with the context's root", async () => {
    stubEnv("LLMWIKI_TRUSTED_WRITE", "research");
    const { root, ctx } = await artifactContext();
    const spies = [vi.spyOn(shared, "loadProfileOrUndefined"), vi.spyOn(shared, "readBundlePayload"), vi.spyOn(artifactStore, "artifactPaths"),
      vi.spyOn(artifactStore, "readArtifactManifest"), vi.spyOn(artifactStore, "readArtifactBody"), vi.spyOn(eventsRead, "readEvents"), vi.spyOn(artifactApply, "applyArtifactLocked")];
    await over(ctx as AdapterContext, "apply");
    expect(spies.map((spy) => spy.mock.calls.length)).toEqual(Array(7).fill(0));
    await artifactAdapter.apply(ctx as AdapterContext);
    expect(spies.map((spy) => spy.mock.calls[0]?.[0])).toEqual(Array(7).fill(root));
    // The authority resolves artifactPaths itself before the adapter's re-observe
    // does, so the ADAPTER's location step is the LAST call, not the first.
    const paths = spies[2]!.mock.calls;
    expect([paths.length >= 2, paths.at(-1), spies[1]!.mock.calls[0]?.[1], spies[6]!.mock.calls[0]?.[2]]).toEqual([
      true, [root, "note", "a", "note.txt"], WORKSPACE_ID, expect.objectContaining({ mutationId: ctx.auditBinding.mutationId }),
    ]);
  });
});
