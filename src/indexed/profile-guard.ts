/**
 * @file src/indexed/profile-guard.ts
 * @description Refuse to change the effective profile of a `local-indexed`
 * project.
 *
 * The catalog does not index profile entity pages, so a non-default profile
 * would make indexed listings either hide those pages or scan them globally.
 * Every writer that installs, updates or activates a profile (profile init,
 * template install and update, product activation) calls this BEFORE its
 * write; on an indexed project it refuses with `scale-profile-ineligible`
 * and nothing is written. Any other project is unaffected (one `lstat`).
 */

import { ScaleGateError } from "../scale/gate.js";
import { indexedActive } from "./routing.js";

/** Throw `scale-profile-ineligible` when the project at `root` is `local-indexed`. */
export async function assertProfileChangeAllowed(root: string): Promise<void> {
  if (await indexedActive(root)) throw new ScaleGateError("scale-profile-ineligible");
}
