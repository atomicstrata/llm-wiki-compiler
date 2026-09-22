/**
 * @file src/capability-providers/runtime/launch-snapshot.ts
 * @description Invocation-private verified launch snapshot (CP-INV-03 / D6.2).
 * The installed cache tree is an untrusted byte source, never the execution
 * root. For every invocation the host enumerates the cache tree through held
 * handles, copies it into a fresh owner-private launch root, reopens the copy
 * through its held root, recomputes the expanded-tree digest, and compares it
 * plus the entrypoint against the INSTALL-PINNED artifact. That pinned compare
 * — not copy-consistency — is the anti-swap gate: a wholesale cache swap or a
 * hard-link-swapped leaf changes the recomputed digest and is refused, while
 * O_NOFOLLOW plus the held root fd defeat a symlinked parent during the copy.
 */
import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import { opendir } from "node:fs/promises";
import path from "node:path";
import type { Sha256Digest } from "../types.js";
import { parseSha256Digest } from "../ids.js";
import {
  readProviderTreeEntriesOnDisk, writeProviderTree,
  type ProviderTreeVerificationOptions, type ProviderTreeWriteOptions,
} from "../packages/archive-filesystem.js";
import { verifyProviderTree } from "../packages/archive.js";
import type { PlatformArtifactV1 } from "../packages/protocol.js";

/** Inputs for one invocation-private launch snapshot. */
export interface LaunchSnapshotRequestV1 {
  readonly sourceTreeReal: string;
  readonly artifact: PlatformArtifactV1;
  readonly launchParentDir: string;
  readonly readOptions?: ProviderTreeVerificationOptions;
  readonly writeOptions?: ProviderTreeWriteOptions;
}

/** A sealed, re-verified private launch root; the launchRoot never reaches a provider. */
export interface VerifiedLaunchSnapshotV1 {
  readonly launchRoot: string;
  readonly entrypointRelativePath: string;
  readonly expandedTreeDigest: Sha256Digest;
  readonly entryCount: number;
  dispose(): Promise<void>;
}

/** Enumerate, copy, seal, and re-verify one invocation-private launch snapshot. */
export async function buildVerifiedLaunchSnapshot(
  request: LaunchSnapshotRequestV1,
): Promise<VerifiedLaunchSnapshotV1> {
  const enumerated = await readProviderTreeEntriesOnDisk(request.sourceTreeReal, request.artifact, {
    expectedRootReal: request.sourceTreeReal, ...request.readOptions,
  });
  const launchRoot = await mkdtemp(path.join(await realpath(request.launchParentDir), "llmwiki-launch-"));
  try {
    await writeProviderTree(launchRoot, [...enumerated.entries], request.artifact.entrypointRelativePath, {
      expectedParentReal: await realpath(request.launchParentDir), ...request.writeOptions,
    });
    const summary = await verifyProviderTree(launchRoot, request.artifact, {
      expectedRootReal: await realpath(launchRoot),
    });
    return Object.freeze({
      launchRoot, entrypointRelativePath: request.artifact.entrypointRelativePath,
      expandedTreeDigest: parseSha256Digest(summary.expandedTreeDigest),
      entryCount: summary.entryCount, dispose: () => disposeLaunchRoot(launchRoot),
    });
  } catch (error) {
    await disposeLaunchRoot(launchRoot).catch(() => {});
    throw error;
  }
}

/** Thaw the read-only snapshot and remove it; cleanup failure is visible, never silent. */
async function disposeLaunchRoot(launchRoot: string): Promise<void> {
  await thaw(launchRoot);
  await rm(launchRoot, { recursive: true, force: true });
}

/** Restore writable modes across a frozen launch root before removal. */
async function thaw(target: string): Promise<void> {
  if (process.platform === "win32") return;
  await chmod(target, 0o700).catch(() => {});
  let children: Awaited<ReturnType<typeof opendir>>;
  try { children = await opendir(target); } catch { return; }
  for await (const child of children) {
    const leaf = path.join(target, child.name);
    if (child.isDirectory()) await thaw(leaf);
    else await chmod(leaf, 0o600).catch(() => {});
  }
}
