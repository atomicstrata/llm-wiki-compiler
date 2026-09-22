/**
 * @file src/artifacts/apply-members.ts
 * @description The under-lock write of a MEMBER-BEARING artifact: the manifest
 * pair plus every member leaf land in ONE journal batch, and every existing
 * regular leaf the new member set no longer names (an OBSOLETE leaf — a shrink
 * or a rename) is pre-state-journaled and unlinked inside that same batch, so a
 * crash at any point replays to the pre-batch directory or lands the exact new
 * set. Applied-once is the read side's own verdict: only a bundle whose
 * manifest AND every member verify AND whose directory holds nothing else is
 * short-circuited; anything less rewrites (which also repairs a stale leaf).
 *
 * Member pre-states are captured base64-ALWAYS (`recordBinaryPreState`), and
 * the batch carries an explicit aggregate budget derived from the declared
 * ceilings — a bounded batch by construction, per the journal's opt-in rule.
 */
import { unlink } from "fs/promises";
import type { ProfilePack, ArtifactTypeDef } from "../profile/types.js";
import type { ArtifactPlannedMutation } from "../trust/planner.js";
import type { TrustDecision } from "../trust/decision.js";
import { openBatch, recordPreState, recordBinaryPreState, commitBatch } from "../trust/journal.js";
import { preflightEventAppend } from "../events/store.js";
import type { OperationBinding } from "../utils/operation-binding.js";
import { confineUnderRoot } from "../utils/path-confine.js";
import { listConfinedDirBounded } from "../utils/confined-dir.js";
import type { ArtifactRef } from "./ref.js";
import { MAX_ARTIFACT_DIR_ENTRIES } from "./name.js";
import { ARTIFACT_SIDECAR_SUFFIX, memberAliasKey, type ArtifactMemberFileInput } from "./members.js";
import { resolveArtifactRef } from "./resolve.js";
import {
  ARTIFACT_MANIFEST_MAX_BYTES, hashArtifactBody, memberLeafPath, writeArtifactFiles, writeArtifactMember, type ArtifactManifest, type ArtifactPathsV1,
} from "./store.js";
import {
  ArtifactTargetDirUnreadableError, ArtifactTargetNotRegularError, artifactEvent, assertTargetsRegularOrAbsent, emitArtifactEvent,
  refAndManifest,
} from "./apply-guards.js";

/** Everything the members write needs, resolved by the caller under the lock. */
export interface MembersWriteV1 {
  root: string;
  profile: ProfilePack;
  def: ArtifactTypeDef;
  mutation: ArtifactPlannedMutation;
  /** The canonical manifest body core derived (the plan's `body`). */
  body: string;
  decision: TrustDecision;
  paths: ArtifactPathsV1;
  binding?: OperationBinding;
}

/**
 * An existing leaf whose name ALIASES (case/unicode-folds to) a new member's —
 * on a case-insensitive filesystem the two are ONE physical file, so writing
 * the new spelling and unlinking the old would delete what was just written.
 * Refused DETERMINISTICALLY on every platform (a rename that only refolds a
 * name must remove the old leaf first), so bundles behave identically across
 * checkouts. No grant hint.
 */
class ArtifactMembersDivergedError extends Error {
  constructor(slug: string, health: string) {
    super(`member-bearing artifact ${JSON.stringify(slug)} does not resolve after its own commit (health: ${health}); the filesystem folded or altered a landed leaf — the write is refused, not reported as success`);
    this.name = "ArtifactMembersDivergedError";
  }
}

class ArtifactMemberAliasCollisionError extends Error {
  constructor(existing: string, incoming: string) {
    super(`existing member leaf ${JSON.stringify(existing)} alias-collides with new member ${JSON.stringify(incoming)}; remove the old leaf before a case/normalization-only rename`);
    this.name = "ArtifactMemberAliasCollisionError";
  }
}

/**
 * The regular leaves in the slug dir that the new member set does not name.
 * Any non-regular entry refuses (never followed); an over-cap or unreadable
 * directory refuses rather than leaving unknown leaves behind; an obsolete
 * leaf that ALIASES a kept name refuses (see {@link ArtifactMemberAliasCollisionError}).
 */
async function obsoleteLeaves(write: MembersWriteV1, keep: ReadonlySet<string>): Promise<string[]> {
  const listing = await listConfinedDirBounded(write.root, write.paths.relativeDir, MAX_ARTIFACT_DIR_ENTRIES);
  if (listing.kind === "absent") return [];
  if (listing.kind === "unavailable") throw new ArtifactTargetDirUnreadableError(write.paths.expectedDir);
  const keptAliases = new Map([...keep].map((name) => [memberAliasKey(name), name] as const));
  const obsolete: string[] = [];
  for (const entry of listing.entries) {
    if (entry.kind !== "file") throw new ArtifactTargetNotRegularError(memberLeafPath(write.paths.expectedDir, entry.name));
    if (keep.has(entry.name)) continue;
    const aliased = keptAliases.get(memberAliasKey(entry.name));
    if (aliased !== undefined) throw new ArtifactMemberAliasCollisionError(entry.name, aliased);
    obsolete.push(memberLeafPath(write.paths.expectedDir, entry.name));
  }
  return obsolete;
}

/** Unlink one obsolete leaf via a path re-confined at delete time (the journal holds its pre-state). */
async function unlinkConfined(root: string, leafPath: string, relativeDir: string, name: string): Promise<void> {
  void leafPath;
  const confined = await confineUnderRoot(`${relativeDir}/${name}`, root, { mustExist: false });
  await unlink(confined);
}

/** The aggregate pre-state budget a members batch is bounded by: new + obsolete members, plus the manifest pair. */
function batchBudget(def: ArtifactTypeDef): number {
  const members = def.members?.maxTotalBytes ?? 0;
  return 2 * members + def.maxBytes + ARTIFACT_MANIFEST_MAX_BYTES;
}

/**
 * Journal the manifest pair, every member target, and every obsolete leaf,
 * then write members → manifest pair → unlink obsolete leaves → commit.
 */
async function writeUnderJournal(
  write: MembersWriteV1, files: readonly ArtifactMemberFileInput[], manifest: ArtifactManifest, obsolete: readonly string[],
): Promise<void> {
  const { root, def, paths } = write;
  const maxPreStateBytes = def.members?.maxMemberBytes ?? 0;
  const batch = await openBatch(root, { maxAggregatePreStateBytes: batchBudget(def) });
  await recordPreState(batch, paths.bytesPath);
  await recordPreState(batch, paths.manifestPath);
  for (const file of files) await recordBinaryPreState(batch, memberLeafPath(paths.expectedDir, file.fileName), { maxPreStateBytes });
  for (const leaf of obsolete) await recordBinaryPreState(batch, leaf, { maxPreStateBytes });
  for (const file of files) await writeArtifactMember(root, memberLeafPath(paths.expectedDir, file.fileName), file.bytes);
  await writeArtifactFiles(root, paths, write.body, manifest);
  for (const leaf of obsolete) await unlinkConfined(root, leaf, paths.relativeDir, leaf.slice(paths.expectedDir.length + 1));
  await commitBatch(batch);
}

/**
 * Apply a member-bearing artifact mutation WHILE THE CALLER HOLDS the project
 * lock, after the plan admitted it and the grant was checked.
 *
 * @returns The persisted ref (the manifest body's sha — a Merkle root) and the composed decision.
 */
export async function applyMembersLocked(write: MembersWriteV1): Promise<{ ref: ArtifactRef; decision: TrustDecision }> {
  const { root, def, mutation, body, paths } = write;
  const files = mutation.memberFiles ?? [];
  const memberPaths = files.map((file) => memberLeafPath(paths.expectedDir, file.fileName));
  await assertTargetsRegularOrAbsent(root, paths.expectedDir, [paths.bytesPath, paths.manifestPath, ...memberPaths]);
  const { ref, manifest } = refAndManifest(mutation, def.contentKind, hashArtifactBody(body), body) as { ref: ArtifactRef; manifest: ArtifactManifest };
  // Applied-once is the resolver's verdict: manifest + every member + exact directory set.
  if ((await resolveArtifactRef(root, write.profile, ref)).health === "ok") return { ref, decision: write.decision };
  const keep = new Set([def.fileName, `${def.fileName}${ARTIFACT_SIDECAR_SUFFIX}`, ...files.map((file) => file.fileName)]);
  const obsolete = await obsoleteLeaves(write, keep);
  const event = artifactEvent(manifest, mutation.origin, write.decision); // build ONCE — preflight and append the SAME object
  await preflightEventAppend(root, event);
  await writeUnderJournal(write, files, manifest, obsolete);
  // POST-COMMIT VERIFICATION: re-resolve the ref the caller is about to trust.
  // The alias key aims to refuse filesystem folds up front, but no string fold
  // is provably identical to every filesystem's — and a divergence here is a
  // COMMITTED false success (the µ/μ fold deleted the member it just wrote and
  // still returned ok). Any non-ok health refuses loudly instead. The batch
  // already committed — replay restores nothing — so RE-ISSUING THE WRITE is
  // the recovery verb: the caller still holds the member bytes, and the
  // rewrite lands them under the surviving spelling.
  const landed = await resolveArtifactRef(root, write.profile, ref);
  if (landed.health !== "ok") throw new ArtifactMembersDivergedError(mutation.slug, landed.health);
  await emitArtifactEvent(root, event, write.binding);
  return { ref, decision: write.decision };
}
