/**
 * @file test/artifacts/artifact-members-write.test.ts
 * @description W1 write-side witnesses for member-bearing artifacts: a binary
 * member round-trips and verifies; the manifest is CANONICAL (reordered input →
 * byte-identical manifest, same ref — the mutant is a manifest rendered in
 * supply order minting two hashes for one set); duplicate input names refuse
 * before any write; a members type refuses `body` and a single-file type
 * refuses `memberFiles`; replacement handles shrink AND rename by deleting the
 * obsolete leaf in-batch (mutant: a rewrite that leaves the stale leaf, which
 * the allowlist sweep would then redden); a stale-member rewrite is NOT
 * short-circuited by applied-once (mutant: manifest-only applied-once); the
 * legacy single-file type keeps its applied-once short-circuit (one event).
 */
import { describe, expect, it, afterEach } from "vitest";
import path from "path";
import { access, readFile, writeFile } from "fs/promises";
import { applyApprovedMutations } from "../../src/trust/executor.js";
import { readEvents } from "../../src/events/store-read.js";
import { auditArtifactStore } from "../../src/profile/templates/artifact-audit.js";
import { loadNonDefaultProfile } from "../../src/profile/block.js";
import { makeResearchLikeRoot, profileRoot } from "../fixtures/artifact-root.js";
import {
  makeMembersRoot, writeBundle, resolveBundle, bundlePaths, twoMembers, BINARY_BYTES, BUNDLE_TYPE, SLUG,
} from "../fixtures/member-artifact-root.js";

afterEach(() => { delete process.env.LLMWIKI_TRUSTED_WRITE; });

const exists = (p: string) => access(p).then(() => true, () => false);

/** Invalid member names must refuse before creating the artifact directory. */
async function expectNamesRefused(names: string[], reason: RegExp): Promise<void> {
  const root = await makeMembersRoot("members-invalid-names");
  const members = names.map(fileName => ({ fileName, bytes: Buffer.from("x", "utf8") }));
  await expect(writeBundle(root, members)).rejects.toThrow(reason);
  expect(await exists(bundlePaths(root).expectedDir)).toBe(false);
}

/** Drive one malformed SDK write and assert the refusal left the store untouched. */
async function expectSdkWriteRefused(root: string, input: Record<string, unknown>): Promise<void> {
  const { createWiki } = await import("../../src/index.js");
  process.env.LLMWIKI_TRUSTED_WRITE = "*";
  await expect(createWiki({ root }).writeArtifact(input as never)).rejects.toThrow(/exactly one of body or memberFiles/);
  expect(await exists(bundlePaths(root).expectedDir)).toBe(false);
}

describe("member-bearing artifact writes", () => {
  it("can replace a tiny bundle whose sidecar is larger than its body ceiling", async () => {
    const root = await profileRoot("members-small-budget", {
      schemaVersion: 1, profileId: "small-budget", entities: { note: { directory: "wiki/notes" } },
      artifacts: { bundle: { fileName: "bundle.json", contentKind: "json", maxBytes: 128,
        members: { maxCount: 1, maxMemberBytes: 1, maxTotalBytes: 1 } } },
    });
    await writeBundle(root, [{ fileName: "a.bin", bytes: Buffer.from([1]) }]);
    const ref = await writeBundle(root, [{ fileName: "a.bin", bytes: Buffer.from([2]) }]);
    expect((await resolveBundle(root, ref)).health).toBe("ok");
    expect(await readFile(path.join(bundlePaths(root).expectedDir, "a.bin"))).toEqual(Buffer.from([2]));
  });

  it("allows a healthy bundle through profile-update artifact auditing", async () => {
    const root = await makeMembersRoot("members-audit");
    await writeBundle(root, twoMembers());
    const loaded = await loadNonDefaultProfile(root);
    expect(await auditArtifactStore(root, loaded!.profile)).toEqual([]);
  });

  it("writes a bundle with a BINARY member, verifies ok, and the member bytes are exact", async () => {
    const root = await makeMembersRoot("members-write");
    const ref = await writeBundle(root, twoMembers());
    expect((await resolveBundle(root, ref)).health).toBe("ok");
    const onDisk = await readFile(path.join(bundlePaths(root).expectedDir, "figure.bin"));
    expect(onDisk.equals(BINARY_BYTES)).toBe(true);
  });

  it("derives a CANONICAL manifest: reordered memberFiles produce a byte-identical manifest and the SAME ref", async () => {
    const rootA = await makeMembersRoot("members-order-a");
    const rootB = await makeMembersRoot("members-order-b");
    const refA = await writeBundle(rootA, twoMembers());
    const refB = await writeBundle(rootB, [...twoMembers()].reverse());
    expect(refB.sha256).toBe(refA.sha256);
    expect(await readFile(bundlePaths(rootB).bytesPath, "utf8")).toBe(await readFile(bundlePaths(rootA).bytesPath, "utf8"));
  });

  it("REFUSES duplicate input fileNames before any write lands", async () => {
    const root = await makeMembersRoot("members-dup");
    const [a] = twoMembers();
    await expect(writeBundle(root, [a!, a!])).rejects.toThrow(/supplied more than once/);
    expect(await exists(bundlePaths(root).expectedDir)).toBe(false);
  });

  it.each([["a.tex", "A.tex"], ["µ.tex", "μ.tex"]])(
    "refuses duplicate aliases %s and %s before writing", async (left, right) => {
      await expectNamesRefused([left, right], /supplied more than once/);
    },
  );

  it("refuses a member name aliasing its own manifest", async () => {
    await expectNamesRefused(["BUNDLE.JSON"], /reserved|extension/);
  });

  it("SNAPSHOTS caller buffers synchronously: mutating the input after the call cannot fork hash from bytes", async () => {
    // The mutant: the SDK (or executor) passing the caller's live Uint8Array
    // through — the manifest would hash one snapshot and the write land
    // another, the exact forged-manifest channel the derive path closes.
    const root = await makeMembersRoot("members-snapshot");
    const { createWiki } = await import("../../src/index.js");
    process.env.LLMWIKI_TRUSTED_WRITE = "*";
    const bytes = Buffer.from("original-bytes", "utf8");
    const pending = createWiki({ root }).writeArtifact({
      artifactType: BUNDLE_TYPE, slug: SLUG, memberFiles: [{ fileName: "a.tex", bytes }],
    });
    bytes.fill(0x7a); // the caller scribbles while the write is in flight
    const { ref } = await pending;
    expect((await resolveBundle(root, ref)).health).toBe("ok");
    const landed = await readFile(path.join(bundlePaths(root).expectedDir, "a.tex"), "utf8");
    expect(landed).toBe("original-bytes");
  });

  it("REFUSES a writeArtifact input with NEITHER body nor memberFiles (no synthesized empty body)", async () => {
    await expectSdkWriteRefused(await makeMembersRoot("members-neither"), { artifactType: BUNDLE_TYPE, slug: SLUG });
  });

  it("REFUSES a body on a members type, and memberFiles on a single-file type", async () => {
    const root = await makeMembersRoot("members-shape");
    process.env.LLMWIKI_TRUSTED_WRITE = "*";
    await expect(applyApprovedMutations(root, [
      { kind: "artifact", artifactType: BUNDLE_TYPE, slug: SLUG, body: `{"members":[]}`, origin: "cli" },
    ])).rejects.toThrow(/takes memberFiles/);
    const legacy = await makeResearchLikeRoot("members-on-plain");
    await expect(applyApprovedMutations(legacy, [
      { kind: "artifact", artifactType: "experiment-result", slug: "probe", body: `{"accuracy":0.9}`, memberFiles: twoMembers(), origin: "cli" },
    ])).rejects.toThrow(/declares no members/);
  });

  it("SHRINK deletes the obsolete leaf in-batch and the new bundle verifies clean", async () => {
    const root = await makeMembersRoot("members-shrink");
    await writeBundle(root, twoMembers());
    const ref = await writeBundle(root, [twoMembers()[0]!]);
    expect(await exists(path.join(bundlePaths(root).expectedDir, "figure.bin"))).toBe(false);
    expect((await resolveBundle(root, ref)).health).toBe("ok");
  });

  it.each([["main.tex", "MAIN.tex"], ["µ.tex", "μ.tex"], ["ß.tex", "ẞ.tex"]])(
    "refuses alias-only rename %s -> %s before mutation", async (oldName, newName) => {
      const root = await makeMembersRoot("members-alias-rename");
      const ref = await writeBundle(root, [{ fileName: oldName, bytes: Buffer.from("x", "utf8") }]);
      await expect(writeBundle(root, [{ fileName: newName, bytes: Buffer.from("x", "utf8") }]))
        .rejects.toThrow(/alias-collides/);
      expect((await resolveBundle(root, ref)).health).toBe("ok");
    },
  );

  it("REFUSES a writeArtifact input carrying BOTH body and memberFiles (the body would be discarded)", async () => {
    await expectSdkWriteRefused(await makeMembersRoot("members-both"),
      { artifactType: BUNDLE_TYPE, slug: SLUG, body: "{}", memberFiles: twoMembers() });
  });

  it("RENAME deletes the old-named leaf and the renamed bundle verifies clean", async () => {
    const root = await makeMembersRoot("members-rename");
    await writeBundle(root, [{ fileName: "old.tex", bytes: Buffer.from("x", "utf8") }]);
    const ref = await writeBundle(root, [{ fileName: "new.tex", bytes: Buffer.from("x", "utf8") }]);
    expect(await exists(path.join(bundlePaths(root).expectedDir, "old.tex"))).toBe(false);
    expect((await resolveBundle(root, ref)).health).toBe("ok");
  });

  it("a STALE-MEMBER rewrite is not short-circuited: re-applying the same set repairs tampered member bytes", async () => {
    const root = await makeMembersRoot("members-repair");
    const ref = await writeBundle(root, twoMembers());
    const leaf = path.join(bundlePaths(root).expectedDir, "main.tex");
    await writeFile(leaf, "TAMPERED", "utf8");
    expect((await resolveBundle(root, ref)).health).toBe("artifact-bytes-tampered");
    const again = await writeBundle(root, twoMembers());
    expect(again.sha256).toBe(ref.sha256);
    expect((await resolveBundle(root, ref)).health).toBe("ok");
  });

  it("LEGACY REGRESSION: a single-file type still short-circuits applied-once (exactly one audit event)", async () => {
    const root = await makeResearchLikeRoot("members-legacy");
    process.env.LLMWIKI_TRUSTED_WRITE = "*";
    const mutation = { kind: "artifact" as const, artifactType: "experiment-result", slug: "probe", body: `{"accuracy":0.9}`, origin: "cli" as const };
    await applyApprovedMutations(root, [mutation]);
    await applyApprovedMutations(root, [mutation]);
    const { events } = await readEvents(root);
    expect(events.filter((e) => e.type === "artifact-write")).toHaveLength(1);
  });

  it("IDEMPOTENT members re-write short-circuits too: the second identical write appends no event", async () => {
    const root = await makeMembersRoot("members-idempotent");
    await writeBundle(root, twoMembers());
    await writeBundle(root, twoMembers());
    const { events } = await readEvents(root);
    expect(events.filter((e) => e.type === "artifact-write")).toHaveLength(1);
  });
});
