/**
 * Under-lock artifact write authority — the mirror of applyRelationLocked, with
 * page-style two-file journal durability. Re-loads the profile, COMPOSES the real
 * trust decision (plan.ts), denies on a non-live decision, gates on the
 * LLMWIKI_TRUSTED_WRITE grant (v0 has no byte-staging store), root-anchors the
 * targets' shared PARENT directory BEFORE journaling (a planted symlinked
 * `artifacts/<type>/<slug>` parent is traversed by a leaf-only lstat — the inode
 * check alone would see an outside file as "regular" and pass — so the parent's
 * realpath must match the canonical store dir first), refuses non-regular
 * pre-existing targets BEFORE journaling too (defense-in-depth: recordPreState is
 * itself now root-anchored + no-follow and would refuse these, but the artifact
 * guard fails fast with a store-specific error before any journaling), preflights the exact
 * derived-only audit event, journals the pre-state of BOTH targets, writes bytes
 * then manifest, commits, then emits. Applied-once only when manifest identity
 * AND on-disk bytes both verify.
 */
import { lstat, realpath } from "fs/promises";
import { loadNonDefaultProfile } from "../profile/block.js";
import { isTrustedWriteGranted } from "../workflows/trusted-write.js";
import { openBatch, recordPreState, commitBatch } from "../trust/journal.js";
import { preflightEventAppend, appendEventLocked, type AppendEventInput } from "../events/store.js";
import type { ArtifactPlannedMutation, ArtifactOrigin } from "../trust/planner.js";
import type { ArtifactRef } from "./ref.js";
import type { TrustDecision } from "../trust/decision.js";
import { planArtifactMutation, ARTIFACT_LIVE_WRITE_DECISIONS } from "./plan.js";
import { artifactPaths, hashArtifactBody, writeArtifactFiles, readArtifactManifest, readArtifactBody, resolveExpectedReal, type ArtifactManifest } from "./store.js";

/**
 * Composed non-live decision (undeclared type / body-contract block). NO grant
 * hint — a grant cannot override a planner block. Exported (Task 9): the CLI is
 * its first consumer, routing this class to an advice-free refusal message.
 */
export class ArtifactWriteDeniedError extends Error {
  constructor(artifactType: string, readonly decision: TrustDecision, problems: string[]) {
    super(`artifact write for ${JSON.stringify(artifactType)} was blocked (decision: ${decision}): ${problems.join("; ")}`);
    this.name = "ArtifactWriteDeniedError";
  }
}

/**
 * Missing grant for an otherwise-allowed write — the ONLY refusal that advises
 * the grant. Exported (Task 9): the CLI is its first consumer, routing this
 * class to the `LLMWIKI_TRUSTED_WRITE` grant hint.
 */
export class ArtifactWriteRefusedError extends Error {
  constructor(artifactType: string) {
    super(`artifact write for ${JSON.stringify(artifactType)} requires an out-of-band LLMWIKI_TRUSTED_WRITE grant`);
    this.name = "ArtifactWriteRefusedError";
  }
}

/**
 * A pre-existing target that is not a regular file (symlink/FIFO/dir) — refused
 * before any read or journal write. Exported (Task 9): the CLI is its first
 * consumer, routing this class to an advice-free refusal message.
 */
export class ArtifactTargetNotRegularError extends Error {
  constructor(targetPath: string) {
    super(`artifact target ${JSON.stringify(targetPath)} exists but is not a regular file`);
    this.name = "ArtifactTargetNotRegularError";
  }
}

/**
 * The targets' shared parent directory resolves somewhere other than the
 * canonical store dir (a planted symlinked `artifacts/<type>/<slug>`, or an
 * unreadable root) — refused before any read or journal write. Deliberately NO
 * grant hint: same non-grant-hinting failure class as {@link ArtifactTargetNotRegularError}.
 * Exported (Task 9): the CLI is its first consumer, routing this class to an
 * advice-free refusal message.
 */
export class ArtifactTargetDirEscapesRootError extends Error {
  constructor(expectedDir: string) {
    super(`artifact target directory ${JSON.stringify(expectedDir)} is not the canonical store directory`);
    this.name = "ArtifactTargetDirEscapesRootError";
  }
}

const artifactEvent = (m: ArtifactManifest, origin: ArtifactOrigin, decision: TrustDecision): AppendEventInput => ({
  type: "artifact-write", origin,
  payload: { artifactType: m.artifactType, slug: m.slug, sha256: m.sha256, bytes: m.bytes, contentKind: m.contentKind },
  decision, at: new Date().toISOString(),
});

/**
 * Root-anchor the two targets' SHARED PARENT directory (`paths.expectedDir`)
 * BEFORE the leaf lstat checks below. `lstat` on a leaf no-follows only that
 * FINAL component — a symlinked PARENT (e.g. `artifacts/<type>/<slug>` pointing
 * outside root) is silently traversed, so lstat would see an outside file as
 * "regular" and the leaf check alone would pass, letting `recordPreState`'s plain
 * `readFile` copy outside bytes into the in-repo journal. Reuses the store's
 * read-side {@link resolveExpectedReal} so both sides root-anchor identically.
 * Both bytesPath and manifestPath share one parent, so a single check covers
 * both targets.
 */
async function assertParentDirConfined(root: string, expectedDir: string): Promise<void> {
  const expectedReal = await resolveExpectedReal(root, expectedDir);
  if (expectedReal === null) throw new ArtifactTargetDirEscapesRootError(expectedDir); // root itself unreadable — fail closed
  let parentReal: string;
  try {
    parentReal = await realpath(expectedDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return; // first write — parent doesn't exist yet
    throw new ArtifactTargetDirEscapesRootError(expectedDir); // any other realpath fault — fail closed
  }
  if (parentReal !== expectedReal) throw new ArtifactTargetDirEscapesRootError(expectedDir);
}

/** lstat both targets; a present entry that is not a regular file fails closed (never followed, never read). */
async function assertTargetsRegularOrAbsent(root: string, paths: { bytesPath: string; manifestPath: string; expectedDir: string }): Promise<void> {
  await assertParentDirConfined(root, paths.expectedDir); // BEFORE the leaf lstat checks — see this function's overview
  for (const target of [paths.bytesPath, paths.manifestPath]) {
    const st = await lstat(target).catch(() => null);
    if (st !== null && !st.isFile()) throw new ArtifactTargetNotRegularError(target);
  }
}

/** Applied-once: manifest identity AND on-disk bytes must BOTH verify (a lying/orphaned manifest is rewritten). */
async function isAlreadyApplied(root: string, paths: { bytesPath: string; manifestPath: string; expectedDir: string }, m: ArtifactManifest, maxBytes: number): Promise<boolean> {
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
export async function applyArtifactLocked(root: string, mutation: ArtifactPlannedMutation): Promise<{ ref: ArtifactRef; decision: TrustDecision }> {
  const loaded = await loadNonDefaultProfile(root);
  if (!loaded) throw new ArtifactWriteDeniedError(mutation.artifactType, "deny", ["no profile is active; artifacts require a profile-declared artifact type"]);
  const { decision, checks, def } = planArtifactMutation(loaded.profile, mutation);
  if (!ARTIFACT_LIVE_WRITE_DECISIONS.has(decision) || !def) {
    throw new ArtifactWriteDeniedError(mutation.artifactType, decision, checks.filter((c) => c.verdict !== "pass").map((c) => c.message));
  }
  if (!isTrustedWriteGranted(loaded.profile.profileId)) throw new ArtifactWriteRefusedError(mutation.artifactType);
  const sha256 = hashArtifactBody(mutation.body);
  const paths = artifactPaths(root, mutation.artifactType, mutation.slug, def.fileName);
  await assertTargetsRegularOrAbsent(root, paths); // BEFORE journaling — see file overview
  const ref: ArtifactRef = { artifactType: mutation.artifactType, slug: mutation.slug, sha256 };
  const manifest: ArtifactManifest = { ...ref, bytes: Buffer.byteLength(mutation.body, "utf8"), contentKind: def.contentKind, writtenAt: new Date().toISOString() };
  if (await isAlreadyApplied(root, paths, manifest, def.maxBytes)) return { ref, decision };
  const event = artifactEvent(manifest, mutation.origin, decision); // build ONCE — preflight and append the SAME object
  await preflightEventAppend(root, event);
  const batch = await openBatch(root);
  await recordPreState(batch, paths.bytesPath);
  await recordPreState(batch, paths.manifestPath);
  await writeArtifactFiles(root, paths, mutation.body, manifest);
  await commitBatch(batch);
  await appendEventLocked(root, event);
  return { ref, decision };
}
