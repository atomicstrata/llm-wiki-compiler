/**
 * @file test/fixtures/member-artifact-root.ts
 * @description Temp roots whose profile declares a MEMBER-BEARING artifact type
 * with NO product vocabulary — the synthetic consumer the W1 genericity gate
 * requires — plus the write/plant/resolve helpers every member suite shares.
 * The `bundle` type allows `.tex`/`.bin` members under small ceilings; callers
 * can override the members block to probe the name policy.
 */
import { readFile, writeFile } from "fs/promises";
import path from "path";
import { createHash } from "crypto";
import { profileRoot } from "./artifact-root.js";
import { applyApprovedMutations } from "../../src/trust/executor.js";
import { loadNonDefaultProfile } from "../../src/profile/block.js";
import { resolveArtifactRef, type ArtifactResolution } from "../../src/artifacts/resolve.js";
import { artifactPaths, hashArtifactBody } from "../../src/artifacts/store.js";
import type { ArtifactMembersDef, ProfilePack } from "../../src/profile/types.js";
import type { ArtifactMemberFileInput } from "../../src/artifacts/members.js";
import type { ArtifactRef } from "../../src/artifacts/ref.js";

export const BUNDLE_TYPE = "bundle";
export const BUNDLE_FILE = "bundle.json";
export const SLUG = "probe";

/** Deliberately invalid UTF-8: a binary member a text round-trip would corrupt. */
export const BINARY_BYTES = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28, 0x01, 0x02]);

/** The default synthetic members block: small ceilings, two allowed extensions. */
export function membersBlock(overrides: Partial<ArtifactMembersDef> = {}): ArtifactMembersDef {
  return { maxCount: 4, maxMemberBytes: 4096, maxTotalBytes: 8192, allowedExtensions: [".tex", ".bin"], ...overrides };
}

/** A fresh root whose profile declares the `bundle` member-bearing type. */
export function makeMembersRoot(prefix: string, members: ArtifactMembersDef = membersBlock()): Promise<string> {
  const profile: ProfilePack = {
    schemaVersion: 1, profileId: "members-fixture",
    entities: { note: { directory: "wiki/notes" } },
    artifacts: { [BUNDLE_TYPE]: { fileName: BUNDLE_FILE, contentKind: "json", maxBytes: 65536, members } },
  };
  return profileRoot(prefix, profile);
}

/** The canonical two-member set most cases start from. */
export function twoMembers(): ArtifactMemberFileInput[] {
  return [
    { fileName: "main.tex", bytes: Buffer.from("\\documentclass{article}", "utf8") },
    { fileName: "figure.bin", bytes: BINARY_BYTES },
  ];
}

/** Write a bundle through the self-locking executor under a scoped grant. */
export async function writeBundle(root: string, memberFiles: readonly ArtifactMemberFileInput[]): Promise<ArtifactRef> {
  process.env.LLMWIKI_TRUSTED_WRITE = "*";
  try {
    const [result] = await applyApprovedMutations(root, [
      { kind: "artifact", artifactType: BUNDLE_TYPE, slug: SLUG, body: "", memberFiles, origin: "cli" },
    ]);
    if (result.kind !== "artifact") throw new Error("expected artifact result");
    return result.ref;
  } finally {
    delete process.env.LLMWIKI_TRUSTED_WRITE;
  }
}

/** Resolve a ref against the LOADED profile (the read path every surface uses). */
export async function resolveBundle(root: string, ref: ArtifactRef): Promise<ArtifactResolution> {
  const loaded = await loadNonDefaultProfile(root);
  if (!loaded) throw new Error("fixture profile failed to load");
  return resolveArtifactRef(root, loaded.profile, ref);
}

/** The bundle's canonical store paths for direct on-disk manipulation. */
export function bundlePaths(root: string): ReturnType<typeof artifactPaths> {
  return artifactPaths(root, BUNDLE_TYPE, SLUG, BUNDLE_FILE);
}

/**
 * PLANT a manifest body on disk with a SELF-CONSISTENT sidecar (sha/bytes
 * recomputed), returning the ref that pins the planted body — so the resolve
 * outcome measures the SCHEMA/member checks, not a masking sha mismatch.
 */
export async function plantBundleBody(root: string, body: string): Promise<ArtifactRef> {
  const paths = bundlePaths(root);
  const sha256 = hashArtifactBody(body);
  await writeFile(paths.bytesPath, body, "utf8");
  const sidecar = JSON.parse(await readFile(paths.manifestPath, "utf8")) as Record<string, unknown>;
  sidecar.sha256 = sha256;
  sidecar.bytes = Buffer.byteLength(body, "utf8");
  await writeFile(paths.manifestPath, `${JSON.stringify(sidecar, null, 2)}\n`, "utf8");
  return { artifactType: BUNDLE_TYPE, slug: SLUG, sha256 };
}

/** sha256 hex of raw bytes, for hand-built manifest rows. */
export function shaOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
