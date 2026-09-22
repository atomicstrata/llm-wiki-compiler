/**
 * @file src/preparations/service-gate-authority.ts
 * @description Assembling the AUTHORITATIVE state one gate decision is bound to
 * — the read half of the `gate` operation (design v10 §5 row 5).
 *
 * EVERY FIELD IS HOST-LOADED. `authorGateProof` recomputes each bound digest
 * from the state handed to it, so whatever this module resolves is what the proof
 * binds. That makes this the place a caller-presented fact would become durable
 * authority, and it is why nothing here reads the request: the caller names a
 * gate id, and the gate KIND — which selects the required grant — is read from
 * the run's own authenticated manifest. A caller that could present the kind
 * could pick the cheaper of three grants for a gate the plan declared as the
 * dearer one.
 *
 * THE MANIFEST IS MATCHED TO THE BINDING, never merely read. The run's binding
 * carries the manifest digest it was staged against; a manifest whose digest no
 * longer equals it is a DIFFERENT plan, and binding a proof to it would record an
 * approval of bytes this run never agreed to. This is the same match
 * `resolveAuthenticatedEffectContext` makes before it starts an effect.
 *
 * EVERY LEG SAYS WHICH KIND OF ANSWER IT IS. A gate the plan never declared is a
 * does-not-qualify; a phase whose upstream output has not been produced yet is a
 * could-not-derive. Collapsing them told an operator their plan was wrong when
 * the truth was that the run had not got there yet.
 */

import { preparationManifestDigest } from "./manifest-parse.js";
import { readPreparationManifest } from "./manifest-store.js";
import type {
  NormalizedPhaseV1, NormalizedPreparationPlanV1, PhaseGateContractV1,
} from "./plan-types.js";
import type { PreparationRunBinding, PreparationRunV1 } from "./run-types.js";
import type { EvidenceRefV1 } from "./types.js";
import type { GateAuthorityState } from "./gates.js";

/** The resolved authoritative state for one gate decision, or why there is none. */
export type GateAuthorityLookupV1 =
  | { readonly ok: false; readonly reason: string }
  | {
    readonly ok: true;
    readonly authoritative: GateAuthorityState;
    readonly gate: PhaseGateContractV1;
  };

/** One resolved current input, or the honest reason it could not be named. */
type CurrentInputLookup =
  | { readonly ok: false; readonly reason: string }
  | { readonly ok: true; readonly input: EvidenceRefV1 };

/** One plan phase paired with the gate contract it declares. */
interface GatedPhase {
  readonly phase: NormalizedPhaseV1;
  readonly gate: PhaseGateContractV1;
}

/**
 * The plan phase declaring this gate id, paired with its contract.
 *
 * Returns the PAIR rather than the phase so every consumer reads the same
 * already-narrowed contract. Handing back the phase alone forces each caller to
 * re-narrow `phase.gate`, and a caller that asserts instead of narrowing is one
 * plan-shape change away from reading `undefined` as a gate.
 */
function phaseDeclaringGate(
  plan: NormalizedPreparationPlanV1, gateId: string,
): GatedPhase | undefined {
  for (const phase of plan.phases) {
    if (phase.gate !== undefined && phase.gate.gateId === gateId) return { phase, gate: phase.gate };
  }
  return undefined;
}

/**
 * Name the ONE evidence set this gate's phase currently reads.
 *
 * A phase bound only to the plan's declared initial input has exactly one, and it
 * is the plan's own. A phase reading an upstream phase's output has one only once
 * that phase has produced it, and only if the run still carries the matching
 * evidence ref — both are could-not-derive answers rather than refusals of the
 * gate itself. A phase reading MORE than one upstream output has no single
 * current input at all: `GateAuthorityState` binds one, and picking one of
 * several would bind the proof to an input the operator did not see.
 */
function resolveCurrentInput(
  plan: NormalizedPreparationPlanV1, phase: NormalizedPhaseV1, run: PreparationRunV1,
): CurrentInputLookup {
  const upstream = phase.inputBindings.filter((binding) => binding.sourceKind === "phase-output");
  if (upstream.length === 0) return { ok: true, input: plan.initialInputSet };
  if (upstream.length > 1) {
    return { ok: false, reason: "this gate's phase reads more than one upstream output, so no single current input can be bound" };
  }
  const sourcePhaseId = upstream[0]!.sourcePhaseId;
  const produced = run.phaseSummaries.filter((summary) => summary.logicalPhaseId === sourcePhaseId);
  if (produced.length > 1) {
    // A fanned-out source has one summary per instance; binding the gate to the
    // first would cover only one item, not the aggregate the operator reviews.
    return { ok: false, reason: "this gate reads a fanned-out phase, which has no single authoritative output to bind" };
  }
  if (produced[0]?.outputEvidenceDigest === undefined) {
    return { ok: false, reason: "the phase this gate reads from has produced no durable output evidence yet" };
  }
  const ref = run.evidenceRefs.find((candidate) => candidate.digest === produced[0]!.outputEvidenceDigest);
  return ref === undefined
    ? { ok: false, reason: "the run records no evidence reference for that phase's output digest" }
    : { ok: true, input: ref };
}

/** Assemble the authoritative state once the bound plan and its phase are known. */
function bindAuthority(
  run: PreparationRunV1, plan: NormalizedPreparationPlanV1, gated: GatedPhase,
): GateAuthorityLookupV1 {
  const { phase, gate } = gated;
  const instance = run.phaseSummaries.find((summary) => summary.logicalPhaseId === phase.logicalPhaseId);
  if (instance === undefined) {
    return { ok: false, reason: "no phase instance of this gate's phase exists on the run yet" };
  }
  const input = resolveCurrentInput(plan, phase, run);
  if (!input.ok) return input;
  return {
    ok: true,
    gate,
    authoritative: {
      runId: run.runId, plan, gate, phaseInstanceId: instance.phaseInstanceId,
      currentInput: input.input,
      ...(phase.effectPlanDigest === undefined ? {} : { currentEffectPlanDigest: phase.effectPlanDigest }),
    },
  };
}

/**
 * Resolve everything one gate decision binds, from authenticated state alone.
 *
 * @param root - The project root this invocation acts within.
 * @param binding - The run's authenticated binding, including its manifest digest.
 * @param run - The authenticated run the decision is recorded on.
 * @param gateId - The gate the caller named.
 * @returns The bound authority, or the honest reason it could not be assembled.
 */
export async function resolveGateAuthority(
  root: string, binding: PreparationRunBinding, run: PreparationRunV1, gateId: string,
): Promise<GateAuthorityLookupV1> {
  const read = await readPreparationManifest(root, binding.workspaceId, binding.preparationId);
  if (read.status !== "ok") return { ok: false, reason: `the run's manifest is ${read.status}` };
  if (preparationManifestDigest(read.manifest) !== binding.manifestDigest) {
    return { ok: false, reason: "the run's manifest digest changed; this is no longer the plan the run was staged against" };
  }
  const gated = phaseDeclaringGate(read.manifest.plan, gateId);
  return gated === undefined
    ? { ok: false, reason: `this run's plan declares no gate named "${gateId}"` }
    : bindAuthority(run, read.manifest.plan, gated);
}
