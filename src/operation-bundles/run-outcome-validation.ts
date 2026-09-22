/**
 * @file src/operation-bundles/run-outcome-validation.ts
 * @description Replays manifest-bound mutation, projection, and compensation
 * outcomes from the signed transition chain. Persisted outcome projections are
 * accepted only when their identities, metadata, terminal sequence, and
 * evidence exactly match that replay.
 */

import type {
  OperationRunContent, OperationRunTransition, ProjectionCriticality,
} from "./run-types.js";

type Replay = {
  status: string;
  transitionSequence: number;
  criticality?: ProjectionCriticality;
  mutationId?: string;
};
type ReplayMaps = Record<"mutations" | "compensations" | "projections", Map<string, Replay>>;

/** Replay strict absent-to-started-to-one-terminal outcome FSMs. */
export function validateOperationRunOutcomes(run: OperationRunContent): void {
  rejectDuplicates(run.mutationOutcomes.map((item) => item.mutationId), "duplicate mutation outcome");
  rejectDuplicates(run.compensationOutcomes.map((item) => item.compensationId), "duplicate compensation outcome");
  rejectDuplicates(run.projectionOutcomes.map((item) => item.mutationId), "duplicate projection outcome");
  const maps: ReplayMaps = { mutations: new Map(), compensations: new Map(), projections: new Map() };
  let compensationBegan = false;
  for (const transition of run.transitions) {
    replayTransition(run, transition, maps, compensationBegan);
    if (transition.type === "compensation-began") compensationBegan = true;
  }
  compareReplay(maps.mutations, run.mutationOutcomes, (item) => item.mutationId, "mutation");
  compareReplay(maps.compensations, run.compensationOutcomes, (item) => item.compensationId, "compensation");
  compareReplay(maps.projections, run.projectionOutcomes, (item) => item.mutationId, "projection");
}

/** Route one work payload into its manifest-bound outcome replay. */
function replayTransition(run: OperationRunContent, transition: OperationRunTransition, maps: ReplayMaps, compensationBegan: boolean): void {
  const forwardOutcome = transition.payload.kind === "mutation" || transition.payload.kind === "projection";
  if (compensationBegan && forwardOutcome) throw new Error("forward mutation or projection outcome is forbidden after compensation-began");
  if (transition.type === "compensation-began") assertCompensationEligibility(run, maps);
  switch (transition.payload.kind) {
    case "mutation": replayMutation(run, transition, maps); break;
    case "projection": replayProjection(run, transition, maps); break;
    case "compensation": replayCompensation(run, transition, maps); break;
  }
}

/** Replay one declared authoritative mutation outcome. */
function replayMutation(run: OperationRunContent, transition: OperationRunTransition, maps: ReplayMaps): void {
  const payload = transition.payload;
  if (payload.kind !== "mutation") return;
  if (!run.obligations.authoritativeMutationIds.includes(payload.mutationId)) throw new Error("foreign mutation outcome identity");
  if (transition.type === "mutation-started") assertAuthoritativeStartOrder(run, payload.mutationId, maps);
  updateReplay(maps.mutations, payload.mutationId, transition.type.slice("mutation-".length), transition, {});
}

/** Replay one declared projection outcome with immutable criticality. */
function replayProjection(run: OperationRunContent, transition: OperationRunTransition, maps: ReplayMaps): void {
  const payload = transition.payload;
  if (payload.kind !== "projection") return;
  const declared = run.obligations.projections.find((item) => item.mutationId === payload.mutationId);
  if (declared?.criticality !== payload.criticality) throw new Error("projection criticality differs from manifest obligation metadata");
  if (transition.type === "projection-failed" && payload.criticality !== "optional") {
    throw new Error("required projection cannot record projection-failed; failure is optional-only");
  }
  if (transition.type === "projection-started") assertProjectionStartOrder(run, payload.mutationId, maps);
  updateReplay(maps.projections, payload.mutationId, transition.type.slice("projection-".length), transition, { criticality: payload.criticality });
}

/** Admit the next authoritative mutation only after every predecessor settled. */
function assertAuthoritativeStartOrder(run: OperationRunContent, mutationId: OperationRunContent["obligations"]["authoritativeMutationIds"][number], maps: ReplayMaps): void {
  assertOneForwardIdentity(maps);
  const index = run.obligations.authoritativeMutationIds.indexOf(mutationId);
  const prior = run.obligations.authoritativeMutationIds.slice(0, index);
  if (prior.some((id) => !authoritativeSettled(maps.mutations.get(id)))) {
    throw new Error("authoritative mutation start violates declared order");
  }
}

/** Start projections only after authority and prior projections settled. */
function assertProjectionStartOrder(run: OperationRunContent, mutationId: OperationRunContent["obligations"]["projections"][number]["mutationId"], maps: ReplayMaps): void {
  assertOneForwardIdentity(maps);
  const authoritativeOpen = run.obligations.authoritativeMutationIds.some((id) => !authoritativeSettled(maps.mutations.get(id)));
  if (authoritativeOpen) throw new Error("authoritative obligations must settle before projection start");
  const index = run.obligations.projections.findIndex((item) => item.mutationId === mutationId);
  const priorOpen = run.obligations.projections.slice(0, index)
    .some((item) => !projectionSettled(maps.projections.get(item.mutationId), item.criticality));
  if (priorOpen) throw new Error("projection start violates declared projection order");
}

/** Prevent concurrent forward identities across both authoritative classes. */
function assertOneForwardIdentity(maps: ReplayMaps): void {
  const startedMutation = [...maps.mutations.values()].some((item) => item.status === "started");
  const startedProjection = [...maps.projections.values()].some((item) => item.status === "started");
  if (startedMutation || startedProjection) throw new Error("only one forward identity may be started at a time");
}

/** True only for authoritative outcomes that permit the next mutation. */
function authoritativeSettled(replay: Replay | undefined): boolean {
  return replay?.status === "applied" || replay?.status === "skipped-idempotent";
}

/** Allow optional projection failure while required failure remains blocking. */
function projectionSettled(replay: Replay | undefined, criticality: ProjectionCriticality): boolean {
  if (replay?.status === "applied" || replay?.status === "skipped-idempotent") return true;
  return replay?.status === "failed" && criticality === "optional";
}

/** Replay one declared compensation after its mutation is proved applied. */
function replayCompensation(run: OperationRunContent, transition: OperationRunTransition, maps: ReplayMaps): void {
  const payload = transition.payload;
  if (payload.kind !== "compensation") return;
  const declared = run.obligations.compensations.find((item) => item.compensationId === payload.compensationId);
  if (declared?.mutationId !== payload.mutationId) throw new Error("compensation metadata differs from manifest obligation");
  if (transition.type === "compensation-started" && maps.mutations.get(payload.mutationId)?.status !== "applied") {
    throw new Error("compensation-started requires a currently applied mutation");
  }
  if (transition.type === "compensation-started") assertCompensationOrder(run, payload.mutationId, maps);
  updateReplay(maps.compensations, payload.compensationId, transition.type.slice("compensation-".length), transition, { mutationId: payload.mutationId });
}

/** Require a declared compensator for every effect present at entry. */
function assertCompensationEligibility(run: OperationRunContent, maps: ReplayMaps): void {
  const failedCompensation = [...maps.compensations.values()].some((item) => item.status === "failed");
  if (failedCompensation) throw new Error("compensation-began cannot re-enter after a failed compensation");
  const startedMutation = [...maps.mutations.values()].some((item) => item.status === "started");
  if (startedMutation) throw new Error("compensation-began cannot cross a started authoritative mutation");
  const liveProjection = [...maps.projections.values()].some((item) => item.status === "started" || item.status === "applied");
  if (liveProjection) throw new Error("compensation-began cannot cross a started or applied projection");
  const missing = appliedMutationsInReverse(maps).some(([mutationId]) => compensationForMutation(run, mutationId) === undefined);
  if (missing) throw new Error("compensation-began requires every applied mutation to have a declared compensator");
}

/** Admit only the next unsettled effect in reverse application order. */
function assertCompensationOrder(run: OperationRunContent, mutationId: string, maps: ReplayMaps): void {
  const blocked = [...maps.compensations.values()].some((item) => item.status === "started" || item.status === "failed");
  if (blocked) throw new Error("prior compensation must be settled before another compensation-started");
  const expected = remainingAppliedMutations(run, maps)[0]?.[0];
  if (expected !== mutationId) throw new Error("compensation-started must follow reverse mutation-application order");
}

/** List applied effects newest-first by their durable terminal sequence. */
function appliedMutationsInReverse(maps: ReplayMaps): Array<[string, Replay]> {
  return [...maps.mutations.entries()]
    .filter((entry) => entry[1].status === "applied")
    .sort((left, right) => right[1].transitionSequence - left[1].transitionSequence);
}

/** Exclude compensations already durably completed before a resumed pass. */
function remainingAppliedMutations(run: OperationRunContent, maps: ReplayMaps): Array<[string, Replay]> {
  return appliedMutationsInReverse(maps).filter(([mutationId]) => {
    const declared = compensationForMutation(run, mutationId);
    return declared === undefined || maps.compensations.get(declared.compensationId)?.status !== "completed";
  });
}

/** Find the manifest-declared compensator for one authoritative mutation. */
function compensationForMutation(run: OperationRunContent, mutationId: string) {
  return run.obligations.compensations.find((item) => item.mutationId === mutationId);
}

/** Enforce absent-to-started-to-one-terminal progression for one identity. */
function updateReplay(map: Map<string, Replay>, key: string, status: string, transition: OperationRunTransition, metadata: Pick<Replay, "criticality" | "mutationId">): void {
  const prior = map.get(key);
  if (prior === undefined && status !== "started") throw new Error("outcome terminal requires a durable started outcome");
  if (prior !== undefined && (prior.status !== "started" || status === "started")) throw new Error("outcome regression or duplicate terminal");
  if (prior !== undefined && (prior.criticality !== metadata.criticality || prior.mutationId !== metadata.mutationId)) {
    throw new Error("outcome metadata changed after started");
  }
  assertTerminalOutcomeEvidence(status, transition);
  map.set(key, { status, transitionSequence: transition.sequence, ...metadata });
}

/** Every terminal observation names bounded evidence on its exact transition. */
function assertTerminalOutcomeEvidence(status: string, transition: OperationRunTransition): void {
  if (status === "started") return;
  const payload = transition.payload;
  const requiresEvidence = payload.kind === "mutation" || payload.kind === "projection"
    || (payload.kind === "compensation" && (status === "completed" || status === "failed"));
  if (requiresEvidence && payload.evidence === undefined) throw new Error("terminal outcome transition requires bounded evidence");
}

/** Compare a complete replay map with its persisted current projection. */
function compareReplay<T extends { status: string; transitionSequence: number }>(map: Map<string, Replay>, outcomes: readonly T[], key: (item: T) => string, label: string): void {
  if (map.size !== outcomes.length) throw new Error(`${label} outcomes do not match transitions`);
  for (const outcome of outcomes) assertReplayOutcome(map.get(key(outcome)), outcome, label);
}

/** Match one persisted status, terminal sequence, and metadata to replay. */
function assertReplayOutcome(replayed: Replay | undefined, outcome: { status: string; transitionSequence: number }, label: string): void {
  if (replayed === undefined || replayed.status !== outcome.status || replayed.transitionSequence !== outcome.transitionSequence) {
    throw new Error(`${label} outcomes do not match transitions`);
  }
  const metadata = outcome as { criticality?: string; mutationId?: string };
  if (replayed.criticality !== undefined && replayed.criticality !== metadata.criticality) throw new Error(`${label} outcome metadata does not match transitions`);
  if (replayed.mutationId !== undefined && replayed.mutationId !== metadata.mutationId) throw new Error(`${label} outcome metadata does not match transitions`);
}

/** Reject duplicate exact identities with a caller-selected stable error. */
function rejectDuplicates(items: readonly string[], message: string): void {
  if (new Set(items).size !== items.length) throw new Error(message);
}
