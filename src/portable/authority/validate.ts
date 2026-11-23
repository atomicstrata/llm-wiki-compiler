/**
 * @file src/portable/authority/validate.ts
 * @description Re-validation of a proposal's apply dependencies.
 *
 * It runs under the gate when a proposal is persisted, when an approval is
 * recorded and when an apply is accepted. Every recorded object is re-observed,
 * every absent read is re-checked as still absent, every listing is
 * re-evaluated to its complete-list digest, and every target's pre-image is
 * checked. The comparison is by CONTENT, as the design defines for semantic
 * inputs: a file touched but byte-identical does not stale an apply. Any real
 * difference refuses, and nothing is written.
 */

import type { ApplyDependenciesV1 } from "../contracts.js";
import { completeListDigest } from "../compile/recording-access.js";
import { PortableRefusal } from "../errors.js";
import type { ProjectStore } from "../store/store.js";

/**
 * Check that every semantic input of a proposal is still what generation saw.
 *
 * @throws PortableRefusal `target_precondition_failed` for a target mismatch,
 *   `stale_read_set` for any other dependency.
 */
export async function validateDependencies(store: ProjectStore, dependencies: ApplyDependenciesV1): Promise<void> {
  for (const target of dependencies.targets) {
    const current = (await store.observe(target.path))?.digest ?? "absent";
    const expected = target.pre.state === "present" ? target.pre.digest : "absent";
    if (current !== expected) throw new PortableRefusal("target_precondition_failed", target.path);
  }
  for (const object of dependencies.objects) {
    const current = (await store.observe(object.path))?.digest ?? "absent";
    if (current !== object.digest) throw new PortableRefusal("stale_read_set", object.path);
  }
  // The prototype compile records no lineage-scoped listing, so there is no
  // lineage record to normalize out; every listing here is compared as observed.
  for (const listing of [...dependencies.listings, ...dependencies.lineageScopedListings]) {
    const current = await completeListDigest(store, listing.prefix);
    if (current.completeListDigest !== listing.completeListDigest) {
      throw new PortableRefusal("stale_read_set", listing.prefix);
    }
  }
}
