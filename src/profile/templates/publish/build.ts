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
import type { TapRevocation } from "../signing/types.js";
import { assertOutsideWorkspace, parseExpiresIn } from "./build-options.js";
import type { WorkspacePaths } from "./workspace-paths.js";
import { readWorkspace, writeWorkspace } from "./workspace-store.js";
import { readDistributionOnDisk } from "./tree-read.js";
import type { LastBuild, PublisherWorkspace, WorkspacePackage } from "./workspace-types.js";

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
    const out = await assertOutsideWorkspace(paths, options.out, [workspace.lastBuild, workspace.reservedBuild]);
    const now = options.now ?? new Date();
    const expiresAt = parseExpiresIn(options.expiresIn, now);
    // Skip past a reserved sequence: a crash after publishing but before committing leaves a
    // signed index live at that sequence, and re-issuing it with different bytes would be a
    // replay for any client that already fetched it.
    const sequence = Math.max(workspace.sequence, workspace.reservedBuild?.sequence ?? 0) + 1;
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

    // The identity of the state THIS build commits — successor keys and the build's
    // revocations, not the pre-build workspace. Used both to decide "is there anything to
    // build" and as the recorded lastBuild, so both sides speak of the same committed state.
    const effective = effectiveStateOf(workspace, built, intents);
    assertHasSomethingToBuild(workspace, effective, packages, options.force === true);
    const identity: LastBuild = {
      sequence,
      indexDigest: canonicalDigest(built.index),
      builtAt: now.toISOString(),
      contentDigest: contentDigestOf(effective, packages),
    };
    const staging = await stageTree(out, built.indexJson, packages);
    try {
      // Verify the tree that will actually be PUBLISHED, read back from disk — not the
      // in-memory strings we happen to hold.
      await verifyStagedTree(workspace, staging);
      // Reserve the full IDENTITY, not just the number: if the commit below never lands, a
      // retry must recognize the tree we published as ours instead of refusing it as foreign
      // data and deadlocking the workspace.
      await writeWorkspace(paths, { ...workspace, reservedBuild: identity });
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
    await swapIntoPlace(staging, out);
    await commitBuild(paths, workspace, built, intents, identity);

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

/**
 * Refuse a no-change rebuild so an operator cannot silently burn sequence numbers — but
 * `add` records a package WITHOUT staging an intent, so `pending` alone cannot answer the
 * question. Compare the content this build would publish against the content the last build
 * did.
 */
function assertHasSomethingToBuild(
  workspace: PublisherWorkspace,
  effective: EffectiveState,
  packages: WorkspacePackage[],
  force: boolean,
): void {
  if (force || workspace.lastBuild === undefined) return;
  if (workspace.pending.length > 0) return;
  if (contentDigestOf(effective, packages) !== workspace.lastBuild.contentDigest) return;
  throw new Error(`nothing to build since sequence ${workspace.sequence}; pass --force to republish`);
}

/**
 * The published content's identity: what is served, and under which keys. It MUST reflect
 * the state this build commits — successor keys and the build's revocations — not the
 * pre-build workspace. Digesting the old key ids here would make the NEXT build always see a
 * false change (the committed key id no longer matches the recorded one), defeating the
 * no-change guard after any rotation.
 */
function contentDigestOf(effective: EffectiveState, packages: WorkspacePackage[]): string {
  return canonicalDigest({
    packages: packages.map((pkg) => pkg.payloadDigest).sort(),
    revocations: effective.revocations.map((revocation) => `${revocation.kind}:${revocation.value}`).sort(),
    publisherKeyId: effective.publisherKeyId,
    tapKeyId: effective.tapKeyId,
  });
}

/** The keys and revocations a build COMMITS, after applying its staged intents. */
interface EffectiveState {
  publisherKeyId: string;
  tapKeyId: string;
  revocations: TapRevocation[];
}

/** Resolve the state a build commits: successor keys where rotated, the built revocations. */
function effectiveStateOf(
  workspace: PublisherWorkspace,
  built: ReturnType<typeof buildSignedIndex>,
  intents: SignedIntents,
): EffectiveState {
  return {
    publisherKeyId: (intents.nextPublisherKey ?? workspace.publisherKey).keyId,
    tapKeyId: (intents.nextTapKey ?? workspace.tapKey).keyId,
    revocations: built.revocations,
  };
}

/** Write the complete tree to a staging directory beside `--out`. */
async function stageTree(out: string, indexJson: string, packages: WorkspacePackage[]): Promise<string> {
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
    return staging;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Read the staged tree back FROM DISK and verify it as a consumer would. This is the gate
 * the whole design rests on, so it inspects the bytes that will actually be served through
 * the Slice A exact-tree verifier: digest-derived filenames, one-to-one coverage of the
 * index's entries, no extra or symlinked files, bounded no-follow reads. A name-and-count
 * check would accept two copies of one envelope standing in for another package.
 */
async function verifyStagedTree(workspace: PublisherWorkspace, staging: string): Promise<void> {
  const onDisk = await readDistributionOnDisk(staging);
  const staged = onDisk.envelopes.map((envelopeJson) => ({ envelopeJson }) as WorkspacePackage);
  verifyBuiltDistribution(workspace, onDisk.indexJson, staged, packageJson.version);
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
  identity: LastBuild,
): Promise<void> {
  const committed: PublisherWorkspace = {
    ...workspace,
    tapKey: intents.nextTapKey ?? workspace.tapKey,
    publisherKey: intents.nextPublisherKey ?? workspace.publisherKey,
    sequence: identity.sequence,
    packages: intents.resignedPackages ?? workspace.packages,
    rotations: built.rotations,
    tapKeyRotations: built.tapKeyRotations,
    revocations: built.revocations,
    pending: [],
    lastBuild: identity,
  };
  delete committed.reservedBuild;
  await writeWorkspace(paths, committed);
}
