/**
 * Shared non-default-profile summary block (profileId, digest, per-type entity
 * counts, problems).
 *
 * This is the single source of truth for the additive `profile` block that the
 * `status` collector and the viewer snapshot both surface. Centralizing it
 * keeps the two surfaces byte-identical to each other and prevents the gate
 * logic (built-in-default detection, count seeding, problem mapping) from
 * drifting between them.
 *
 * For the built-in default profile this returns `undefined` so each caller
 * omits the `profile` key entirely and its default envelope is unchanged. The
 * built-in is identified by `loadedFrom === null` (never by `profileId`), with
 * a digest cross-check as defense-in-depth against a future loader change.
 */

import { loadProfile } from "./load.js";
import { collectEntityPages, collectEntitySummary } from "./collect.js";
import { DEFAULT_PROFILE } from "./default.js";
import { profileDigest } from "./digest.js";
import type { EntityPage, LoadedProfile } from "./types.js";

/**
 * Load the active profile and return it ONLY when it is a non-default profile;
 * return `undefined` for the built-in default so every additive read surface
 * can omit its `profile` key with one shared gate.
 *
 * The built-in is identified by `loadedFrom === null` (the loader sets null
 * ONLY for the no-file/default path) — never by `profileId === "default"`,
 * which a disk profile can no longer claim but which must not be the gate. The
 * digest comparison is defense-in-depth against a future loader change.
 *
 * @param root - Absolute project root directory.
 * @returns The loaded non-default profile, or `undefined` for the built-in default.
 */
export async function loadNonDefaultProfile(
  root: string,
): Promise<LoadedProfile | undefined> {
  const loaded = await loadProfile(root);
  const isBuiltInDefault =
    loaded.loadedFrom === null && loaded.digest === profileDigest(DEFAULT_PROFILE);
  return isBuiltInDefault ? undefined : loaded;
}

/** The additive profile summary shared by the status and viewer surfaces. */
export interface ProfileSummaryBlock {
  profileId: string;
  digest: string;
  entityCounts: Record<string, number>;
  /**
   * Human-readable collector problems. Present ONLY when non-empty, so a
   * non-default project with a bad directory or page is never reported as
   * silently healthy.
   */
  problems?: string[];
}

/**
 * Collect a loaded non-default profile's entity pages alongside its problems
 * already flattened to human-readable messages — the shared read-side step
 * every additive profile block performs before shaping its own envelope.
 *
 * @param root - Absolute project root directory.
 * @param loaded - A non-default profile (from {@link loadNonDefaultProfile}).
 * @returns The collected entity pages and the flattened problem messages.
 */
export async function collectEntityPagesWithMessages(
  root: string,
  loaded: LoadedProfile,
): Promise<{ pages: EntityPage[]; messages: string[] }> {
  const { pages, problems } = await collectEntityPages(root, loaded.profile);
  return { pages, messages: problems.map((p) => p.message) };
}

/**
 * Resolve the active profile and, for a NON-DEFAULT profile only, build the
 * shared summary block (profileId, digest, per-type entity counts, problems).
 *
 * Uses the COUNT-ONLY {@link collectEntitySummary} so the status/viewer surfaces
 * never build or retain content `EntityPage`s (with bodies) just to tally — the
 * counts and problem messages are identical to the content path, which shares
 * the same per-scan validation.
 *
 * @param root - Absolute project root directory.
 * @returns The summary block for a non-default profile, or `undefined` for the
 *   built-in default so the caller omits the `profile` key entirely.
 */
export async function collectProfileSummary(
  root: string,
): Promise<ProfileSummaryBlock | undefined> {
  const loaded = await loadNonDefaultProfile(root);
  if (loaded === undefined) return undefined;
  const { counts, problems } = await collectEntitySummary(root, loaded.profile);
  const messages = problems.map((p) => p.message);
  return {
    profileId: loaded.profile.profileId,
    digest: loaded.digest,
    entityCounts: counts,
    ...(messages.length > 0 ? { problems: messages } : {}),
  };
}
