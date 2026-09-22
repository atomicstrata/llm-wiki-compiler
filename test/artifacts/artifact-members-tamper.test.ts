/**
 * @file test/artifacts/artifact-members-tamper.test.ts
 * @description W1 read-side tamper witnesses: each on-disk mutation of a
 * verified bundle flips the verdict — a flipped member byte (tampered), a
 * deleted member (dangling), an UNLISTED planted regular file (tampered — the
 * allowlist sweep; the mutant is a resolve that only checks listed members), a
 * planted SYMLINK and DIRECTORY (tampered, never followed), an oversize member
 * (always tampered — rows are cap-bounded by the body contract, so an over-cap
 * leaf can never match its recorded length), and a CASE-ALIASED leaf (one
 * physical file must not satisfy a differently-spelled row). The over-cap
 * sweep case pins the entry-cap BEHAVIOUR (resolve unreadable, write refuses);
 * the lazy-vs-materializing lister distinction is a resource property no
 * outcome assertion can observe, so no such mutant is claimed.
 */
import { describe, expect, it, afterEach } from "vitest";
import path from "path";
import { mkdir, rename, rm, symlink, unlink, writeFile } from "fs/promises";
import {
  makeMembersRoot, writeBundle, resolveBundle, bundlePaths, twoMembers, membersBlock,
} from "../fixtures/member-artifact-root.js";
import { MAX_ARTIFACT_DIR_ENTRIES } from "../../src/artifacts/name.js";
import type { ArtifactRef } from "../../src/artifacts/ref.js";

afterEach(() => { delete process.env.LLMWIKI_TRUSTED_WRITE; });

/** One verified bundle to mutate. */
async function verifiedBundle(prefix: string): Promise<{ root: string; ref: ArtifactRef; dir: string }> {
  const root = await makeMembersRoot(prefix);
  const ref = await writeBundle(root, twoMembers());
  expect((await resolveBundle(root, ref)).health).toBe("ok");
  return { root, ref, dir: bundlePaths(root).expectedDir };
}

describe("member tamper detection", () => {
  it("a FLIPPED member byte reads artifact-bytes-tampered", async () => {
    const { root, ref, dir } = await verifiedBundle("members-flip");
    await writeFile(path.join(dir, "figure.bin"), Buffer.from([0x00]));
    expect((await resolveBundle(root, ref)).health).toBe("artifact-bytes-tampered");
  });

  it("a DELETED member reads artifact-dangling", async () => {
    const { root, ref, dir } = await verifiedBundle("members-del");
    await unlink(path.join(dir, "main.tex"));
    expect((await resolveBundle(root, ref)).health).toBe("artifact-dangling");
  });

  it("an UNLISTED planted regular file reads artifact-bytes-tampered (the allowlist sweep)", async () => {
    const { root, ref, dir } = await verifiedBundle("members-plant");
    await writeFile(path.join(dir, "extra.tex"), "planted", "utf8");
    expect((await resolveBundle(root, ref)).health).toBe("artifact-bytes-tampered");
  });

  it("a planted SYMLINK reads tampered and is never followed", async () => {
    const { root, ref, dir } = await verifiedBundle("members-symlink");
    await symlink("/etc/hosts", path.join(dir, "link.tex"));
    expect((await resolveBundle(root, ref)).health).toBe("artifact-bytes-tampered");
  });

  it("a planted DIRECTORY reads tampered", async () => {
    const { root, ref, dir } = await verifiedBundle("members-dir");
    await mkdir(path.join(dir, "sub.tex"));
    expect((await resolveBundle(root, ref)).health).toBe("artifact-bytes-tampered");
  });

  it("an OVERSIZE member reads tampered (rows are cap-bounded, so over-cap can never match its row)", async () => {
    const small = membersBlock({ maxMemberBytes: 8, maxTotalBytes: 64 });
    const root = await makeMembersRoot("members-oversize", small);
    const ref = await writeBundle(root, [{ fileName: "a.tex", bytes: Buffer.from("12345678", "utf8") }]);
    const dir = bundlePaths(root).expectedDir;
    // Grown past the cap AND past the recorded length: a provable divergence.
    await writeFile(path.join(dir, "a.tex"), "123456789012", "utf8");
    expect((await resolveBundle(root, ref)).health).toBe("artifact-bytes-tampered");
  });

  it("a CASE-ALIASED leaf does not satisfy its row: a case-only rename reads tampered, never ok", async () => {
    // On a case-insensitive filesystem one physical leaf can answer opens for
    // several spellings; the sweep compares names BYTE-EXACTLY in both
    // directions, so the folded spelling refuses instead of verifying.
    const { root, ref, dir } = await verifiedBundle("members-alias");
    await rename(path.join(dir, "main.tex"), path.join(dir, "TMP-main.tex"));
    await rename(path.join(dir, "TMP-main.tex"), path.join(dir, "MAIN.tex"));
    expect((await resolveBundle(root, ref)).health).toBe("artifact-bytes-tampered");
  });

  it("the sweep is BOUNDED: past the entry cap resolve reads unreadable and a rewrite refuses", async () => {
    const { root, ref, dir } = await verifiedBundle("members-cap");
    for (let index = 0; index < MAX_ARTIFACT_DIR_ENTRIES + 1; index += 1) {
      await writeFile(path.join(dir, `flood-${index}.tex`), "", "utf8");
    }
    expect((await resolveBundle(root, ref)).health).toBe("artifact-unreadable");
    await expect(writeBundle(root, twoMembers())).rejects.toThrow(/entry cap/);
    await rm(dir, { recursive: true, force: true });
  }, 120_000);
});
