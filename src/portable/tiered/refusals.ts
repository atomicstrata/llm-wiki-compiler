/**
 * @file src/portable/tiered/refusals.ts
 * @description The refusal reply of the search-tier protocol. Pure: a client
 * and a host build the same reply from it, and it imports no implementation.
 */

import { ACCESS_NOTICE } from "../contracts.js";
import { TIERS_CAPABILITY, type TiersRefusalCodeV2, type TiersRefusedV2 } from "./contracts.js";

/** A refusal from the tier union. */
export function tiersRefused(code: TiersRefusalCodeV2): TiersRefusedV2 {
  return code === "capability_unsupported"
    ? { kind: "refused", code, capability: TIERS_CAPABILITY, notice: ACCESS_NOTICE }
    : { kind: "refused", code, notice: ACCESS_NOTICE };
}
