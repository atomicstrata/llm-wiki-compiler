/**
 * @file src/artifacts/apply-guards.ts
 * @description The pre-journal guards and the audit-event builder every artifact
 * write shares (single-file and member-bearing alike): the typed refusal
 * classes the CLI routes, the parent-directory root-anchoring (a planted
 * symlinked `artifacts/<type>/<slug>` is traversed by a leaf-only lstat — the
 * inode check alone would see an outside file as "regular"), the
 * regular-or-absent target check, and the derived-only `artifact-write` event.
 * One home so the two write paths cannot drift on what they refuse BEFORE
 * journaling.
 */
import { lstat, realpath } from "fs/promises";
import { appendEventLocked, appendBoundEventLocked, type AppendEventInput } from "../events/store.js";
import type { OperationBinding } from "../utils/operation-binding.js";
import type { ArtifactOrigin } from "../trust/planner.js";
import type { TrustDecision } from "../trust/decision.js";
import { resolveExpectedReal, type ArtifactManifest } from "./store.js";

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

/**
 * The slug directory could not be enumerated within the store's entry cap (or
 * at all) — a member-bearing write refuses rather than guess which existing
 * leaves it would leave behind. No grant hint.
 */
export class ArtifactTargetDirUnreadableError extends Error {
  constructor(expectedDir: string) {
    super(`artifact target directory ${JSON.stringify(expectedDir)} could not be enumerated within the store's entry cap`);
    this.name = "ArtifactTargetDirUnreadableError";
  }
}

/** The persisted identity of one artifact write: the pinned ref and its sidecar manifest, derived from the SAME body. */
export function refAndManifest(
  mutation: { artifactType: string; slug: string }, contentKind: ArtifactManifest["contentKind"], sha256: string, body: string,
): { ref: { artifactType: string; slug: string; sha256: string }; manifest: ArtifactManifest } {
  const ref = { artifactType: mutation.artifactType, slug: mutation.slug, sha256 };
  return { ref, manifest: { ...ref, bytes: Buffer.byteLength(body, "utf8"), contentKind, writtenAt: new Date().toISOString() } };
}

/** The derived-only audit event for one persisted artifact manifest. */
export function artifactEvent(m: ArtifactManifest, origin: ArtifactOrigin, decision: TrustDecision): AppendEventInput {
  return {
    type: "artifact-write", origin,
    payload: { artifactType: m.artifactType, slug: m.slug, sha256: m.sha256, bytes: m.bytes, contentKind: m.contentKind },
    decision, at: new Date().toISOString(),
  };
}

/**
 * Root-anchor the targets' SHARED PARENT directory (`expectedDir`) BEFORE any
 * leaf lstat. `lstat` on a leaf no-follows only that FINAL component — a
 * symlinked PARENT (e.g. `artifacts/<type>/<slug>` pointing outside root) is
 * silently traversed, so lstat would see an outside file as "regular" and the
 * leaf check alone would pass, letting the journal copy outside bytes into the
 * in-repo journal. Reuses the store's read-side {@link resolveExpectedReal} so
 * both sides root-anchor identically.
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

/**
 * Confine the parent, then lstat every target; a present entry that is not a
 * regular file fails closed (never followed, never read).
 */
export async function assertTargetsRegularOrAbsent(root: string, expectedDir: string, targets: readonly string[]): Promise<void> {
  await assertParentDirConfined(root, expectedDir); // BEFORE the leaf lstat checks — see the function's overview
  for (const target of targets) {
    const st = await lstat(target).catch(() => null);
    if (st !== null && !st.isFile()) throw new ArtifactTargetNotRegularError(target);
  }
}

/**
 * Emit the derived-only artifact event through the existing public event store.
 */
export async function emitArtifactEvent(root: string, event: AppendEventInput, binding?: OperationBinding): Promise<void> {
  if (binding === undefined) await appendEventLocked(root, event);
  else await appendBoundEventLocked(root, event, binding);
}
