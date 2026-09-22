/**
 * Under-lock artifact write authority — the mirror of applyRelationLocked, with
 * page-style two-file journal durability. Re-loads the profile, COMPOSES the real
 * trust decision (plan.ts), denies on a non-live decision, gates on the
 * LLMWIKI_TRUSTED_WRITE grant (v0 has no byte-staging store), root-anchors the
 * targets' shared PARENT directory BEFORE journaling and refuses non-regular
 * pre-existing targets BEFORE journaling too (`apply-guards.ts`), preflights the
 * exact derived-only audit event, journals the pre-state of BOTH targets, writes
 * bytes then manifest, commits, then emits. Applied-once only when manifest
 * identity AND on-disk bytes both verify.
 *
 * A MEMBER-BEARING type takes the same admission (plan → grant) and then the
 * members write path (`apply-members.ts`): one batch over the manifest pair, the
 * member leaves, and any obsolete leaf.
 */
import { loadNonDefaultProfile } from "../profile/block.js";
import { isTrustedWriteGranted } from "../trust/trusted-write.js";
import { openBatch, recordPreState, commitBatch } from "../trust/journal.js";
import { preflightEventAppend } from "../events/store.js";
import type { OperationBinding } from "../utils/operation-binding.js";
import type { ArtifactPlannedMutation } from "../trust/planner.js";
import type { ArtifactRef } from "./ref.js";
import type { TrustDecision } from "../trust/decision.js";
import { planArtifactMutation, ARTIFACT_LIVE_WRITE_DECISIONS } from "./plan.js";
import { artifactPaths, hashArtifactBody, writeArtifactFiles, readArtifactManifest, readArtifactBody, type ArtifactManifest, type ArtifactPathsV1 } from "./store.js";
import { snapshotMemberFiles } from "./members.js";
import { applyMembersLocked } from "./apply-members.js";
import {
  ArtifactWriteDeniedError, ArtifactWriteRefusedError, artifactEvent, assertTargetsRegularOrAbsent, emitArtifactEvent,
  refAndManifest,
} from "./apply-guards.js";

// The typed refusal classes keep their historical import home (the members-only
// ArtifactTargetDirUnreadableError lives in apply-guards until a surface routes it).
export {
  ArtifactWriteDeniedError, ArtifactWriteRefusedError, ArtifactTargetNotRegularError, ArtifactTargetDirEscapesRootError,
} from "./apply-guards.js";

/** Applied-once: manifest identity AND on-disk bytes must BOTH verify (a lying/orphaned manifest is rewritten). */
async function isAlreadyApplied(root: string, paths: ArtifactPathsV1, m: ArtifactManifest, maxBytes: number): Promise<boolean> {
  const existing = await readArtifactManifest(root, paths);
  if (existing.kind !== "ok") return false;
  const e = existing.manifest;
  if (e.sha256 !== m.sha256 || e.bytes !== m.bytes || e.contentKind !== m.contentKind
    || e.artifactType !== m.artifactType || e.slug !== m.slug) return false;
  const onDisk = await readArtifactBody(root, paths, maxBytes);
  return onDisk.kind === "ok" && hashArtifactBody(onDisk.body) === m.sha256
    && Buffer.byteLength(onDisk.body, "utf8") === m.bytes;
}

/**
 * Apply an `artifact` mutation WHILE THE CALLER ALREADY HOLDS the project lock —
 * the under-lock authority for the artifact kind. RE-loads the active profile
 * under the lock, COMPOSES the real decision via {@link planArtifactMutation}
 * (an undeclared type or a body-contract violation denies WITHOUT the grant
 * hint — a grant cannot override a planner block), then gates the live-decision
 * case on the operator {@link isTrustedWriteGranted} grant (the ONLY refusal
 * that advises it). The targets' parent directory and any pre-existing
 * non-regular target are both refused BEFORE any journal write (see the file
 * overview). Applied-once short-circuits only when
 * BOTH the manifest and the on-disk bytes verify; otherwise the bytes are
 * (re)written under the journal and the audit event is emitted.
 *
 * @param root - Absolute project root (the caller holds its lock).
 * @param mutation - The planned artifact mutation (intent only; not trusted).
 * @returns The persisted {@link ArtifactRef} and the composed live-write decision.
 */
export async function applyArtifactLocked(root: string, supplied: ArtifactPlannedMutation, binding?: OperationBinding): Promise<{ ref: ArtifactRef; decision: TrustDecision }> {
  // SNAPSHOT the member bytes before anything else awaits: the plan hashes
  // them and the write lands them, and both must see the SAME frozen bytes
  // even if the caller mutates its buffers mid-flight (see members.ts).
  const mutation: ArtifactPlannedMutation = supplied.memberFiles === undefined
    ? supplied : { ...supplied, memberFiles: snapshotMemberFiles(supplied.memberFiles) };
  const loaded = await loadNonDefaultProfile(root);
  if (!loaded) throw new ArtifactWriteDeniedError(mutation.artifactType, "deny", ["no profile is active; artifacts require a profile-declared artifact type"]);
  const { decision, checks, def, body } = planArtifactMutation(loaded.profile, mutation);
  if (!ARTIFACT_LIVE_WRITE_DECISIONS.has(decision) || !def || body === undefined) {
    throw new ArtifactWriteDeniedError(mutation.artifactType, decision, checks.filter((c) => c.verdict !== "pass").map((c) => c.message));
  }
  if (!isTrustedWriteGranted(loaded.profile.profileId)) throw new ArtifactWriteRefusedError(mutation.artifactType);
  const paths = artifactPaths(root, mutation.artifactType, mutation.slug, def.fileName);
  if (def.members !== undefined) {
    return applyMembersLocked({ root, profile: loaded.profile, def, mutation, body, decision, paths, binding });
  }
  await assertTargetsRegularOrAbsent(root, paths.expectedDir, [paths.bytesPath, paths.manifestPath]); // BEFORE journaling — see file overview
  const { ref, manifest } = refAndManifest(mutation, def.contentKind, hashArtifactBody(body), body) as { ref: ArtifactRef; manifest: ArtifactManifest };
  if (await isAlreadyApplied(root, paths, manifest, def.maxBytes)) return { ref, decision };
  const event = artifactEvent(manifest, mutation.origin, decision); // build ONCE — preflight and append the SAME object
  await preflightEventAppend(root, event);
  const batch = await openBatch(root);
  await recordPreState(batch, paths.bytesPath);
  await recordPreState(batch, paths.manifestPath);
  await writeArtifactFiles(root, paths, body, manifest);
  await commitBatch(batch);
  await emitArtifactEvent(root, event, binding);
  return { ref, decision };
}
