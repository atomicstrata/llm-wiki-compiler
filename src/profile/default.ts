/**
 * The built-in default profile pack.
 *
 * Models the classic two-directory llmwiki layout — `concepts` under
 * wiki/concepts and `queries` under wiki/queries — as a profile pack so the
 * profile-aware pipeline has a baseline to fall back to when no custom
 * `.llmwiki/profile.json` is present. The default pipeline keeps raw
 * filesystem stems and does not mint EntityIds (see types.ts).
 */

import { CONCEPTS_DIR, QUERIES_DIR } from "../utils/constants.js";
import type { ProfilePack } from "./types.js";

/** The built-in default profile: concepts + queries at their canonical dirs. */
export const DEFAULT_PROFILE: ProfilePack = {
  schemaVersion: 1,
  profileId: "default",
  displayName: "Default",
  entities: {
    concepts: { directory: CONCEPTS_DIR },
    queries: { directory: QUERIES_DIR },
  },
};

/** True when the given profile is the built-in default profile. */
export function isDefaultProfile(p: ProfilePack): boolean {
  return p.profileId === "default";
}
