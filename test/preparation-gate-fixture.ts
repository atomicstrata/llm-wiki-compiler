/**
 * @file test/preparation-gate-fixture.ts
 * @description Fixtures for the `gate` service suite: a plan that declares a
 * gate reachable from the run's own initial input, and the durable phase
 * instance a decision binds to.
 *
 * WHY THE PHASE INSTANCE IS FIXTURE-SUPPLIED, said plainly rather than hidden in
 * a helper. A gate proof binds a PHASE, and nothing in `src/` yet materializes a
 * gate phase's instance — the leg runner that would is not built. So this fixture
 * appends the phase summary the way the executor's projector would, and every
 * suite reading it should know that the SHAPE comes from here while the
 * AUTHORITY — plan, digests, gate kind, grant — comes from the production path
 * under test. A green suite here is evidence about the gate operation, not
 * evidence that a production run ever reaches a gate.
 *
 * THE GATE IS REBOUND TO THE INITIAL INPUT, and that one field is what makes the
 * happy path reachable at all: the plan's declared initial input set exists from
 * staging, whereas the upstream phase output the base plan binds it to exists
 * only after a phase has run. Both forms are built from the same base plan —
 * `upstreamBound` selects the untouched one — so the could-not-derive refusal is
 * covered by the same fixture and cannot drift from the happy path it contrasts
 * with.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { derivePhaseInstanceId, singleExpansionIdentity } from "../src/preparations/ids.js";
import { readPreparationManifest } from "../src/preparations/manifest-store.js";
import { canonicalDigest } from "../src/profile/templates/signing/canonical.js";
import { parseSha256Digest } from "../src/capability-providers/ids.js";
import type { Sha256Digest } from "../src/preparations/types.js";
import type { PhaseInstanceId } from "../src/preparations/ids.js";
import { preparationRunPredecessor } from "../src/preparations/run-integrity.js";
import { appendProjectedTransitionLocked, readPreparationRun } from "../src/preparations/run-store.js";
import type { PreparationRunContentProjector } from "../src/preparations/run-store.js";
import type {
  PhaseSummaryV1, PreparationRunBinding, PreparationRunV1,
} from "../src/preparations/run-types.js";
import { createPreparationService } from "../src/preparations/service.js";
import type {
  PreparationGrant, PreparationServiceV1, PreparationSurface,
} from "../src/preparations/service.js";
import { acquireLock, releaseLock } from "../src/utils/lock.js";
import { fixturePlan, stageBoundPreparation } from "./preparations/store-fixture.js";

/** The gate id every suite here decides. The base plan already declares it. */
export const SEED_GATE_ID = "review";

/** A phase instance id no gate in these fixtures binds — the decoy summary's. */
export const DECOY_PHASE_ID = `phi_${"c".repeat(64)}` as PhaseInstanceId;

/** How one fixture project's plan and run differ from the default shape. */
export interface GateProjectOptions {
  /** Leave the gate bound to an upstream phase output instead of the seed. */
  readonly upstreamBound?: boolean;
  /** The gate kind the plan declares; the grant it costs follows from it. */
  readonly gateKind?: string;
  /** Record a phase summary the gate does NOT bind, ahead of the one it does. */
  readonly decoyPhase?: boolean;
}

/** A staged project whose plan declares {@link SEED_GATE_ID}. */
export interface GateFixture {
  readonly root: string;
  readonly binding: PreparationRunBinding;
  readonly phaseInstanceId: PhaseInstanceId;
  cleanup(): Promise<void>;
}

/** The gate phase in a mutable plan object, by the id it declares. */
function gatePhaseOf(plan: Record<string, unknown>): Record<string, unknown> {
  const phases = plan.phases as Record<string, unknown>[];
  const phase = phases.find((each) => each.logicalPhaseId === SEED_GATE_ID);
  if (phase === undefined) throw new Error("the base plan no longer declares the gate phase");
  return phase;
}

/**
 * The base plan with its gate REBOUND to the plan's own declared initial input.
 *
 * The base plan binds that gate to an upstream phase's output, which exists only
 * after a phase has produced one — and no production path produces one. Rebinding
 * is one field and it is the difference between a reachable happy path and a
 * suite that could only ever test refusals. The upstream-bound form is kept as
 * {@link upstreamGatePlan} so the could-not-derive leg is still covered.
 */
function gatePlan(gateKind = "review-preparation") {
  return fixturePlan((plan) => {
    const phase = gatePhaseOf(plan);
    phase.inputBindings = [{ bindingId: "seed", sourceKind: "initial-input" }];
    // The KIND is what selects the required grant, so a suite proving the
    // per-kind charge needs to vary it — and only it.
    (phase.gate as { gateKind: string }).gateKind = gateKind;
  });
}

/** The base plan UNCHANGED: its gate reads an upstream phase's output. */
function upstreamGatePlan() {
  return fixturePlan();
}

/** Stage one durable preparation whose plan declares the seed-bound gate. */
export async function gateProject(
  prefix: string, options: GateProjectOptions = {},
): Promise<GateFixture> {
  const root = await mkdtemp(path.join(tmpdir(), `llmwiki-${prefix}-`));
  const plan = options.upstreamBound === true ? upstreamGatePlan() : gatePlan(options.gateKind);
  const binding = await stageBoundPreparation(root, plan);
  return {
    root, binding,
    phaseInstanceId: derivePhaseInstanceId({
      manifestDigest: binding.manifestDigest, logicalPhaseId: SEED_GATE_ID,
      expansionIdentity: singleExpansionIdentity(),
    }),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

/** One phase summary in the shape the executor's projector writes. */
function phaseSummary(phaseInstanceId: PhaseInstanceId, logicalPhaseId: string): PhaseSummaryV1 {
  return {
    phaseInstanceId, logicalPhaseId, state: "running", disposition: "required",
    attemptCount: 0, invocationCount: 0, brokerRequestCount: 0, effectCount: 0,
  };
}

/** Project phase summaries onto the run, as the executor's projector would. */
function phaseSummaryProjector(summaries: readonly PhaseSummaryV1[]): PreparationRunContentProjector {
  return (next) => ({ ...next, phaseSummaries: [...next.phaseSummaries, ...summaries] });
}

/**
 * Drive the staged run to `running` carrying the gate phase's instance.
 *
 * It appends the ordinary `phase-started` transition the executor appends and
 * projects the phase summary alongside it — no execution owner, because a gate
 * decision binds a phase, not a lease, and an owner would make every run this
 * fixture builds look busy to the sweeps that read one.
 */
async function driveGatePhase(
  fixture: GateFixture, decoyPhase = false, at = "2026-08-07T00:00:01.000Z",
): Promise<void> {
  const summary = phaseSummary(fixture.phaseInstanceId, SEED_GATE_ID);
  // THE DECOY GOES FIRST, deliberately. A resolver that read `phaseSummaries[0]`
  // rather than the gate's own logical phase would bind the proof to this one,
  // and `phaseDigest` is what revalidation enforces at effect time — so the
  // ordering is what makes the difference observable at all.
  const summaries = decoyPhase
    ? [phaseSummary(DECOY_PHASE_ID, "collect"), summary] : [summary];
  await acquireLock(fixture.root, { quiet: true });
  try {
    const read = await readPreparationRun(fixture.root, fixture.binding);
    if (read.status !== "ok") throw new Error(`run ${read.status}`);
    await appendProjectedTransitionLocked(fixture.root, fixture.binding, preparationRunPredecessor(read.run), {
      type: "phase-started", stateAfter: "running", actor: { id: "operator", surface: "cli" }, at,
      payload: { kind: "phase", phaseInstanceId: fixture.phaseInstanceId, phaseState: "running" },
    }, phaseSummaryProjector(summaries));
  } finally {
    await releaseLock(fixture.root);
  }
}

/** A staged project whose run is `running` and carries the gate's phase instance. */
export async function gatedRun(
  prefix: string, options: GateProjectOptions = {},
): Promise<GateFixture> {
  const fixture = await gateProject(prefix, options);
  await driveGatePhase(fixture, options.decoyPhase === true);
  return fixture;
}

/** The run as it durably stands, for an assertion that reads disk not the DTO. */
export async function readGateRun(fixture: GateFixture): Promise<PreparationRunV1> {
  const read = await readPreparationRun(fixture.root, fixture.binding);
  if (read.status !== "ok") throw new Error(`run ${read.status}`);
  return read.run;
}

/**
 * The authoritative current plan digest, recomputed from the durable manifest.
 *
 * ONE HOME because three suites ask the same question of the same consumer, and a
 * per-suite copy is how one of them comes to compare against a digest the
 * production finder never sees.
 */
export async function currentPlanDigest(fixture: GateFixture): Promise<Sha256Digest> {
  const read = await readPreparationManifest(
    fixture.root, fixture.binding.workspaceId, fixture.binding.preparationId);
  if (read.status !== "ok") throw new Error(`manifest ${read.status}`);
  return parseSha256Digest(canonicalDigest(read.manifest.plan));
}

/** The grant a `review-preparation` gate costs, so no suite guesses a token. */
export const REVIEW_GATE_GRANTS: readonly PreparationGrant[] = ["preparation.gate.decide"];

/** The grant the effect-class gates cost. */
export const EFFECT_GATE_GRANTS: readonly PreparationGrant[] = ["preparation.effect.approve"];

/** A service a SECOND HOST would construct, on a chosen surface and grant set. */
export function gateServiceOn(
  root: string, surface: PreparationSurface, grants: readonly PreparationGrant[], id = "host-2",
): PreparationServiceV1 {
  return createPreparationService({
    root, surface, principals: { principalFor: () => ({ id, surface, grants }) },
  });
}
