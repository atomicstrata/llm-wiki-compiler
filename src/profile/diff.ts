/**
 * Read-only profile diff over the disposition lattice.
 *
 * Given an OLD profile pack and a NEW (candidate) profile pack plus the project
 * root, `diffProfiles` classifies every on-disk page under either profile's
 * entity directories into exactly one disposition. It WRITES NOTHING and reads
 * NO persisted previous-profile state — the OLD pack is supplied explicitly by
 * the caller (the active `.llmwiki/profile.json`, or an offline `--from` file).
 *
 * The disposition lattice, highest priority first:
 *   blocked > needs-migration > orphaned-by-config > deprecated >
 *   newly-supported > unchanged
 * A page receives the highest-priority disposition that applies. Classification
 * is scoped to entity directories, frontmatter, and the profile digest only —
 * no source hashing, no LLM, no compile.
 */

import { scanEntityDir, type RawEntityScan } from "../wiki/collect.js";
import { isSlugSafe } from "./identity.js";
import { profileDigest } from "./digest.js";
import type { ProfilePack, EntityTypeDef } from "./types.js";

/** The six dispositions, ordered low → high priority for the lattice. */
export const DISPOSITIONS = [
  "unchanged",
  "newly-supported",
  "deprecated",
  "orphaned-by-config",
  "needs-migration",
  "blocked",
] as const;

/** A single on-disk page's classification under the old → new diff. */
export type Disposition = (typeof DISPOSITIONS)[number];

/** One classified page in the diff report. */
export interface PageDisposition {
  /** Repo-relative directory the page lives in. */
  directory: string;
  /** Filename stem (basename minus `.md`), verbatim. */
  stem: string;
  /** The assigned disposition (highest-priority applicable). */
  disposition: Disposition;
}

/** The full diff report: digests, per-disposition counts, and classified pages. */
export interface ProfileDiffReport {
  oldDigest: string;
  newDigest: string;
  /** True when the two packs are byte-identical after canonicalization. */
  unchanged: boolean;
  counts: Record<Disposition, number>;
  pages: PageDisposition[];
}

/** Map a repo-relative directory to the entity type that claims it, if any. */
function directoryOwners(profile: ProfilePack): Map<string, string> {
  const owners = new Map<string, string>();
  for (const [entityType, def] of Object.entries(profile.entities) as [string, EntityTypeDef][]) {
    owners.set(def.directory, entityType);
  }
  return owners;
}

/** Resolved old/new ownership context shared by every page classification. */
interface DiffContext {
  /** Repo-relative directory → entity type, for the OLD profile. */
  oldOwners: Map<string, string>;
  /** Repo-relative directory → entity type, for the NEW profile. */
  newOwners: Map<string, string>;
  /** Entity type → repo-relative directory, for the NEW profile. */
  newTypeToDir: Map<string, string>;
}

/**
 * Disposition for a page whose old-owning entity type is `oldType`:
 *   - the type is gone from the new profile → deprecated;
 *   - the type remains under the SAME directory → unchanged;
 *   - the type remains but its directory MOVED → needs-migration.
 */
function classifyKnownType(oldType: string, directory: string, ctx: DiffContext): Disposition {
  const newDir = ctx.newTypeToDir.get(oldType);
  if (newDir === undefined) return "deprecated";
  return newDir === directory ? "unchanged" : "needs-migration";
}

/**
 * Classify one scanned page. Classification is TYPE-keyed off the directory's
 * old owner, so a page is judged by what happened to its entity type (see
 * {@link classifyKnownType}). A non-slug-safe stem is blocked (the strict
 * identity path would fail closed). A directory with no old owner is
 * newly-supported when the new profile claims it, else orphaned-by-config.
 * Returns the highest-priority applicable disposition (see the file header).
 */
function classifyPage(scan: RawEntityScan, directory: string, ctx: DiffContext): Disposition {
  if (!isSlugSafe(scan.stem)) return "blocked";
  const oldType = ctx.oldOwners.get(directory);
  if (oldType) return classifyKnownType(oldType, directory, ctx);
  return ctx.newOwners.has(directory) ? "newly-supported" : "orphaned-by-config";
}

/** Every repo-relative entity directory declared by either profile, deduped. */
function unionDirectories(oldOwners: Map<string, string>, newOwners: Map<string, string>): string[] {
  return [...new Set([...oldOwners.keys(), ...newOwners.keys()])];
}

/** Scan one directory and classify each page, appending to `pages`. */
async function classifyDirectory(
  root: string,
  directory: string,
  ctx: DiffContext,
  pages: PageDisposition[],
): Promise<void> {
  const scans = await scanEntityDir(root, directory, directory);
  for (const scan of scans) {
    pages.push({ directory, stem: scan.stem, disposition: classifyPage(scan, directory, ctx) });
  }
}

/** Seed a zeroed count for every disposition, then tally the classified pages. */
function tally(pages: PageDisposition[]): Record<Disposition, number> {
  const counts = Object.fromEntries(DISPOSITIONS.map((d) => [d, 0])) as Record<Disposition, number>;
  for (const page of pages) counts[page.disposition] += 1;
  return counts;
}

/**
 * Diff an OLD profile against a NEW (candidate) profile over the project's
 * on-disk pages. Pure read: scans entity directories, classifies each page, and
 * returns digests + counts + classifications. Writes nothing.
 *
 * @param root - Absolute project root directory.
 * @param oldProfile - The currently active (or `--from`) profile pack.
 * @param newProfile - The candidate (or `--to`) profile pack.
 */
export async function diffProfiles(
  root: string,
  oldProfile: ProfilePack,
  newProfile: ProfilePack,
): Promise<ProfileDiffReport> {
  const oldOwners = directoryOwners(oldProfile);
  const newOwners = directoryOwners(newProfile);
  const newTypeToDir = new Map([...newOwners].map(([dir, type]) => [type, dir]));
  const ctx: DiffContext = { oldOwners, newOwners, newTypeToDir };
  const pages: PageDisposition[] = [];
  for (const directory of unionDirectories(oldOwners, newOwners)) {
    await classifyDirectory(root, directory, ctx, pages);
  }
  pages.sort((a, b) => a.directory.localeCompare(b.directory) || a.stem.localeCompare(b.stem));
  const oldDigest = profileDigest(oldProfile);
  const newDigest = profileDigest(newProfile);
  return { oldDigest, newDigest, unchanged: oldDigest === newDigest, counts: tally(pages), pages };
}
