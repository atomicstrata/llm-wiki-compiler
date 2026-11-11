/**
 * @file test/storage/artifact-evidence-specs-binding.test.ts
 * @description The artifact-evidence spec builder as ONE body over its reads,
 * `buildArtifactEvidenceSpecsFrom`, bound through `artifactEvidenceSpecReadsOver`,
 * with no project directory. This file uses both, which exist only after the
 * builder was given reads of its own, so it has NO before-edit run.
 *
 * HOW IT IS BUILT. The synthetic member-bearing `bundle` is written on disk ONCE
 * through the real write authority: the profile, the manifest body and the root
 * builder's answer are taken, then the directory is removed. Memory reads answer
 * from those values (the member bytes are the fixture's own) and log every
 * call, so the body is required to answer as the disk did, and every refusal
 * (the sealed columns, the profile, health, the body, its binding to the ref,
 * drift, each member's read, the byte cap and the rehash) is pinned with the
 * reads it made. The bound composition and the root form are shown reaching
 * their readers with exact arguments.
 *
 * NOT SHOWN HERE: the resolver, confinement and the write authority; the artifact
 * evidence, member and resolver suites show those.
 */

import { rm } from "node:fs/promises";
import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { formatArtifactRef, type ArtifactRef } from "../../src/artifacts/ref.js";
import * as resolve from "../../src/artifacts/resolve.js";
import * as store from "../../src/artifacts/store.js";
import {
  artifactEvidenceSpecReadsOver, buildArtifactEvidenceSpecs, buildArtifactEvidenceSpecsFrom, type ArtifactEvidenceSpecReads,
} from "../../src/operations-packs/runtime/artifact-evidence.js";
import * as block from "../../src/profile/block.js";
import type { LoadedProfile } from "../../src/profile/types.js";
import { EVIDENCE_DESCRIPTOR, forgeSecondDigest, sealedBundleValue } from "../fixtures/artifact-evidence-fixture.js";
import { bundlePaths, makeMembersRoot, twoMembers, writeBundle } from "../fixtures/member-artifact-root.js";

afterEach(() => { vi.restoreAllMocks(); });

const MEMBERS = new Map(twoMembers().map((file) => [file.fileName, Buffer.from(file.bytes)]));
let REF: ArtifactRef, LOADED: LoadedProfile, BODY: string, ON_DISK: unknown, SEALED: Record<string, unknown>;

beforeAll(async () => {
  const root = await makeMembersRoot("aev-binding-");
  try {
    REF = await writeBundle(root, twoMembers());
    SEALED = sealedBundleValue(REF);
    LOADED = (await block.loadNonDefaultProfile(root))!;
    const read = await store.readArtifactBody(root, bundlePaths(root), 65536);
    if (read.kind !== "ok") throw new Error("the minted bundle did not read back");
    BODY = read.body;
    ON_DISK = await buildArtifactEvidenceSpecs(root, EVIDENCE_DESCRIPTOR, SEALED);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** What the reads answer; anything left out answers as the disk did. */
interface World { loaded?: LoadedProfile | null; health?: string; body?: unknown; member?: Record<string, unknown> }

/** Memory reads over `world`, each call logged. */
function readsOf(log: string[], world: World = {}): ArtifactEvidenceSpecReads {
  return {
    nonDefaultProfile: async () => { log.push("profile"); return world.loaded === null ? undefined : world.loaded ?? LOADED; },
    resolve: async (_profile, ref) => { log.push(`resolve ${ref.slug}`); return { health: world.health ?? "ok" } as never; },
    readBody: async (type, slug, fileName, max) => { log.push(`body ${type}/${slug}/${fileName} ${max}`); return (world.body ?? { kind: "ok", body: BODY }) as never; },
    readMember: async (type, slug, fileName, member, max) => {
      log.push(`member ${type}/${slug}/${fileName} ${member} ${max}`);
      return (world.member?.[member] ?? { kind: "ok", body: MEMBERS.get(member) }) as never;
    },
  };
}

/** Build over `world` and `value`: the outcome (or its reason) and the log. */
async function build(world: World = {}, value = SEALED, descriptor = EVIDENCE_DESCRIPTOR): Promise<[unknown, string[]]> {
  const log: string[] = [];
  const built = await buildArtifactEvidenceSpecsFrom(readsOf(log, world), descriptor, value);
  return [built.status === "ok" ? built : built.reason, log];
}

const PRE = ["profile", "resolve probe", "body bundle/probe/bundle.json 65536"];
const MEMBER_READS = ["member bundle/probe/bundle.json figure.bin 4096", "member bundle/probe/bundle.json main.tex 4096"];

describe("the spec builder's one body over memory reads", () => {
  it("S1 builds exactly what the disk built: profile, health, body, then each member in manifest order", async () => {
    expect(ON_DISK).toMatchObject({ status: "ok" });
    expect(await build()).toEqual([ON_DISK, [...PRE, ...MEMBER_READS]]);
  });

  it("S2 refuses unsealed columns, the item cap and a bad ref before any read", async () => {
    expect(await build({}, { ...SEALED, "member-digests": undefined })).toEqual(["artifact-evidence-columns-invalid", []]);
    expect(await build({}, SEALED, { ...EVIDENCE_DESCRIPTOR, maxItems: 1 })).toEqual(["artifact-evidence-over-item-cap", []]);
    expect(await build({}, { ...SEALED, "bundle-ref": "not-a-ref" })).toEqual(["artifact-evidence-ref-invalid", []]);
  });

  it("S3 refuses no profile, a memberless type, an unhealthy bundle, an unread or raced body, and drift, each after its own read", async () => {
    const memberless = { ...LOADED, profile: { ...LOADED.profile, artifacts: {} } } as LoadedProfile;
    expect(await build({ loaded: null })).toEqual(["artifact-evidence-no-profile", PRE.slice(0, 1)]);
    expect(await build({ loaded: memberless })).toEqual(["artifact-evidence-not-member-bearing", PRE.slice(0, 1)]);
    expect(await build({ health: "artifact-bytes-tampered" })).toEqual(["artifact-evidence-unhealthy-artifact-bytes-tampered", PRE.slice(0, 2)]);
    expect(await build({ body: { kind: "absent" } })).toEqual(["artifact-evidence-manifest-absent", PRE]);
    expect(await build({ body: { kind: "ok", body: `${BODY} ` } })).toEqual(["artifact-evidence-manifest-raced", PRE]);
    const unparsed = { ...SEALED, "bundle-ref": formatArtifactRef({ ...REF, sha256: store.hashArtifactBody("not json") }) };
    expect(await build({ body: { kind: "ok", body: "not json" } }, unparsed)).toEqual(["artifact-evidence-manifest-unparseable", PRE]);
    expect(await build({}, forgeSecondDigest(SEALED))).toEqual(["artifact-evidence-manifest-drift", PRE]);
  });

  it("S4 refuses an unread member, the running byte cap, and a member that no longer hashes to its sealed digest", async () => {
    expect(await build({ member: { "main.tex": { kind: "unavailable" } } })).toEqual(["artifact-evidence-member-unavailable", [...PRE, ...MEMBER_READS]]);
    expect(await build({}, SEALED, { ...EVIDENCE_DESCRIPTOR, maxBytes: 1 })).toEqual(["artifact-evidence-over-byte-cap", [...PRE, MEMBER_READS[0]]]);
    const swapped = { kind: "ok", body: Buffer.alloc(MEMBERS.get("figure.bin")!.length, 0x41) };
    expect(await build({ member: { "figure.bin": swapped } })).toEqual(["artifact-evidence-digest-drift", [...PRE, MEMBER_READS[0]]]);
  });
});

describe("the bound composition and the root form", () => {
  it("B1 the composition reaches the profile and resolution bodies over their seams and the store's leaves at the ref", async () => {
    const leaves: string[] = [];
    const artifactStore = { artifactAt: (type: string, slug: string, fileName: string) => {
      leaves.push(`at ${type}/${slug}/${fileName}`);
      return { readBodyText: async (max: number) => { leaves.push(`body ${max}`); return { kind: "ok", body: BODY }; },
        readMemberBytes: async (name: string, max: number) => { leaves.push(`member ${name} ${max}`); return { kind: "ok", body: MEMBERS.get(name) }; } };
    } } as unknown as resolve.ArtifactStoreReads;
    const profile = {} as never;
    const loaded = vi.spyOn(block, "loadNonDefaultProfileFrom").mockResolvedValue(LOADED);
    const resolved = vi.spyOn(resolve, "resolveArtifactRefFrom").mockResolvedValue({ health: "ok" } as never);
    expect(await buildArtifactEvidenceSpecsFrom(artifactEvidenceSpecReadsOver(profile, artifactStore), EVIDENCE_DESCRIPTOR, SEALED)).toEqual(ON_DISK);
    expect([loaded.mock.calls, resolved.mock.calls]).toEqual([[[profile]], [[artifactStore, LOADED.profile, REF]]]);
    expect(leaves).toEqual(["at bundle/probe/bundle.json", "body 65536", "at bundle/probe/bundle.json", "member figure.bin 4096", "at bundle/probe/bundle.json", "member main.tex 4096"]);
  });

  it("B2 the root form reaches every incumbent root reader with its old arguments", async () => {
    const paths = store.artifactPaths("/project", "bundle", "probe", "bundle.json");
    vi.spyOn(block, "loadNonDefaultProfile").mockResolvedValue(LOADED);
    const resolved = vi.spyOn(resolve, "resolveArtifactRef").mockResolvedValue({ health: "ok" } as never);
    const body = vi.spyOn(store, "readArtifactBody").mockResolvedValue({ kind: "ok", body: BODY });
    const member = vi.spyOn(store, "readArtifactMemberBytes").mockImplementation(async (_root, leaf) => ({ kind: "ok", body: MEMBERS.get(leaf.split("/").at(-1)!)! }));
    expect(await buildArtifactEvidenceSpecs("/project", EVIDENCE_DESCRIPTOR, SEALED)).toEqual(ON_DISK);
    expect([resolved.mock.calls, body.mock.calls]).toEqual([[["/project", LOADED.profile, REF]], [["/project", paths, 65536]]]);
    expect(member.mock.calls).toEqual(["figure.bin", "main.tex"].map((name) => ["/project", store.memberLeafPath(paths.expectedDir, name), paths.expectedDir, 4096]));
  });
});
