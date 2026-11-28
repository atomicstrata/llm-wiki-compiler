/**
 * @file src/scale/eligibility.ts
 * @description Whether a project may use `local-indexed`, checked under the
 * project lock before any indexed preparation effect.
 *
 * Two facts make it ineligible, whatever the estimate:
 * - a custom profile that cannot be LOADED (fail closed). A loadable custom
 *   profile is eligible: its entity pages are catalogued by the typed entity
 *   catalog, a version 3 capability recorded before any preparation effect
 *   ({@link diskScaleCapabilities});
 * - a project carrying the PORTABLE directory (registered or adopted for the
 *   portable publication path): its receipts, labels and custody are never
 *   routed through derived stores.
 *
 * The result is recorded as an unavailable estimate, never silently ignored.
 */

import { hasPortableDirectory } from "../portable/host/pending-gate.js";
import { loadNonDefaultProfile } from "../profile/block.js";
import type { CapabilityNameV3, IneligibleReason } from "./contracts-v2.js";

/** The eligibility blocks of the project at `root`, in policy order. */
export async function diskScaleEligibility(root: string): Promise<IneligibleReason[]> {
  const blocks: IneligibleReason[] = [];
  const profile = await loadNonDefaultProfile(root).catch(() => "unloadable" as const);
  if (profile === "unloadable") blocks.push("profile-entity-catalog");
  if (await hasPortableDirectory(root)) blocks.push("registered-portable-indexed-publication");
  return blocks;
}

/**
 * The version 3 capabilities an indexed layout of the project at `root`
 * needs: a LOADABLE custom profile needs the typed entity catalog. Recorded
 * `preparing` in the record that plans the preparation, before any effect.
 */
export async function diskScaleCapabilities(root: string): Promise<CapabilityNameV3[]> {
  const profile = await loadNonDefaultProfile(root).catch(() => undefined);
  return profile === undefined ? [] : ["typed-entity-catalog-1"];
}
