/**
 * @file src/catalog/typed-admission.ts
 * @description Whether the typed entity catalog may be written or served for
 * a project: its scale record must carry the version 3 capability
 * `typed-entity-catalog-1`. Older builds cannot read such a record, so they
 * refuse before any effect; this build refuses to write typed rows into a
 * project whose record does not name the capability, and serves them only
 * once the capability is `ready` (the activation that verified them).
 */

import { capabilityStatus } from "../scale/capability-status.js";

/** The capability's status for the project at `root`: absent, `preparing` or `ready`. */
export function typedCatalogStatus(root: string): Promise<"absent" | "preparing" | "ready"> {
  return capabilityStatus(root, "typed-entity-catalog-1");
}
