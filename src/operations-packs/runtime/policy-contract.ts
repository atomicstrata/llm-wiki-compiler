/**
 * @file src/operations-packs/runtime/policy-contract.ts
 * @description The registered policy contract a compiled pack action's handoff
 * compiles under (design section 20). It is the closed vocabulary every host
 * authority module reads: selection exclusions, reconciliation reasons, and
 * proposal kinds are checked against THIS contract, never against a caller
 * predicate, and the contract identity is the REGISTERED terminal host-handler
 * family's — the same `intent-compile` contract the plan pins and the
 * materializer declares.
 *
 * THE VOCABULARIES ARE DERIVED, NOT AUTHORED. Both reason-code lists are the keys
 * of a record the compiler proves TOTAL over the closed family types — the eleven
 * {@link PackExclusionV1} reasons the six families can emit, and the nine
 * {@link PackReconcileFindingClassV1} classes the reconcile family can report. A
 * member added to either union stops this file compiling instead of quietly
 * shipping a vocabulary that omits it, which is the drift a hand-written list
 * beside a derivable one always eventually has.
 *
 * THE PROPOSAL KIND IS THE PACK'S OWN TARGET PROFILE CLASS, read off the compiled
 * materialization spec. It is a recipe-validated slug, which is exactly the
 * proposal-kind grammar, and a pack that declared a Milestone A mutation kind
 * there fails closed in `assertCapturedPolicyContract` rather than smuggling
 * executable authority into a Spec 3 data vocabulary (design section 21.1).
 *
 * IT RETURNS A CAPTURED CONTRACT. The record is built through
 * {@link assertCapturedPolicyContract}, so what this module hands the runner is
 * the same normalized value a membership test will later enforce against — never
 * a shape that records one vocabulary and enforces another.
 */

import {
  assertCapturedPolicyContract, type PreparationPolicyContractV1,
} from "../../preparations/selection.js";
import { HOST_HANDLER_FAMILY_BY_PHASE_KIND, type CompiledPackActionV1 } from "../compiler-types.js";
import { hostHandlerRefFor } from "../handlers/registry.js";
import type { PackExclusionV1, PackReconcileFindingClassV1 } from "../handlers/types.js";

/**
 * The exclusion reasons a selecting family may emit, TOTAL over the closed union
 * by construction: `satisfies Record<…, true>` rejects both a missing member and
 * an invented one, and the vocabulary is the record's keys.
 */
const PACK_EXCLUSION_REASON_CODES: readonly string[] = Object.keys({
  "ineligible-class": true, "ineligible-tier": true, "over-item-budget": true,
  "over-byte-budget": true, "over-token-budget": true, "duplicate-identity": true,
  "filtered-out": true, "invalid-value": true, "not-in-secondary": true,
  "in-secondary": true, "over-top-n": true,
} satisfies Record<PackExclusionV1["reason"], true>);

/** The nine reconcile finding classes, total over the closed union the same way. */
const PACK_RECONCILIATION_REASON_CODES: readonly string[] = Object.keys({
  absent: true, identical: true, "compatible-update": true, conflicting: true,
  "duplicate-identity": true, "supersession-candidate": true, "stale-precondition": true,
  "unavailable-authority": true, "unsupported-mutation": true,
} satisfies Record<PackReconcileFindingClassV1, true>);

/**
 * Build the registered policy contract for one compiled pack action.
 *
 * @param action - The compiled action whose terminal intent family and target
 *   profile class the contract is derived from.
 * @returns The captured, normalized contract the runner and the intent compiler
 *   enforce every selection, reconciliation, and proposal against.
 */
export function packPolicyContractFor(action: CompiledPackActionV1): PreparationPolicyContractV1 {
  const ref = hostHandlerRefFor(HOST_HANDLER_FAMILY_BY_PHASE_KIND.intent);
  return assertCapturedPolicyContract({
    handlerId: ref.handlerId,
    handlerContractVersion: ref.handlerContractVersion,
    handlerContractDigest: ref.handlerContractDigest,
    exclusionReasonCodes: PACK_EXCLUSION_REASON_CODES,
    reconciliationReasonCodes: PACK_RECONCILIATION_REASON_CODES,
    proposalKinds: [...action.materializationSpec.targetProfileClasses],
  });
}
