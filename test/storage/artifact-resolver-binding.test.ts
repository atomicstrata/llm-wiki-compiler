/**
 * @file test/storage/artifact-resolver-binding.test.ts
 * @description The artifact resolver over its leaf reads. This file uses
 * `readVerifiedArtifactFrom`, which exists only after the resolver was given a
 * store to ask, so it has NO before-edit run, except R11b, which calls the
 * root form and needs no file.
 *
 * There is no project directory. ONE in-memory double stands for the artifact
 * store: `artifactAt` and the four reads of the leaves it hands back
 * (`manifest`, `body`, `entries`, `member`). It decides nothing: each call
 * logs to one ordered log BEFORE it answers, then serves what the case holds
 * for that artifact, or `absent`. Sidecar text is hashed with the production
 * hash, and member bodies are built by the production member-manifest builder.
 *
 * The production resolver runs on what the double serves: the declared-type
 * gate, where and how often the location is asked for, manifest then body
 * always, the caps it passes, the real manifest parse, the whole verdict
 * ladder in its order, and for a member-bearing type the sweep and the member
 * reads, stopping at the first unhealthy one.
 *
 * NOT SHOWN HERE: anything about the disk. The double confines nothing, opens
 * no handle and checks no link; `artifacts/artifact-resolve.test.ts`,
 * `artifact-resolve-storefault.test.ts`, `artifact-members-tamper.test.ts` and
 * `artifact-content.test.ts` show the resolver on real files, the last one
 * including that the metadata resolver never carries a body.
 *
 * The double is not a hosted store, not an access-control layer and not
 * `ProjectStore`.
 */

import { describe, expect, it } from "bun:test";
import { buildMemberManifest } from "../../src/artifacts/members.js";
import type { ArtifactRef } from "../../src/artifacts/ref.js";
import { readVerifiedArtifact, readVerifiedArtifactFrom, type ArtifactStoreReads } from "../../src/artifacts/resolve.js";
import { ArtifactPathError, hashArtifactBody, type ArtifactBodyRead, type ArtifactMemberRead } from "../../src/artifacts/store.js";
import type { ProfilePack } from "../../src/profile/types.js";
import type { ConfinedDirListing } from "../../src/utils/confined-dir.js";
import type { CappedLeafRead } from "../../src/utils/confined-read.js";
import { researchArtifactPreconditionProfile, RESEARCH_ARTIFACT_FILE, RESEARCH_ARTIFACT_TYPE } from "../fixtures/artifact-precondition-profiles.js";
import { BUNDLE_FILE, BUNDLE_TYPE, membersBlock, twoMembers } from "../fixtures/member-artifact-root.js";

const RESULT = RESEARCH_ARTIFACT_TYPE;
const BODY_CAP = 4096;
const MANIFEST_CAP = 64 * 1024;
/** The shared research artifact profile with a body cap that differs from the sidecar's, so the two caps are told apart in the log. */
const PROFILE = researchArtifactPreconditionProfile();
PROFILE.artifacts![RESULT].maxBytes = BODY_CAP;
/** A member-bearing type, over the shared member policy. */
const BUNDLES: Pick<ProfilePack, "artifacts"> = {
  artifacts: { [BUNDLE_TYPE]: { fileName: BUNDLE_FILE, contentKind: "json", maxBytes: 65536, members: membersBlock() } },
};
const BODY = `{"accuracy":0.9}`;

/** What the double holds for one artifact; a leaf that is not held is `absent`. */
interface HeldArtifact {
  manifest?: CappedLeafRead;
  body?: ArtifactBodyRead;
  entries?: ConfinedDirListing;
  members?: Record<string, ArtifactMemberRead>;
}
type Held = Record<string, HeldArtifact>;

/** The store double over one ordered log. `refuse`, when given, is thrown by `artifactAt` after it logs. */
function storeOf(held: Held, calls: string[], refuse?: Error): ArtifactStoreReads {
  return { artifactAt: (artifactType, slug, fileName) => {
    const at = `${artifactType}/${slug}`;
    calls.push(`artifactAt ${at} ${fileName}`);
    if (refuse) throw refuse;
    const artifact = held[at] ?? {};
    return {
      readManifestText: async (maxBytes) => { calls.push(`manifest ${at} max=${maxBytes}`); return artifact.manifest ?? { kind: "absent" }; },
      readBodyText: async (maxBytes) => { calls.push(`body ${at} max=${maxBytes}`); return artifact.body ?? { kind: "absent" }; },
      listEntries: async (maxEntries) => { calls.push(`entries ${at} max=${maxEntries}`); return artifact.entries ?? { kind: "absent" }; },
      readMemberBytes: async (name, maxBytes) => { calls.push(`member ${at}/${name} max=${maxBytes}`); return artifact.members?.[name] ?? { kind: "absent" }; },
    };
  } };
}

const text = (body: string): { kind: "ok"; body: string } => ({ kind: "ok", body });
/** A sidecar's parsed form for `body`, hashed by the production hash; `over` replaces fields to make it lie. */
const sidecar = (artifactType: string, slug: string, body: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  artifactType, slug, sha256: hashArtifactBody(body), bytes: Buffer.byteLength(body, "utf8"), contentKind: "json", writtenAt: "2026-01-01T00:00:00Z", ...over,
});
const refOf = (slug: string, body: string = BODY, artifactType: string = RESULT): ArtifactRef => ({ artifactType, slug, sha256: hashArtifactBody(body) });
/** One `experiment-result` artifact with an honest sidecar; `over` makes the sidecar lie. */
const result = (slug: string, body: string = BODY, over: Record<string, unknown> = {}): HeldArtifact =>
  ({ manifest: text(JSON.stringify(sidecar(RESULT, slug, body, over))), body: text(body) });
/** The location, then the manifest, then the body: what every resolve of a declared `experiment-result` asks first. */
const READS = (slug: string): string[] => [
  `artifactAt ${RESULT}/${slug} ${RESEARCH_ARTIFACT_FILE}`, `manifest ${RESULT}/${slug} max=${MANIFEST_CAP}`, `body ${RESULT}/${slug} max=${BODY_CAP}`,
];
const resolve = async (held: Held, ref: ArtifactRef, profile: Pick<ProfilePack, "artifacts"> = PROFILE) => {
  const calls: string[] = [];
  return { verdict: await readVerifiedArtifactFrom(storeOf(held, calls), profile, ref), calls };
};
const unavailable = { kind: "unavailable" as const };
const healthOf = async (held: Held, ref: ArtifactRef = refOf("a")): Promise<string> => (await resolve(held, ref)).verdict.health;

describe("the artifact resolver over its leaf reads: order and gates", () => {
  it("R1 locates, reads the manifest then the body under their own caps, and returns the verified body", async () => {
    const { verdict, calls } = await resolve({ [`${RESULT}/a`]: result("a") }, refOf("a"));
    expect(verdict).toEqual({ health: "ok", manifest: sidecar(RESULT, "a", BODY), body: BODY });
    expect(calls).toEqual(READS("a"));
  });

  it("R2 answers dangling for an undeclared type and asks nothing, not even for the location", async () => {
    const { verdict, calls } = await resolve({}, refOf("a", BODY, "undeclared-type"));
    expect([verdict, calls]).toEqual([{ health: "artifact-dangling" }, []]);
  });

  it("R3 reads the body even when the manifest is absent, and carries a parsed manifest when only the body is absent", async () => {
    const noManifest = await resolve({ [`${RESULT}/a`]: { body: text(BODY) } }, refOf("a"));
    expect([noManifest.verdict, noManifest.calls]).toEqual([{ health: "artifact-dangling" }, READS("a")]);
    const noBody = await resolve({ [`${RESULT}/a`]: { manifest: result("a").manifest } }, refOf("a"));
    expect(noBody.verdict).toEqual({ health: "artifact-dangling", manifest: sidecar(RESULT, "a", BODY) });
  });

  it("R12 remembers nothing: two resolves over the same store read the manifest and the body twice", async () => {
    const calls: string[] = [];
    const store = storeOf({ [`${RESULT}/a`]: result("a") }, calls);
    const first = await readVerifiedArtifactFrom(store, PROFILE, refOf("a"));
    const second = await readVerifiedArtifactFrom(store, PROFILE, refOf("a"));
    expect([first.health, second.health, calls]).toEqual(["ok", "ok", [...READS("a"), ...READS("a")]]);
  });
});

describe("the artifact resolver over its leaf reads: the verdict ladder", () => {
  it("R4 denies a lying manifest before any readability verdict, even with an unreadable body", async () => {
    const lie = { health: "artifact-store-unavailable", storeFault: "integrity-lie" };
    const otherSlug = await resolve({ [`${RESULT}/a`]: { ...result("b"), body: unavailable } }, refOf("a"));
    expect(otherSlug.verdict).toEqual({ ...lie, manifest: sidecar(RESULT, "b", BODY) });
    const otherKind = await resolve({ [`${RESULT}/a`]: { ...result("a", BODY, { contentKind: "text" }), body: { kind: "absent" } } }, refOf("a"));
    expect(otherKind.verdict).toMatchObject(lie);
  });

  it("R5 tells absent, unavailable and malformed apart, with the real manifest parse", async () => {
    expect(await healthOf({ [`${RESULT}/a`]: { manifest: unavailable, body: text(BODY) } })).toBe("artifact-unreadable");
    const honest = await resolve({ [`${RESULT}/a`]: { ...result("a"), body: unavailable } }, refOf("a"));
    expect(honest.verdict).toEqual({ health: "artifact-unreadable", manifest: sidecar(RESULT, "a", BODY) });
    const malformed = { health: "artifact-store-unavailable", storeFault: "genuine-fault" };
    for (const raw of ["{ not json", "{}", JSON.stringify(sidecar(RESULT, "a", BODY, { sha256: "short" }))]) {
      expect((await resolve({ [`${RESULT}/a`]: { manifest: text(raw), body: text(BODY) } }, refOf("a"))).verdict).toEqual(malformed);
    }
    expect(await healthOf({ [`${RESULT}/a`]: { manifest: text("{ not json") } })).toBe("artifact-dangling");
  });

  it("R6 reads an oversize body against the recorded length: a different size is tampered, the same size unreadable", async () => {
    const recorded = Buffer.byteLength(BODY, "utf8");
    const grown = await resolve({ [`${RESULT}/a`]: { ...result("a"), body: { kind: "oversize", actualBytes: recorded + 1 } } }, refOf("a"));
    expect(grown.verdict).toEqual({ health: "artifact-bytes-tampered", manifest: sidecar(RESULT, "a", BODY) });
    expect(await healthOf({ [`${RESULT}/a`]: { ...result("a"), body: { kind: "oversize", actualBytes: recorded } } })).toBe("artifact-unreadable");
    expect(await healthOf({ [`${RESULT}/a`]: { manifest: text("{}"), body: { kind: "oversize", actualBytes: 9 } } })).toBe("artifact-store-unavailable");
  });

  it("R7 checks the recorded length, then the manifest's hash, then the ref's hash, then the body contract", async () => {
    const otherHash = hashArtifactBody("another body");
    const lengthLie = await resolve({ [`${RESULT}/a`]: result("a", BODY, { bytes: 1, sha256: otherHash }) }, refOf("a"));
    expect(lengthLie.verdict).toMatchObject({ health: "artifact-store-unavailable", storeFault: "integrity-lie" });
    expect(await healthOf({ [`${RESULT}/a`]: result("a", BODY, { sha256: otherHash }) }, { ...refOf("a"), sha256: otherHash })).toBe("artifact-bytes-tampered");
    expect(await healthOf({ [`${RESULT}/a`]: result("a", "{}") }, { ...refOf("a", "{}"), sha256: otherHash })).toBe("artifact-hash-mismatch");
    const invalid = await resolve({ [`${RESULT}/a`]: result("a", "{}") }, refOf("a", "{}"));
    expect([invalid.verdict.health, "body" in invalid.verdict]).toEqual(["artifact-schema-invalid", false]);
  });
});

describe("the artifact resolver over its leaf reads: members", () => {
  const AT = `${BUNDLE_TYPE}/probe`;
  const built = buildMemberManifest(BUNDLES.artifacts![BUNDLE_TYPE], twoMembers());
  if (!built.ok) throw new Error(`member fixture refused: ${built.problems.join("; ")}`);
  const [figure, main] = built.entries.map((entry) => entry.fileName);
  const bytesOf = Object.fromEntries(twoMembers().map((file) => [file.fileName, { kind: "ok" as const, body: Buffer.from(file.bytes) }]));
  const fileEntries = [BUNDLE_FILE, `${BUNDLE_FILE}.manifest.json`, figure, main].map((name) => ({ name, kind: "file" as const }));
  /** The healthy bundle; `over` replaces what the double holds for it. */
  const bundle = (over: Partial<HeldArtifact> = {}): Held => ({ [AT]: {
    manifest: text(JSON.stringify(sidecar(BUNDLE_TYPE, "probe", built.body))), body: text(built.body),
    entries: { kind: "ok", entries: fileEntries }, members: bytesOf, ...over,
  } });
  const check = (held: Held) => resolve(held, refOf("probe", built.body, BUNDLE_TYPE), BUNDLES);
  const LOCATE = `artifactAt ${AT} ${BUNDLE_FILE}`;
  const FIRST = [LOCATE, `manifest ${AT} max=${MANIFEST_CAP}`, `body ${AT} max=65536`, LOCATE, `entries ${AT} max=10000`];

  it("R9 locates again before the members, sweeps, then reads each member in manifest order under the member cap", async () => {
    const { verdict, calls } = await check(bundle());
    expect([verdict.health, verdict.body]).toEqual(["ok", built.body]);
    expect(calls).toEqual([...FIRST, `member ${AT}/${figure} max=4096`, `member ${AT}/${main} max=4096`]);
  });

  it("R10 answers from the sweep alone for a refused listing, a stray or non-file entry, or a missing member", async () => {
    const sweep = async (entries: ConfinedDirListing) => { const { verdict, calls } = await check(bundle({ entries })); return [verdict.health, calls]; };
    expect(await sweep({ kind: "unavailable" })).toEqual(["artifact-unreadable", FIRST]);
    expect(await sweep({ kind: "ok", entries: [...fileEntries, { name: "stray.bin", kind: "file" }] })).toEqual(["artifact-bytes-tampered", FIRST]);
    expect(await sweep({ kind: "ok", entries: fileEntries.map((entry) => entry.name === main ? { ...entry, kind: "symlink" as const } : entry) })).toEqual(["artifact-bytes-tampered", FIRST]);
    expect(await sweep({ kind: "ok", entries: fileEntries.filter((entry) => entry.name !== main) })).toEqual(["artifact-dangling", FIRST]);
  });

  it("R10b stops at the first unhealthy member, and maps each member outcome to its health without a body", async () => {
    const absent = await check(bundle({ members: { [main]: bytesOf[main] } }));
    expect([absent.verdict, absent.calls.at(-1)]).toEqual([{ health: "artifact-dangling", manifest: sidecar(BUNDLE_TYPE, "probe", built.body) }, `member ${AT}/${figure} max=4096`]);
    const second = async (read: ArtifactMemberRead): Promise<string> => (await check(bundle({ members: { ...bytesOf, [main]: read } }))).verdict.health;
    expect(await second({ kind: "unavailable" })).toBe("artifact-unreadable");
    expect(await second({ kind: "oversize", actualBytes: 9999 })).toBe("artifact-bytes-tampered");
    expect(await second({ kind: "ok", body: Buffer.from("changed") })).toBe("artifact-bytes-tampered");
  });
});

describe("the artifact resolver over its leaf reads: an unsafe location", () => {
  it("R11 rejects with the store's own error as the same object, having read nothing", async () => {
    const refused = new ArtifactPathError("slug", "not safe");
    const calls: string[] = [];
    await expect(readVerifiedArtifactFrom(storeOf({}, calls, refused), PROFILE, refOf("a"))).rejects.toBe(refused);
    expect(calls).toEqual([`artifactAt ${RESULT}/a ${RESEARCH_ARTIFACT_FILE}`]);
  });

  it("R11b the root form rejects with ArtifactPathError for an unsafe slug before any read: no file is needed", async () => {
    const unsafe: ArtifactRef = { artifactType: RESULT, slug: "Not Safe", sha256: hashArtifactBody(BODY) };
    await expect(readVerifiedArtifact("/nonexistent/u7-artifact-root", PROFILE, unsafe)).rejects.toBeInstanceOf(ArtifactPathError);
  });
});
