/**
 * @file test/storage/operation-authority-binding.test.ts
 * @description The operations-authority recompute as ONE body over
 * `AuthorityStateReads` (`computeAuthoritySnapshotFrom`), with no project root,
 * against the built-in provider (`createOperationsAuthorityResolver`).
 *
 * HOW IT IS BUILT. A real bundle is staged on disk with the existing fixtures.
 * Its key and profile are read there once and answered from memory, so the body
 * over memory must return the provider's exact snapshot and digest. Memory reads
 * that log every call pin the fail-closed ladder (the key, then the profile,
 * each with its own reason, and every other fault folded into one reason). The
 * provider is shown reading the request's root exactly once, inside that
 * boundary, and reaching the incumbent loaders with it.
 *
 * NOT SHOWN HERE: the twelve components' meaning and drift; the resolver,
 * boundary and drift suites show those.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AuthoritySnapshotRequest } from "../../src/operation-bundles/authority.js";
import * as keyEpoch from "../../src/operation-bundles/key-epoch.js";
import {
  computeAuthoritySnapshotFrom, createOperationsAuthorityResolver, type AuthorityStateReads,
} from "../../src/operation-bundles/operations-authority-resolver.js";
import * as profileLoad from "../../src/profile/load.js";
import { authorityRequestFor, stageSourceBundle } from "../operation-bundles/executor-fixtures.js";
import { tempRootTracker } from "../temp-roots.js";

const tracker = tempRootTracker();
afterEach(async () => { vi.restoreAllMocks(); await tracker.cleanup(); });

const KINDS = ["source-retain", "page"];

/** A staged project's authority request, and its key and profile as read there. */
async function staged() {
  const root = await tracker.create("operation-authority-", { real: true });
  const request = await authorityRequestFor(root, await stageSourceBundle(root));
  return { root, request, key: await keyEpoch.readOperationKey(root), profile: await profileLoad.loadProfile(root) };
}

/** Memory reads answering the staged project, or what a case names; each call logged. */
function memoryReads(seed: Awaited<ReturnType<typeof staged>>, log: string[], over: { key?: keyEpoch.OperationKeyRead | Error; profile?: Error } = {}): AuthorityStateReads {
  return {
    readKey: async () => { log.push("key"); if (over.key instanceof Error) throw over.key; return over.key ?? seed.key; },
    loadProfile: async () => { log.push("profile"); if (over.profile) throw over.profile; return seed.profile; },
  };
}

describe("the authority recompute as a root-free body", () => {
  it("A1 recomputes the same snapshot and digest as the built-in provider, reading the key and then the profile", async () => {
    const seed = await staged();
    const log: string[] = [];
    const memory = await computeAuthoritySnapshotFrom(memoryReads(seed, log), seed.request, KINDS);
    expect(memory).toEqual(await createOperationsAuthorityResolver({ adapterKinds: KINDS }).computeSnapshot(seed.request));
    expect([memory.status, log]).toEqual(["ok", ["key", "profile"]]);
  });

  it("A2 fails closed at each read with its own reason, reading nothing after it, and folds any other fault into one reason", async () => {
    const seed = await staged();
    const run = async (over: Parameters<typeof memoryReads>[2], request: AuthoritySnapshotRequest = seed.request) => {
      const log: string[] = [];
      return [await computeAuthoritySnapshotFrom(memoryReads(seed, log, over), request, KINDS), log];
    };
    expect(await run({ key: { status: "absent" } })).toEqual([{ status: "unavailable", reason: "operation key is absent or unreadable" }, ["key"]]);
    expect(await run({ profile: new Error("broken profile") })).toEqual([{ status: "unavailable", reason: "active profile could not be loaded" }, ["key", "profile"]]);
    expect(await run({ key: new Error("EIO") })).toEqual([{ status: "unavailable", reason: "operation authority recompute failed: EIO" }, ["key"]]);
    const malformed = { ...seed.request, manifest: {} as never };
    expect(await run({}, malformed)).toEqual([{ status: "unavailable", reason: expect.stringMatching(/^operation authority recompute failed: /) }, ["key", "profile"]]);
  });
});

describe("the built-in provider", () => {
  it("P1 reads the request's root once, inside the fail-closed boundary, and reaches the incumbent loaders with it", async () => {
    const seed = await staged();
    const key = vi.spyOn(keyEpoch, "readOperationKey"), profile = vi.spyOn(profileLoad, "loadProfile");
    let reads = 0;
    const counted = { ...seed.request, get root() { reads += 1; return seed.root; } } as AuthoritySnapshotRequest;
    const provider = createOperationsAuthorityResolver({ adapterKinds: KINDS });
    expect((await provider.computeSnapshot(counted)).status).toBe("ok");
    expect([reads, key.mock.calls, profile.mock.calls]).toEqual([1, [[seed.root]], [[seed.root]]]);
    const faulting = { ...seed.request, get root(): string { throw new Error("root gone"); } } as AuthoritySnapshotRequest;
    expect(await provider.computeSnapshot(faulting)).toEqual({ status: "unavailable", reason: "operation authority recompute failed: root gone" });
  });

  it("Z1 the body over memory makes no root-form read", async () => {
    const seed = await staged();
    const spies = [vi.spyOn(keyEpoch, "readOperationKey"), vi.spyOn(profileLoad, "loadProfile")];
    await computeAuthoritySnapshotFrom(memoryReads(seed, []), seed.request, KINDS);
    expect(spies.map((spy) => spy.mock.calls.length)).toEqual([0, 0]);
  });
});
