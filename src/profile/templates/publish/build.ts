/**
 * @file src/profile/templates/publish/build.ts
 * @description Build, verify, and publish one static tap distribution.
 *
 * Ordering is the correctness argument:
 *   resolve -> stage -> VERIFY -> publish -> commit the sequence LAST.
 * A crash anywhere leaves the workspace at the old sequence and the output untouched, so a
 * retry is a clean re-derivation rather than a resume. Nothing is ever published that did
 * not first verify as a consumer would verify it.
 */
import packageJson from "../../../../package.json" with { type: "json" };
import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { canonicalDigest } from "../signing/canonical.js";
import { sha256DigestHex } from "../signing/protocol.js";
import { withExclusiveLock } from "../../../utils/exclusive-lock.js";
import { readPrivateKey } from "./keystore.js";
import { buildSignedIndex } from "./index-builder.js";
import { verifyBuiltDistribution } from "./build-verify.js";
import { signPendingIntents, type SignedIntents } from "./lifecycle.js";
import { assertOutsideWorkspace, parseExpiresIn } from "./build-options.js";
import type { WorkspacePaths } from "./workspace-paths.js";
import { readWorkspace, writeWorkspace } from "./workspace-store.js";
import type { PublisherWorkspace, WorkspacePackage } from "./workspace-types.js";

/** Options accepted by `template publish build`. */
export interface BuildOptions {
  out: string;
  expiresIn: string;
  force?: boolean;
  now?: Date;
}

/** Public result of one committed build. */
export interface BuildResult {
  sequence: number;
  packageCount: number;
  indexDigest: string;
  out: string;
}

/** Build, verify, and publish one distribution under the workspace lock. */
export async function buildDistribution(paths: WorkspacePaths, options: BuildOptions): Promise<BuildResult> {
  return withExclusiveLock(paths, async () => {
    const workspace = await readWorkspace(paths);
    const out = await assertOutsideWorkspace(paths, options.out);
    const now = options.now ?? new Date();
    const expiresAt = parseExpiresIn(options.expiresIn, now);
    assertHasSomethingToBuild(workspace, options.force === true);

    const sequence = workspace.sequence + 1;
    const intents = await signPendingIntents(paths, workspace, sequence, now);
    const packages = emittedPackages(workspace, intents);
    const built = buildSignedIndex(workspace, {
      sequence,
      generatedAt: now,
      expiresAt,
      publisherKey: intents.nextPublisherKey ?? workspace.publisherKey,
      tapKey: intents.nextTapKey ?? workspace.tapKey,
      signingKey: await indexSigningKey(paths, workspace, intents),
      newRotations: intents.rotations,
      ...(intents.tapRotation === undefined ? {} : { newTapRotation: intents.tapRotation }),
      newRevocations: intents.revocations,
      packages,
    });

    verifyBuiltDistribution(workspace, built.indexJson, packages, packageJson.version);
    await publishStagedTree(out, built.indexJson, packages);
    await commitBuild(paths, workspace, built, intents, sequence, now);

    return {
      sequence,
      packageCount: packages.length,
      indexDigest: canonicalDigest(built.index),
      out,
    };
  });
}

/**
 * Packages this index publishes: everything the workspace holds MINUS every revoked
 * digest. `verifySignedPackage` calls `assertEvidenceNotRevoked`, so an index that both
 * lists and emits a revoked package is one the build's own gate would refuse.
 */
function emittedPackages(workspace: PublisherWorkspace, intents: SignedIntents): WorkspacePackage[] {
  const revoked = new Set([
    ...workspace.revocations.filter((r) => r.kind === "package").map((r) => r.value),
    ...intents.revocations.filter((r) => r.kind === "package").map((r) => r.value),
  ]);
  const packages = intents.resignedPackages ?? workspace.packages;
  return packages.filter((pkg) => !revoked.has(pkg.payloadDigest));
}

/** The key that signs the index: the SUCCESSOR whenever the tap root is rotating. */
async function indexSigningKey(paths: WorkspacePaths, workspace: PublisherWorkspace, intents: SignedIntents) {
  const key = intents.nextTapKey ?? workspace.tapKey;
  return readPrivateKey(paths, "tap", key.keyId);
}

/** Refuse a no-change rebuild so an operator cannot silently burn sequence numbers. */
function assertHasSomethingToBuild(workspace: PublisherWorkspace, force: boolean): void {
  if (force || workspace.lastBuild === undefined) return;
  const unchanged = workspace.pending.length === 0 && workspace.lastBuild.sequence === workspace.sequence;
  if (unchanged) {
    throw new Error(`nothing to build since sequence ${workspace.sequence}; pass --force to republish`);
  }
}

/**
 * Stage the complete tree, then swap it into place. `rename` onto a non-empty directory
 * fails ENOTEMPTY, so an existing release is moved aside and removed only after the new
 * tree is in place.
 */
async function publishStagedTree(out: string, indexJson: string, packages: WorkspacePackage[]): Promise<void> {
  await mkdir(path.dirname(out), { recursive: true });
  const staging = await mkdtemp(`${out}.staging-`);
  try {
    const digestDir = path.join(staging, "packages", "sha256");
    await mkdir(digestDir, { recursive: true });
    // Packages are written BEFORE the index, so an index is never visible while
    // referencing a package that is not yet there.
    for (const pkg of packages) {
      await writeFile(path.join(digestDir, `${sha256DigestHex(pkg.payloadDigest)}.json`), pkg.envelopeJson, "utf8");
    }
    await writeFile(path.join(staging, "index.json"), indexJson, "utf8");
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  await swapIntoPlace(staging, out);
}

async function swapIntoPlace(staging: string, out: string): Promise<void> {
  const retired = `${out}.retired-${process.pid}`;
  const hadPrevious = await rename(out, retired).then(() => true).catch(() => false);
  try {
    await rename(staging, out);
  } catch (error) {
    if (hadPrevious) await rename(retired, out).catch(() => undefined);
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  if (hadPrevious) await rm(retired, { recursive: true, force: true }).catch(() => undefined);
}

/** Commit LAST: the sequence advances only once the output is published and verified. */
async function commitBuild(
  paths: WorkspacePaths,
  workspace: PublisherWorkspace,
  built: ReturnType<typeof buildSignedIndex>,
  intents: SignedIntents,
  sequence: number,
  now: Date,
): Promise<void> {
  await writeWorkspace(paths, {
    ...workspace,
    tapKey: intents.nextTapKey ?? workspace.tapKey,
    publisherKey: intents.nextPublisherKey ?? workspace.publisherKey,
    sequence,
    packages: intents.resignedPackages ?? workspace.packages,
    rotations: built.rotations,
    tapKeyRotations: built.tapKeyRotations,
    revocations: built.revocations,
    pending: [],
    lastBuild: {
      sequence,
      indexDigest: canonicalDigest(built.index),
      builtAt: now.toISOString(),
    },
  });
}
