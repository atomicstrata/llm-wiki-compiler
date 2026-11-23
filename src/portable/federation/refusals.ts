/**
 * @file src/portable/federation/refusals.ts
 * @description The one way a federation answer refuses (slice S6): a closed
 * code and the constant notice. A refusal never names a shard, a project, a
 * member or a reason; the true reason, where there is one, goes to the
 * host's audit sink only.
 */

import { ACCESS_NOTICE } from "../contracts.js";
import { FEDERATION_CAPABILITY, type FederationRefusalCodeV2, type FederationRefusedV2, type NotVisibleV2 } from "./contracts.js";

/** A refusal of the federation protocol. */
export function federationRefused(code: FederationRefusalCodeV2): FederationRefusedV2 {
  return code === "capability_unsupported"
    ? { kind: "refused", code, capability: FEDERATION_CAPABILITY, notice: ACCESS_NOTICE }
    : { kind: "refused", code, notice: ACCESS_NOTICE };
}

/**
 * An answer whose final authority check is still to run. `finalize` is
 * SYNCHRONOUS: it compares every served session's stamp and builds the answer
 * with no await, and the route calls it immediately before the synchronous
 * JSON write, so nothing can yield between the last check and serialization.
 */
interface Served<T = unknown> { finalize(): T }

/** An answer with nothing left to check: a write's own recorded outcome, or a refusal. */
function served<T>(value: T): Served<T> {
  return { finalize: () => value };
}
