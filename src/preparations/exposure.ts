/**
 * @file src/preparations/exposure.ts
 * @description Per-phase exposure derivation for a provider phase (design section
 * 11.2, Provider V2 CP-INV-26). Given an ordered Provider V2 input snapshot, it
 * derives the provider-visible exposure set (through the shared
 * {@link snapshotProviderExposure} primitive) and a preparation exposure digest
 * that additionally binds each input's sensitivity and allowed egress
 * destinations, so adding, removing, replacing, or reordering an input drifts the
 * provider digest, and changing a destination drifts the preparation digest even
 * when the provider set is unchanged.
 *
 * SCOPE (Task 3 boundary, D10): this is a building block for the Task 4
 * durable-attempt `confirm-input-exposure` gate. It is NOT part of ephemeral
 * read, which is gate-free (a confirm-input-exposure gate disqualifies a plan
 * from ephemeral-read-shape eligibility) and — like every Provider V2 invocation
 * Task 4 drives — independently re-materializes provider inputs with fresh
 * invocation-scoped tokens, so exposure derived here is NOT automatically the
 * eventual invocation's snapshot. Binding the SAME snapshot the invocation consumes into the gate, and
 * enforcing sensitivity and allowed destinations there, is Task 4's
 * responsibility (see the decision log). The digest equality this module
 * demonstrates holds only WITHIN one materialized snapshot.
 */

import { canonicalDigest } from "../profile/templates/signing/canonical.js";
import { snapshotProviderExposure } from "../capability-providers/authority/exposure.js";
import { parseSha256Digest } from "../capability-providers/ids.js";
import type { ProviderInputExposureSetV1, ProviderInputRefV1 } from "../capability-providers/authority/types.js";
import type { EvidenceSensitivity, Sha256Digest } from "./types.js";

const PHASE_EXPOSURE_DOMAIN = "llmwiki-preparation-phase-exposure-v1";

/**
 * One materialized provider input plus the sensitivity and exact egress
 * destinations it may be disclosed to. The `providerInput` is the exact ordered
 * reference produced by Provider V2 input materialization, so its
 * `materializedToken` is the real invocation-scoped token — never a plan-time
 * input ID.
 */
export interface PhaseExposureEntryV1 {
  providerInput: ProviderInputRefV1;
  sensitivity: EvidenceSensitivity;
  allowedDestinations: readonly string[];
}

/** Host display row: the exact fields a gate or invocation surface enumerates. */
export interface PhaseExposureRowV1 {
  inputId: string;
  provenanceLabel: string;
  digest: Sha256Digest;
  byteCount: number;
  sensitivity: EvidenceSensitivity;
  allowedDestinations: readonly string[];
}

/** The ordered provider exposure set, its binding digest, and the host display. */
export interface PreparationPhaseExposureV1 {
  providerExposure: ProviderInputExposureSetV1;
  exposureDigest: Sha256Digest;
  display: readonly PhaseExposureRowV1[];
}

/** Build the host display row enumerating identity, digest, sensitivity, egress. */
function toDisplayRow(entry: PhaseExposureEntryV1): PhaseExposureRowV1 {
  return {
    inputId: entry.providerInput.inputId, provenanceLabel: entry.providerInput.provenanceLabel,
    digest: entry.providerInput.digest, byteCount: entry.providerInput.byteCount,
    sensitivity: entry.sensitivity, allowedDestinations: [...entry.allowedDestinations],
  };
}

/**
 * Derive the ordered provider exposure set for one provider phase from a
 * materialized Provider V2 input snapshot, then bind sensitivity and allowed
 * egress destinations into the preparation exposure digest.
 * `providerExposure.inputExposureSetDigest` equals the input-set digest of the
 * SUPPLIED snapshot; making that snapshot the one the eventual invocation
 * resolves its grant against is the Task 4 gate's responsibility (see the module
 * header), not something this pure derivation can guarantee on its own.
 */
export function deriveProviderPhaseExposure(entries: readonly PhaseExposureEntryV1[]): PreparationPhaseExposureV1 {
  const providerExposure = snapshotProviderExposure(entries.map((entry) => entry.providerInput));
  const display = entries.map(toDisplayRow);
  const exposureDigest = parseSha256Digest(canonicalDigest({
    domain: PHASE_EXPOSURE_DOMAIN,
    providerExposureSetDigest: providerExposure.inputExposureSetDigest,
    egress: display.map((row) => ({
      inputId: row.inputId, sensitivity: row.sensitivity, allowedDestinations: row.allowedDestinations,
    })),
  }));
  return { providerExposure, exposureDigest, display };
}
