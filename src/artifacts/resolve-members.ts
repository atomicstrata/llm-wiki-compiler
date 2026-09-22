/**
 * @file src/artifacts/resolve-members.ts
 * @description The READ-side member verification of a member-bearing artifact:
 * once the manifest body itself verified (`resolve.ts`), the slug directory is
 * swept FIRST through the bounded lister — every entry must be a regular file
 * the manifest (or the manifest pair) names BYTE-EXACTLY, and every manifest
 * row must appear byte-exactly among the entries (a case/normalization alias
 * satisfying two rows with one physical leaf must not verify) — and only then
 * is every listed member read through the confined no-follow capped reader and
 * compared against its row (sha256 + byte count). Sweep-first matters: the
 * member reads are the LAST observation, so the verdict attests bytes at least
 * as fresh as the directory shape — a replace between observations lands on
 * the read side and reddens, matching the single-file artifact's point-in-time
 * semantics.
 *
 * Health vocabulary is the resolver's own: a missing member is `dangling`, an
 * unreadable one `unreadable`, and any divergence `bytes-tampered`. An
 * over-cap leaf is always `bytes-tampered` here: the manifest contract already
 * bounds every ROW by the CURRENT `maxMemberBytes` (body-contract runs before
 * this), so an on-disk size past the cap can never equal its row's recorded
 * length.
 */

import type { ArtifactTypeDef } from "../profile/types.js";
import { listConfinedDirBounded } from "../utils/confined-dir.js";
import { MAX_ARTIFACT_DIR_ENTRIES } from "./name.js";
import { hashMemberBytes, parseMemberEntries, ARTIFACT_SIDECAR_SUFFIX, type ArtifactMemberEntry } from "./members.js";
import { memberLeafPath, readArtifactMemberBytes, type ArtifactPathsV1 } from "./store.js";
import type { ArtifactHealth } from "./resolve.js";

/** Verify one member row against the leaf on disk; null when it verifies. */
async function memberHealth(
  root: string, def: ArtifactTypeDef, paths: ArtifactPathsV1, entry: ArtifactMemberEntry,
): Promise<ArtifactHealth | null> {
  const maxMemberBytes = def.members?.maxMemberBytes ?? 0;
  const read = await readArtifactMemberBytes(root, memberLeafPath(paths.expectedDir, entry.fileName), paths.expectedDir, maxMemberBytes);
  if (read.kind === "absent") return "artifact-dangling";
  if (read.kind === "unavailable") return "artifact-unreadable";
  if (read.kind === "oversize") return "artifact-bytes-tampered"; // rows are cap-bounded; see the file overview
  if (read.body.byteLength !== entry.bytes || hashMemberBytes(read.body) !== entry.sha256) return "artifact-bytes-tampered";
  return null;
}

/**
 * Sweep the slug directory BOTH WAYS: every entry is a regular file the
 * manifest pair or a row names byte-exactly, AND every row has a byte-exact
 * entry (one physical alias cannot satisfy two rows, and a row whose leaf the
 * filesystem folded away is dangling, not silently satisfied).
 */
async function sweepHealth(root: string, def: ArtifactTypeDef, paths: ArtifactPathsV1, entries: readonly ArtifactMemberEntry[]): Promise<ArtifactHealth | null> {
  const listing = await listConfinedDirBounded(root, paths.relativeDir, MAX_ARTIFACT_DIR_ENTRIES);
  if (listing.kind !== "ok") return "artifact-unreadable";
  const allowed = new Set([def.fileName, `${def.fileName}${ARTIFACT_SIDECAR_SUFFIX}`, ...entries.map((entry) => entry.fileName)]);
  const present = new Set<string>();
  for (const entry of listing.entries) {
    if (entry.kind !== "file" || !allowed.has(entry.name)) return "artifact-bytes-tampered";
    present.add(entry.name);
  }
  for (const entry of entries) {
    if (!present.has(entry.fileName)) return "artifact-dangling";
  }
  return null;
}

/**
 * Verify every member of an already-verified manifest body after the directory
 * sweep. Runs ONLY after the manifest passed the body contract, so the rows
 * are structurally valid (and cap-bounded) here.
 *
 * @returns The first failing health, or null when the whole bundle verifies.
 */
export async function verifyMembers(root: string, def: ArtifactTypeDef, paths: ArtifactPathsV1, body: string): Promise<ArtifactHealth | null> {
  const entries = parseMemberEntries(body);
  if (entries === null) return "artifact-schema-invalid"; // unreachable after the body contract; fail closed anyway
  const swept = await sweepHealth(root, def, paths, entries);
  if (swept !== null) return swept;
  for (const entry of entries) {
    const health = await memberHealth(root, def, paths, entry);
    if (health !== null) return health;
  }
  return null;
}
