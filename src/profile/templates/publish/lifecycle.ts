/**
 * @file src/profile/templates/publish/lifecycle.ts
 * @description Key rotation and revocation: staged when created, signed at build.
 *
 * WHY STAGED. A rotation claim carries an `effectiveSequence`, and the consumer requires
 * it to equal the sequence of the index that publishes it. That sequence is only known at
 * build, so a rotation signed at create time with a guessed sequence is invalid the moment
 * another build intervenes. `rotate` therefore generates the successor keypair and stages
 * the intent; `build` signs it at the correct sequence with BOTH keys.
 *
 * KEY CONTINUITY IS NOT ARTIFACT CONTINUITY. `verifySignedPackage` resolves the publisher
 * key as `index.publishers[publisher]` — the single CURRENT key — and refuses a signature
 * whose keyId differs. So every package signed by a retired key becomes unverifiable the
 * instant the index announces its successor. A publisher rotation therefore RE-SIGNS every
 * package with the successor key. The payload is unchanged, so the payload digest and the
 * content-addressed filename are unchanged; only the signature changes.
 */
import { packageClaim, rotationClaim, tapRotationClaim } from "../signing/canonical.js";
import { signClaim } from "../signing/sign.js";
import type {
  PublisherKey,
  PublisherRotation,
  TapKeyRotation,
  TapRevocation,
} from "../signing/types.js";
import { withExclusiveLock } from "../../../utils/exclusive-lock.js";
import { createKeypairFile, readPrivateKey, readPublicKey, type KeyRole } from "./keystore.js";
import type { WorkspacePaths } from "./workspace-paths.js";
import { readWorkspace, writeWorkspace } from "./workspace-store.js";
import type { PendingIntent, PublisherWorkspace, WorkspacePackage } from "./workspace-types.js";

/** Everything a build needs from the staged intents, signed at the build's sequence. */
export interface SignedIntents {
  rotations: PublisherRotation[];
  tapRotation?: TapKeyRotation;
  revocations: TapRevocation[];
  nextTapKey?: PublisherKey;
  nextPublisherKey?: PublisherKey;
  /** Present only when a publisher rotation re-signed the package set. */
  resignedPackages?: WorkspacePackage[];
}

/** Stage a publisher-key rotation, generating the successor keypair now. */
export async function stageRotatePublisherKey(paths: WorkspacePaths, newKeyId: string): Promise<void> {
  await stageIntent(paths, async (workspace) => {
    assertKeyIdUnused(workspace, newKeyId);
    assertNoPendingRotation(workspace, "rotate-publisher", "publisher");
    await createKeypairFile(paths, newKeyId, "publisher");
    return { kind: "rotate-publisher", fromKeyId: workspace.publisherKey.keyId, toKeyId: newKeyId };
  });
}

/** Stage a tap-root rotation, generating the successor keypair now. */
export async function stageRotateTapKey(paths: WorkspacePaths, newKeyId: string): Promise<void> {
  await stageIntent(paths, async (workspace) => {
    assertKeyIdUnused(workspace, newKeyId);
    assertNoPendingRotation(workspace, "rotate-tap", "tap");
    await createKeypairFile(paths, newKeyId, "tap");
    return { kind: "rotate-tap", fromKeyId: workspace.tapKey.keyId, toKeyId: newKeyId };
  });
}

/** Stage a package revocation. The digest must name a package this workspace published. */
export async function stageRevokePackage(paths: WorkspacePaths, digest: string, reason: string): Promise<void> {
  await stageIntent(paths, async (workspace) => {
    if (!workspace.packages.some((pkg) => pkg.payloadDigest === digest)) {
      throw new Error(`no package in this workspace has digest ${digest}`);
    }
    return { kind: "revoke-package", digest, reason: assertReason(reason) };
  });
}

/**
 * Stage a publisher-key revocation. Revoking the ACTIVE key requires a paired rotation:
 * `advancePublisherPins` refuses an index whose announced key is revoked, so revoking the
 * live key alone would deadlock every future build inside its own verification.
 */
export async function stageRevokePublisherKey(paths: WorkspacePaths, keyId: string, reason: string): Promise<void> {
  await stageIntent(paths, async (workspace) => {
    const rotation = workspace.pending.find((intent) => intent.kind === "rotate-publisher");
    if (keyId === workspace.publisherKey.keyId && rotation === undefined) {
      throw new Error("revoking the active publisher key requires rotating to a successor in the same build");
    }
    // Revoking the key a staged rotation is about to make ACTIVE would make every future
    // build fail inside its own verification (assertNoRevokedActiveKeys), with no way to
    // unstage the intent.
    if (rotation?.kind === "rotate-publisher" && rotation.toKeyId === keyId) {
      throw new Error("cannot revoke the key a staged rotation would make active");
    }
    return { kind: "revoke-publisher-key", keyId, reason: assertReason(reason) };
  });
}

/**
 * A key id may never be REUSED, even after its key file is deleted. Consumers record every
 * key id they have ever accepted (`registerKey` refuses a historical id), so a release that
 * re-announces a retired id is one every existing client rejects — while the publisher's own
 * gate, which only knows the current key, happily accepts it.
 */
function assertKeyIdUnused(workspace: PublisherWorkspace, keyId: string): void {
  const used = new Set<string>([workspace.tapKey.keyId, workspace.publisherKey.keyId]);
  for (const rotation of workspace.rotations) {
    used.add(rotation.fromKeyId);
    used.add(rotation.toKey.keyId);
  }
  for (const rotation of workspace.tapKeyRotations) {
    used.add(rotation.fromKeyId);
    used.add(rotation.toKey.keyId);
  }
  for (const intent of workspace.pending) {
    if (intent.kind === "rotate-publisher" || intent.kind === "rotate-tap") used.add(intent.toKeyId);
  }
  if (used.has(keyId)) {
    throw new Error(`key id has already been used by this tap and can never be reused: ${keyId}`);
  }
}

/**
 * One rotation per role per build. Two staged rotations both claim the CURRENT key as
 * their predecessor at the same effective sequence, which continuity refuses as an
 * ambiguous chain — and every later build would fail identically with no way out.
 */
function assertNoPendingRotation(
  workspace: PublisherWorkspace,
  kind: PendingIntent["kind"],
  role: string,
): void {
  if (workspace.pending.some((intent) => intent.kind === kind)) {
    throw new Error(`a ${role} key rotation is already staged; build it before staging another`);
  }
}

/** Sign every staged intent at the sequence the index will actually carry. */
export async function signPendingIntents(
  paths: WorkspacePaths,
  workspace: PublisherWorkspace,
  sequence: number,
  now: Date,
): Promise<SignedIntents> {
  const signed: SignedIntents = { rotations: [], revocations: [] };
  for (const intent of workspace.pending) {
    await applyIntent(paths, workspace, intent, sequence, now, signed);
  }
  return signed;
}

async function applyIntent(
  paths: WorkspacePaths,
  workspace: PublisherWorkspace,
  intent: PendingIntent,
  sequence: number,
  now: Date,
  signed: SignedIntents,
): Promise<void> {
  if (intent.kind === "revoke-package" || intent.kind === "revoke-publisher-key") {
    signed.revocations.push(revocation(intent, now));
    return;
  }
  if (intent.kind === "rotate-publisher") {
    const next = await signPublisherRotation(paths, workspace, intent.toKeyId, sequence);
    signed.rotations.push(next.rotation);
    signed.nextPublisherKey = next.key;
    signed.resignedPackages = await resignPackages(paths, signed.resignedPackages ?? workspace.packages, next.key);
    return;
  }
  const next = await signTapRotation(paths, workspace, intent.toKeyId, sequence);
  signed.tapRotation = next.rotation;
  signed.nextTapKey = next.key;
}

/** Dual-sign a publisher rotation with the predecessor and the successor keys. */
async function signPublisherRotation(
  paths: WorkspacePaths,
  workspace: PublisherWorkspace,
  toKeyId: string,
  effectiveSequence: number,
): Promise<{ rotation: PublisherRotation; key: PublisherKey }> {
  const oldKey = await readPrivateKey(paths, "publisher", workspace.publisherKey.keyId);
  const newKey = await readPrivateKey(paths, "publisher", toKeyId);
  const toKey = { keyId: toKeyId, publicKey: await publicKeyOf(paths, "publisher", toKeyId) };
  const claim = rotationClaim(workspace.tap, {
    publisher: workspace.publisher,
    fromKeyId: workspace.publisherKey.keyId,
    toKey,
    effectiveSequence,
  });
  return {
    key: toKey,
    rotation: {
      publisher: workspace.publisher,
      fromKeyId: workspace.publisherKey.keyId,
      toKey,
      effectiveSequence,
      oldSignature: signClaim(claim, oldKey),
      newSignature: signClaim(claim, newKey),
    },
  };
}

/** Dual-sign a tap-root rotation with the predecessor and the successor keys. */
async function signTapRotation(
  paths: WorkspacePaths,
  workspace: PublisherWorkspace,
  toKeyId: string,
  effectiveSequence: number,
): Promise<{ rotation: TapKeyRotation; key: PublisherKey }> {
  const oldKey = await readPrivateKey(paths, "tap", workspace.tapKey.keyId);
  const newKey = await readPrivateKey(paths, "tap", toKeyId);
  const toKey = { keyId: toKeyId, publicKey: await publicKeyOf(paths, "tap", toKeyId) };
  const claim = tapRotationClaim(workspace.tap, {
    fromKeyId: workspace.tapKey.keyId,
    toKey,
    effectiveSequence,
  });
  return {
    key: toKey,
    rotation: {
      fromKeyId: workspace.tapKey.keyId,
      toKey,
      effectiveSequence,
      oldSignature: signClaim(claim, oldKey),
      newSignature: signClaim(claim, newKey),
    },
  };
}

/**
 * Re-sign every package with the successor publisher key. Without this, every package
 * published before the rotation becomes unverifiable the moment the index announces the
 * new key.
 */
async function resignPackages(
  paths: WorkspacePaths,
  packages: WorkspacePackage[],
  toKey: PublisherKey,
): Promise<WorkspacePackage[]> {
  const key = await readPrivateKey(paths, "publisher", toKey.keyId);
  return packages.map((pkg) => {
    const publisherSignature = signClaim(packageClaim(pkg.coordinate, pkg.payloadDigest), key);
    const envelope = JSON.parse(pkg.envelopeJson) as Record<string, unknown>;
    return {
      ...pkg,
      publisherSignature,
      envelopeJson: JSON.stringify({ ...envelope, publisherSignature }),
    };
  });
}

async function publicKeyOf(paths: WorkspacePaths, role: KeyRole, keyId: string): Promise<string> {
  return readPublicKey(paths, role, keyId);
}

function revocation(
  intent: Extract<PendingIntent, { kind: "revoke-package" | "revoke-publisher-key" }>,
  now: Date,
): TapRevocation {
  return {
    kind: intent.kind === "revoke-package" ? "package" : "publisher-key",
    value: intent.kind === "revoke-package" ? intent.digest : intent.keyId,
    reason: intent.reason,
    revokedAt: now.toISOString(),
  };
}

/** Read-modify-write one staged intent under the workspace lock. */
async function stageIntent(
  paths: WorkspacePaths,
  make: (workspace: PublisherWorkspace) => Promise<PendingIntent>,
): Promise<void> {
  await withExclusiveLock(paths, async () => {
    const workspace = await readWorkspace(paths);
    const intent = await make(workspace);
    await writeWorkspace(paths, { ...workspace, pending: [...workspace.pending, intent] });
  });
}

function assertReason(reason: string): string {
  const text = reason.trim();
  if (text.length === 0 || text.length > 512) throw new Error("revocation reason must be 1-512 characters");
  return text;
}
