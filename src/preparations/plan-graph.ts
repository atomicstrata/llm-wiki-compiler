/**
 * @file src/preparations/plan-graph.ts
 * @description Closed phase-graph validation for a normalized preparation plan
 * (design section 10.4). It rejects unknown, self, and cyclic dependencies,
 * work that cannot reach a declared output, map sources not dominated by their
 * producer, ephemeral plans carrying durable-only constructs, atomicity-class
 * inconsistencies, and required work resting only on optional predecessors. It
 * also derives the deterministic topological rank consumed by the scheduler.
 */

import { assertPreparationId, type PreparationId } from "./ids.js";
import { PreparationPlanError } from "./problems.js";
import type {
  NormalizedPhaseV1, NormalizedPreparationPlanV1, PreparationAtomicityClass,
} from "./plan-types.js";

/** The deterministic per-phase topological rank used to order ready instances. */
export interface PreparationPhaseGraph {
  topologicalRankByPhaseId: ReadonlyMap<string, number>;
}

/** Validate the complete plan graph and return the deterministic phase ranks. */
export function validatePreparationPlanGraph(plan: NormalizedPreparationPlanV1): PreparationPhaseGraph {
  const byId = indexPhases(plan.phases);
  validateDependencyEdges(plan.phases, byId);
  const ranks = topologicalRanks(plan.phases, byId);
  const ancestors = computeAncestors(plan.phases, byId);
  validateConnectivity(plan, byId, ancestors);
  validateBindings(plan.phases, ancestors);
  validateRequiredInputs(plan.phases, byId);
  validateEphemeralRestrictions(plan);
  validateAtomicity(plan);
  validateGateIdUniqueness(plan.phases);
  return { topologicalRankByPhaseId: ranks };
}

/**
 * Reject duplicate gate IDs across the plan. A gate proof is looked up by gate ID,
 * so two gates sharing an ID would let one gate's approval satisfy another; the
 * gate ID must be a unique key.
 */
function validateGateIdUniqueness(phases: readonly NormalizedPhaseV1[]): void {
  const seen = new Set<string>();
  for (const phase of phases) {
    const gateId = phase.gate?.gateId;
    if (gateId === undefined) continue;
    if (seen.has(gateId)) throw new PreparationPlanError(`duplicate gate id ${gateId}`);
    seen.add(gateId);
  }
}

/** Build the unique logical-phase index used by every later graph pass. */
function indexPhases(phases: readonly NormalizedPhaseV1[]): Map<string, NormalizedPhaseV1> {
  const byId = new Map<string, NormalizedPhaseV1>();
  for (const phase of phases) byId.set(phase.logicalPhaseId, phase);
  return byId;
}

/** Reject unknown and self dependencies before any traversal. */
function validateDependencyEdges(phases: readonly NormalizedPhaseV1[], byId: Map<string, NormalizedPhaseV1>): void {
  for (const phase of phases) {
    for (const dependency of phase.dependsOn) {
      if (dependency === phase.logicalPhaseId) throw new PreparationPlanError(`phase ${phase.logicalPhaseId} depends on itself`);
      if (!byId.has(dependency)) throw new PreparationPlanError(`phase ${phase.logicalPhaseId} depends on unknown ${dependency}`);
    }
  }
}

/** Derive deterministic longest-path ranks and reject any dependency cycle. */
function topologicalRanks(phases: readonly NormalizedPhaseV1[], byId: Map<string, NormalizedPhaseV1>): Map<string, number> {
  const ranks = new Map<string, number>();
  const visiting = new Set<string>();
  const rankOf = (id: string): number => {
    const cached = ranks.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) throw new PreparationPlanError("phase graph contains a cycle");
    visiting.add(id);
    const dependencies = byId.get(id)!.dependsOn;
    const rank = dependencies.length === 0 ? 0 : 1 + Math.max(...dependencies.map(rankOf));
    visiting.delete(id);
    ranks.set(id, rank);
    return rank;
  };
  for (const phase of phases) rankOf(phase.logicalPhaseId);
  return ranks;
}

/** Compute the transitive dependency (ancestor) set for every phase. */
function computeAncestors(phases: readonly NormalizedPhaseV1[], byId: Map<string, NormalizedPhaseV1>): Map<string, Set<string>> {
  const ancestors = new Map<string, Set<string>>();
  const resolve = (id: string): Set<string> => {
    const cached = ancestors.get(id);
    if (cached !== undefined) return cached;
    const set = new Set<string>();
    ancestors.set(id, set);
    for (const dependency of byId.get(id)!.dependsOn) {
      set.add(dependency);
      for (const inherited of resolve(dependency)) set.add(inherited);
    }
    return set;
  };
  for (const phase of phases) resolve(phase.logicalPhaseId);
  return ancestors;
}

/** Reject a declared output producer that is unknown or unreachable work. */
function validateConnectivity(
  plan: NormalizedPreparationPlanV1,
  byId: Map<string, NormalizedPhaseV1>,
  ancestors: Map<string, Set<string>>,
): void {
  const contributing = new Set<string>();
  for (const producer of plan.outputContract.producingPhaseIds) {
    if (!byId.has(producer)) throw new PreparationPlanError(`outputContract producer ${producer} is unknown`);
    contributing.add(producer);
    for (const ancestor of ancestors.get(producer)!) contributing.add(ancestor);
  }
  for (const phase of plan.phases) {
    if (!contributing.has(phase.logicalPhaseId)) {
      throw new PreparationPlanError(`phase ${phase.logicalPhaseId} cannot contribute to a declared output`);
    }
  }
}

/** Reject map sources and phase-output bindings not dominated by a producer. */
function validateBindings(phases: readonly NormalizedPhaseV1[], ancestors: Map<string, Set<string>>): void {
  for (const phase of phases) {
    const owned = ancestors.get(phase.logicalPhaseId)!;
    for (const binding of phase.inputBindings) {
      if (binding.sourceKind === "phase-output" && !owned.has(binding.sourcePhaseId!)) {
        throw new PreparationPlanError(`phase ${phase.logicalPhaseId} binds output of non-ancestor ${binding.sourcePhaseId}`);
      }
    }
    if (phase.expansion.kind === "map") validateMapSource(phase, owned);
  }
}

/** Require a map source binding to resolve to a dominating phase-output producer. */
function validateMapSource(phase: NormalizedPhaseV1, ancestors: Set<string>): void {
  if (phase.expansion.kind !== "map") return;
  const source = phase.expansion.sourceEvidenceBinding;
  const binding = phase.inputBindings.find((item) => item.bindingId === source);
  if (binding === undefined || binding.sourceKind !== "phase-output" || !ancestors.has(binding.sourcePhaseId!)) {
    throw new PreparationPlanError(`phase ${phase.logicalPhaseId} map source is not dominated by its producer`);
  }
}

/** Reject required work whose only inputs are optional predecessors. */
function validateRequiredInputs(phases: readonly NormalizedPhaseV1[], byId: Map<string, NormalizedPhaseV1>): void {
  for (const phase of phases) {
    if (phase.disposition !== "required" || phase.dependsOn.length === 0) continue;
    const bindsInitialInput = phase.inputBindings.some((binding) => binding.sourceKind === "initial-input");
    const hasRequiredPredecessor = phase.dependsOn.some((id) => byId.get(id)!.disposition === "required");
    if (!bindsInitialInput && !hasRequiredPredecessor) {
      throw new PreparationPlanError(`required phase ${phase.logicalPhaseId} depends only on optional predecessors`);
    }
  }
}

/** Reject an ephemeral plan carrying any durable-only construct (section 10.4). */
function validateEphemeralRestrictions(plan: NormalizedPreparationPlanV1): void {
  if (plan.executionMode !== "ephemeral-read") return;
  if (plan.outputContract.handoffCapacity !== undefined) throw new PreparationPlanError("ephemeral plan cannot declare a handoff");
  if (plan.initialInputSet.retention !== "terminal-only") {
    throw new PreparationPlanError("ephemeral plan cannot declare durable retention");
  }
  for (const phase of plan.phases) assertEphemeralPhase(phase);
}

/**
 * True when one phase can produce a MUTATING external effect.
 *
 * The DISJUNCTION is the whole point. A declared `effectPlanDigest` authorizes an
 * effect and a nonzero `maximumEffectsPerAttempt` budgets one, and a phase
 * carrying EITHER can mutate; a plan that budgets effects without declaring a
 * digest is loader-admissible and is not effect-free. Reading only the digest
 * calls such a phase safe, which is how a run whose executor refused to prove
 * effect-freeness could still be claimed cleanly cancelled.
 *
 * EXPORTED so every caller asking "can this mutate" reads ONE predicate. The
 * cancellation settlement's effect-freeness proof, this loader's ephemeral
 * refusal, and the runtime ephemeral-eligibility gate must agree by
 * construction, not by three copies happening to match. The eligibility gate
 * matters most: an ephemeral read takes its plan from the CALLER and never
 * re-runs the loader over it, so for that path its copy is the whole gate —
 * broadening this predicate while leaving it behind would tighten the loader and
 * quietly leave the caller-supplied path on the old, weaker rule.
 *
 * Two sibling checks in `ephemeral-seal.ts` deliberately do NOT read it. The
 * per-phase refusal there tests `effectPlanDigest` alone as a weaker re-check
 * sitting strictly BEHIND this one (eligibility already refused the budget
 * case), and the authority binding tests the RESOLVED extras rather than a plan
 * phase — a different object, where the budget has no meaning.
 */
export function phaseDeclaresMutatingEffect(phase: NormalizedPhaseV1): boolean {
  return phase.effectPlanDigest !== undefined || phase.bounds.maximumEffectsPerAttempt > 0;
}

/**
 * Reject one phase that carries a durable-only construct in an ephemeral plan.
 * A read-only brokered call (an HTTPS or model fetch that mutates nothing) is
 * permitted in an ephemeral read (design 7.1: "every phase and broker operation
 * is read-only; no phase requests a mutating external effect"); only a durable
 * mutating EFFECT — a declared effect plan or a nonzero per-attempt effect
 * budget — is durable-only. This matches the runtime ephemeral eligibility gate,
 * so plan compilation and execution agree on what is ephemeral-eligible.
 */
function assertEphemeralPhase(phase: NormalizedPhaseV1): void {
  if (phase.role === "gate" || phase.gate !== undefined) throw new PreparationPlanError("ephemeral plan cannot contain a gate");
  if (phase.expansion.kind === "bounded-repeat") throw new PreparationPlanError("ephemeral plan cannot repeat");
  if (phaseDeclaresMutatingEffect(phase)) {
    throw new PreparationPlanError("ephemeral plan cannot declare a mutating effect");
  }
  if (phase.bounds.maximumCheckpointBytes > 0) throw new PreparationPlanError("ephemeral plan cannot checkpoint");
}

/** The mutating-effect, local-bundle, and residual-gate signals of one plan. */
interface AtomicitySignals { hasEffect: boolean; hasHandoff: boolean; hasResidualGate: boolean }

/**
 * Read the atomicity-relevant signals from a durable plan.
 *
 * `hasEffect` deliberately reads `effectPlanDigest` ALONE and does not use
 * {@link phaseDeclaresMutatingEffect}, because the atomicity class is a claim
 * about what the plan DECLARES, not about what it could physically do. A phase
 * that budgets effects without declaring an effect plan has nothing for
 * `external-effect-only` or `non-atomic-external-before-local` to describe — no
 * effect plan to gate, no compensation topology to name — so folding the budget
 * in here would reclassify a `local-bundle-only` plan as one that owes a residual
 * gate it has no effect to gate. The safety questions ("can this mutate") and the
 * declaration questions ("what did this plan say it does") are different, and the
 * shared predicate answers only the first.
 */
function atomicitySignals(plan: NormalizedPreparationPlanV1): AtomicitySignals {
  return {
    hasEffect: plan.phases.some((phase) => phase.effectPlanDigest !== undefined),
    hasHandoff: plan.outputContract.handoffCapacity !== undefined,
    hasResidualGate: plan.phases.some((phase) => phase.gate?.gateKind === "confirm-residual-risk"),
  };
}

/** Return the violation message for one atomicity class, or undefined. */
function atomicityViolation(plan: NormalizedPreparationPlanV1, s: AtomicitySignals): string | undefined {
  const rules: Record<PreparationAtomicityClass, [boolean, string]> = {
    "local-bundle-only": [!s.hasEffect && s.hasHandoff,
      "local-bundle-only requires a local bundle output and no mutating external effect"],
    "external-effect-only": [s.hasEffect && !s.hasHandoff,
      "external-effect-only requires a mutating external effect and no local bundle"],
    "non-atomic-external-before-local": [s.hasEffect && s.hasHandoff && s.hasResidualGate,
      "non-atomic-external-before-local requires an effect, a local bundle, and a residual-risk gate"],
  };
  const [satisfied, message] = rules[plan.atomicityClass];
  return satisfied ? undefined : message;
}

/** Reject an atomicity class inconsistent with the plan's effects and handoff. */
function validateAtomicity(plan: NormalizedPreparationPlanV1): void {
  if (plan.executionMode !== "durable-preparation") return;
  const violation = atomicityViolation(plan, atomicitySignals(plan));
  if (violation !== undefined) throw new PreparationPlanError(violation);
}

/** Validate supersession SHAPE and reject a self-referential supersession edge. */
export function validatePlanSupersession(preparationId: string, supersedesPreparationId: string): PreparationId {
  const self = assertPreparationId(preparationId);
  const target = assertPreparationId(supersedesPreparationId);
  if (self === target) throw new PreparationPlanError("preparation cannot supersede itself");
  return target;
}
