/**
 * Commander actions for `llmwiki profile` subcommands — all READ-ONLY.
 *
 * - `profile show` prints the active profile's id, digest, and the file it was
 *   loaded from (or that it is the built-in default).
 * - `profile validate` re-validates the active profile and exits 0 when valid /
 *   non-zero with a clear message when invalid.
 * - `profile diff` classifies on-disk pages over the disposition lattice for an
 *   EXPLICIT old → new pair: `--candidate <file>` diffs the active profile (old)
 *   against an uninstalled candidate file (new); `--from <a> --to <b>` is a pure
 *   offline diff; no flags on a default project prints "no profile changes".
 *
 * Every handler WRITES NOTHING — no `.llmwiki/adaptation/` writes, no profile
 * installation. `profile diff` reads NO persisted previous-profile state: the
 * OLD pack is always the active file or an explicit `--from`.
 */

import { readFile } from "node:fs/promises";
import * as output from "../utils/output.js";
import { loadProfile } from "../profile/load.js";
import { validateProfile } from "../profile/validate.js";
import { isDefaultProfile } from "../profile/default.js";
import { diffProfiles, DISPOSITIONS, type ProfileDiffReport } from "../profile/diff.js";
import type { ProfilePack } from "../profile/types.js";

/** Options accepted by `profile diff`. */
export interface ProfileDiffOptions {
  candidate?: string;
  from?: string;
  to?: string;
}

/** Print the active profile's id, digest, and source. Read-only. */
export async function profileShow(): Promise<void> {
  const loaded = await loadProfile(process.cwd());
  const loadedFrom = loaded.loadedFrom ?? "(built-in default — no profile.json)";
  output.header(`Profile ${loaded.profile.profileId}`);
  console.log(`profileId:  ${loaded.profile.profileId}`);
  console.log(`digest:     ${loaded.digest}`);
  console.log(`loadedFrom: ${loadedFrom}`);
}

/**
 * Re-validate the active profile. Exits 0 when valid; on any validation/load
 * failure prints a clear red error and exits non-zero. Read-only.
 */
export async function profileValidate(): Promise<number> {
  try {
    const loaded = await loadProfile(process.cwd());
    output.status("+", output.success(`Profile '${loaded.profile.profileId}' is valid`));
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\x1b[31mError:\x1b[0m ${message}`);
    return 1;
  }
}

/** Read and validate a profile pack from an explicit file path (fail-closed). */
async function loadProfileFile(filePath: string): Promise<ProfilePack> {
  const raw = await readFile(filePath, "utf8");
  return validateProfile(JSON.parse(raw)).profile;
}

/** A resolved old → new profile pair to diff. */
interface DiffPair {
  old: ProfilePack;
  next: ProfilePack;
}

/** Count how many of the offline (`--from`, `--to`) flags were supplied. */
function offlineFlagCount(options: ProfileDiffOptions): number {
  return [options.from, options.to].filter(Boolean).length;
}

/** Reject combining `--candidate` with `--from`/`--to`, or a half-set offline pair. */
function assertDiffFlags(options: ProfileDiffOptions): void {
  const offline = offlineFlagCount(options);
  if (options.candidate && offline > 0) {
    throw new Error("--candidate cannot be combined with --from/--to");
  }
  if (offline === 1) {
    throw new Error("--from and --to must be supplied together");
  }
}

/**
 * Resolve the OLD → NEW profile pair for `profile diff` from the flags. Mutually
 * exclusive: `--candidate <file>` pairs the active profile (old) with the file
 * (new); `--from <a> --to <b>` is a pure offline pair. Returns null when no
 * flags are given (the "no changes" path).
 */
async function resolveDiffPair(root: string, options: ProfileDiffOptions): Promise<DiffPair | null> {
  assertDiffFlags(options);
  if (options.candidate) {
    return { old: (await loadProfile(root)).profile, next: await loadProfileFile(options.candidate) };
  }
  if (options.from && options.to) {
    return { old: await loadProfileFile(options.from), next: await loadProfileFile(options.to) };
  }
  return null;
}

/** Print the per-disposition counts (highest priority first) then page lines. */
function printDiffBody(report: ProfileDiffReport): void {
  for (const disposition of [...DISPOSITIONS].reverse()) {
    console.log(`${disposition}: ${report.counts[disposition]}`);
  }
  for (const page of report.pages) {
    console.log(`  ${page.disposition}\t${page.directory}/${page.stem}`);
  }
}

/** Print the diff report header, then either "no profile changes" or the body. */
function printDiffReport(report: ProfileDiffReport): void {
  output.header(`Profile diff (${report.oldDigest.slice(0, 12)} → ${report.newDigest.slice(0, 12)})`);
  if (report.unchanged && report.pages.length === 0) {
    console.log("no profile changes");
    return;
  }
  printDiffBody(report);
}

/**
 * Diff the active (or `--from`) profile against a candidate (or `--to`) and
 * print the disposition classification. On a default project with no flags,
 * prints "no profile changes". WRITES NOTHING.
 */
export async function profileDiff(options: ProfileDiffOptions): Promise<number> {
  const root = process.cwd();
  const pair = await resolveDiffPair(root, options);
  if (!pair) {
    if (isDefaultProfile((await loadProfile(root)).profile)) {
      console.log("no profile changes");
      return 0;
    }
    throw new Error("profile diff requires --candidate, or --from with --to");
  }
  printDiffReport(await diffProfiles(root, pair.old, pair.next));
  return 0;
}
