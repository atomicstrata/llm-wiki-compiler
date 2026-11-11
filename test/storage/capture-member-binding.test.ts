/**
 * @file test/storage/capture-member-binding.test.ts
 * @description One-member artifact capture as ONE body over its three steps,
 * `captureVerifiedMemberArtifactWith`, with no project directory. This file uses
 * it, which exists only after the capture was given steps of its own, so it has
 * NO before-edit run.
 *
 * HOW IT IS BUILT. Memory steps answer the write authority, the profile and the
 * resolution, and log every call, so the ladder (a non-artifact result, no
 * active profile, an unhealthy resolution, a write fault) and the steps each
 * branch must not take are pinned. The bound composition is shown keeping the
 * host's write authority as given and reaching the profile and resolution
 * bodies over their seams; the root form, the incumbent root forms with exact
 * arguments.
 *
 * NOT SHOWN HERE: the write authority, the member manifest and the resolver
 * themselves; the artifact members, apply and resolver suites show those.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import * as resolve from "../../src/artifacts/resolve.js";
import type { ArtifactStoreReads } from "../../src/artifacts/resolve.js";
import {
  captureMemberStepsOver, captureVerifiedMemberArtifact, captureVerifiedMemberArtifactWith, type CaptureMemberSteps,
} from "../../src/artifacts/capture-member.js";
import * as block from "../../src/profile/block.js";
import type { EffectiveProfileSources } from "../../src/profile/load.js";
import type { LoadedProfile } from "../../src/profile/types.js";
import type { ApplyResult } from "../../src/trust/apply-result.js";
import * as executor from "../../src/trust/executor.js";

afterEach(() => { vi.restoreAllMocks(); });

const MEMBER = { fileName: "main.pdf", bytes: Buffer.from("%PDF") };
const INPUT = { artifactType: "bundle", slug: "m1", member: MEMBER, origin: "workflow" } as const;
const MUTATION = { kind: "artifact", artifactType: "bundle", slug: "m1", body: "", memberFiles: [MEMBER], origin: "workflow" };
const REF = { artifactType: "bundle", slug: "m1", sha256: "a".repeat(64) };
const APPLIED = [{ kind: "artifact", ref: REF }] as unknown as ApplyResult[];
const LOADED = { profile: { profileId: "p" }, digest: "d" } as unknown as LoadedProfile;

/** Memory steps answering `world`, each call logged. */
function stepsOf(log: string[], world: { applied?: ApplyResult[] | Error; loaded?: LoadedProfile | null; health?: string } = {}): CaptureMemberSteps {
  return {
    apply: async (planned) => { log.push(`apply ${JSON.stringify(planned)}`); if (world.applied instanceof Error) throw world.applied; return world.applied ?? APPLIED; },
    loadProfile: async () => { log.push("profile"); return world.loaded === null ? undefined : world.loaded ?? LOADED; },
    resolve: async (profile, ref) => { log.push(`resolve ${profile === LOADED.profile} ${ref.slug}`); return { health: world.health ?? "ok" } as never; },
  };
}

/** Capture over `world`: the ref or the refusal message, and the log. */
async function capture(world: Parameters<typeof stepsOf>[1] = {}): Promise<[unknown, string[]]> {
  const log: string[] = [];
  const answer = await captureVerifiedMemberArtifactWith(stepsOf(log, world), INPUT).catch((error: Error) => error.message);
  return [answer, log];
}

const APPLY = `apply ${JSON.stringify([MUTATION])}`;

describe("member capture over its three steps", () => {
  it("M1 applies the one artifact mutation, loads the profile, resolves, and returns the applied ref", async () => {
    expect(await capture()).toEqual([REF, [APPLY, "profile", "resolve true m1"]]);
  });

  it("M2 refuses a non-artifact result before the profile, no profile before resolving, and an unhealthy resolution", async () => {
    const nonArtifact = "member capture returned a non-artifact result";
    expect(await capture({ applied: [] })).toEqual([nonArtifact, [APPLY]]);
    expect(await capture({ applied: [{ kind: "page" }] as unknown as ApplyResult[] })).toEqual([nonArtifact, [APPLY]]);
    expect(await capture({ loaded: null })).toEqual(["member capture requires an active non-default profile", [APPLY, "profile"]]);
    expect(await capture({ health: "artifact-bytes-tampered" })).toEqual(["captured member artifact is not healthy: artifact-bytes-tampered", [APPLY, "profile", "resolve true m1"]]);
    expect(await capture({ applied: new Error("lock busy") })).toEqual(["lock busy", [APPLY]]);
  });
});

describe("the bound composition and the root form", () => {
  it("B1 the composition keeps the host's write authority and reaches the profile and resolution bodies over their seams", async () => {
    const profile = {} as EffectiveProfileSources, store = {} as ArtifactStoreReads;
    const apply = vi.fn(async () => APPLIED);
    const loaded = vi.spyOn(block, "loadNonDefaultProfileFrom").mockResolvedValue(LOADED);
    const resolved = vi.spyOn(resolve, "resolveArtifactRefFrom").mockResolvedValue({ health: "ok" } as never);
    expect(await captureVerifiedMemberArtifactWith(captureMemberStepsOver({ apply, profile, store }), INPUT)).toEqual(REF);
    expect([apply.mock.calls, loaded.mock.calls, resolved.mock.calls]).toEqual([[[[MUTATION]]], [[profile]], [[store, LOADED.profile, REF]]]);
  });

  it("B2 the root form reaches the incumbent root forms with exact arguments", async () => {
    const apply = vi.spyOn(executor, "applyApprovedMutations").mockResolvedValue(APPLIED);
    const loaded = vi.spyOn(block, "loadNonDefaultProfile").mockResolvedValue(LOADED);
    const resolved = vi.spyOn(resolve, "resolveArtifactRef").mockResolvedValue({ health: "ok" } as never);
    expect(await captureVerifiedMemberArtifact("/project", INPUT)).toEqual(REF);
    expect([apply.mock.calls, loaded.mock.calls, resolved.mock.calls]).toEqual([[["/project", [MUTATION]]], [["/project"]], [["/project", LOADED.profile, REF]]]);
  });
});
