/**
 * @file test/preparation-recovery-fixture.ts
 * @description Fixtures for the `cancel` and `recovery` service suites: a run
 * left `running` under an owner that is either LIVE or STRANDED, plus the
 * durable reads those suites assert against.
 *
 * WHY BOTH OWNERS, AND WHY THEY ARE THE SAME BUILDER. The whole precondition
 * recovery turns on is stranded-versus-busy, so a fixture that could only
 * produce one of them would let a park that ignores liveness look correct. The
 * two differ in exactly ONE recorded field, which is what makes the pair a
 * discriminating instrument rather than two unrelated setups.
 *
 * HOW A STRANDED OWNER IS BUILT, and why it needs no dead process. Liveness goes
 * through the hardened `isOwnerStale`, whose PID-reuse leg compares the recorded
 * process start time against the CURRENT one. A record naming this live process
 * with a start time that is not this process's start time is therefore stale by
 * the primitive's own rule — deterministically, with no spawn, no sleep, and no
 * chance that an unrelated process claims a recycled PID mid-suite.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { expect } from "vitest";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPreparationService } from "../src/preparations/service.js";
import type {
  PreparationGrant, PreparationServiceV1, PreparationSurface,
} from "../src/preparations/service.js";
import { attemptIntentProjector, sealAttemptContext, upsertPhaseSummary } from "../src/preparations/attempts/start.js";
import { deriveAttemptId, derivePhaseInstanceId, singleExpansionIdentity } from "../src/preparations/ids.js";
import type { PhaseInstanceId } from "../src/preparations/ids.js";
import { readProcessStartTime } from "../src/utils/lock-owner.js";
import { readPreparationManifest } from "../src/preparations/manifest-store.js";
import { preparationManifestDigest } from "../src/preparations/manifest-parse.js";
import { preparationRunPredecessor } from "../src/preparations/run-integrity.js";
import {
  appendPreparationTransitionLocked, appendProjectedTransitionLocked, readPreparationRun,
} from "../src/preparations/run-store.js";
import type { PreparationRunContentProjector } from "../src/preparations/run-store.js";
import type { PreparationRunBinding, PreparationRunV1 } from "../src/preparations/run-types.js";
import { acquireLock, releaseLock } from "../src/utils/lock.js";
import { stageBoundPreparation } from "./preparations/store-fixture.js";

/** A staged project, the run binding, and the phase a fixture attempt runs in. */
export interface RunningRunFixture {
  readonly root: string;
  readonly binding: PreparationRunBinding;
  readonly phaseInstanceId: PhaseInstanceId;
  cleanup(): Promise<void>;
}

/**
 * The start identity a STRANDED owner records: a well-formed identity this
 * process cannot have.
 *
 * IT MUST BE IN THE VERSIONED FORMAT, and that is the whole point of the
 * fixture. This was a rendered ISO string, which the identity comparison now
 * classifies as UNRECOGNISED — incomparable, therefore unobservable, therefore
 * NOT stale. A stranded owner has to be PROVABLY GONE, and since process
 * identity became timezone-invariant the only thing that proves that is a
 * comparable identity that disagrees. A rendered string proves nothing: refusing
 * to read it as evidence of death is the migration guard's entire job.
 */
const STALE_PROCESS_START_TIME = "unix:1";

/** The lease nonce every fixture attempt fences with. */
const FIXTURE_LEASE_NONCE = "f".repeat(32);

/**
 * PID 1 — a process that is unmistakably LIVE and that this uid cannot signal.
 *
 * The third owner shape, and the one that matters most: `kill(1, 0)` throws
 * EPERM rather than succeeding, so a liveness check that reads every signal
 * failure as death calls `init`/`launchd` a corpse. It needs no spawn and cannot
 * be recycled mid-suite.
 */
const FOREIGN_LIVE_PID = 1;

/** The recorded owner identity for one fixture attempt's lease. */
type FixtureOwner = "live" | "identified" | "stranded" | "unsignalable";

/** The pid and recorded start time each owner shape is built from. */
function ownerIdentity(owner: FixtureOwner): { pid: number; processStartTime?: string } {
  // The unsignalable owner records the foreign process's REAL start time, so the
  // PID-reuse evidence says "this is genuinely that process" and the only thing
  // left to decide liveness is the signal probe.
  if (owner === "unsignalable") {
    const startTime = readProcessStartTime(FOREIGN_LIVE_PID);
    if (startTime === null) throw new Error("cannot read the foreign live pid's start time");
    return { pid: FOREIGN_LIVE_PID, processStartTime: startTime };
  }
  // The other two name THIS process and differ only in the recorded start time:
  // a live owner carries its real one, a stranded owner carries an identity this
  // PID cannot have (the PID-reuse case, stale by the primitive's own rule).
  // AN IDENTIFIED OWNER RECORDS ITS OWN REAL START TIME, which is what makes it
  // provably LIVE rather than merely unrecorded. `live` deliberately omits the
  // start time and therefore classifies as `unobservable-unrecorded` — the two
  // are different answers and a reporting surface must tell them apart.
  if (owner === "identified") {
    const startTime = readProcessStartTime(process.pid);
    if (startTime === null) throw new Error("cannot read this process's own start time");
    return { pid: process.pid, processStartTime: startTime };
  }
  return owner === "live"
    ? { pid: process.pid }
    : { pid: process.pid, processStartTime: STALE_PROCESS_START_TIME };
}

/**
 * Stage one more durable preparation into an EXISTING root.
 *
 * It owns no root and cleans nothing up, so a suite can put a SECOND run beside
 * the first — which is what makes a retargeting probe observable: an operation
 * that acted on the wrong run has to have another run to act on.
 */
export async function stageRunIn(root: string): Promise<RunningRunFixture> {
  const binding = await stageBoundPreparation(root);
  return {
    root, binding,
    phaseInstanceId: derivePhaseInstanceId({
      manifestDigest: binding.manifestDigest, logicalPhaseId: "collect",
      expansionIdentity: singleExpansionIdentity(),
    }),
    cleanup: async () => {},
  };
}

/**
 * Acquire, read the current predecessor, append one PHASE transition with its
 * projector, release.
 *
 * ONE HOME because both fixture legs need exactly this and differ only in the
 * transition and the projector — a second copy is how one of them comes to skip
 * the release, or to fence against a predecessor it read before the other wrote.
 */
async function appendPhaseUnderLock(
  fixture: RunningRunFixture,
  transition: { type: "phase-started" | "phase-settled"; phaseState: string; at: string },
  project: PreparationRunContentProjector,
): Promise<void> {
  const { root, binding, phaseInstanceId } = fixture;
  await acquireLock(root, { quiet: true });
  try {
    const read = await readPreparationRun(root, binding);
    if (read.status !== "ok") throw new Error("run unavailable");
    await appendProjectedTransitionLocked(root, binding, preparationRunPredecessor(read.run), {
      type: transition.type, stateAfter: "running", actor: { id: "operator", surface: "cli" },
      at: transition.at,
      payload: { kind: "phase", phaseInstanceId, phaseState: transition.phaseState as never },
    }, project);
  } finally {
    await releaseLock(root);
  }
}

/**
 * Drive a `running` run to a DURABLE SAFE CHECKPOINT: the phase settles and the
 * owner is cleared, exactly as the executor's own settle projector does it.
 *
 * This is the state `pause` is defined against, and it cannot be reached by
 * skipping the owner: a run that never had one was never at a checkpoint, it just
 * never started. Driving the real pair — start under an owner, then settle it —
 * is what makes the fixture the state rather than a shape resembling it.
 */
export async function driveCheckpointed(fixture: RunningRunFixture): Promise<void> {
  await driveRunning(fixture, "identified");
  await appendPhaseUnderLock(fixture, {
    type: "phase-settled", phaseState: "succeeded", at: "2026-08-07T00:00:02.000Z",
  }, clearOwnerSettled(fixture.phaseInstanceId));
}

/** The settle projector's two facts: the owner is gone, the phase is settled. */
function clearOwnerSettled(phaseInstanceId: PhaseInstanceId): PreparationRunContentProjector {
  return (next) => {
    const { executionOwner: _cleared, ...rest } = next;
    const prior = next.phaseSummaries.find((summary) => summary.phaseInstanceId === phaseInstanceId);
    if (prior === undefined) throw new Error("fixture phase summary missing");
    return {
      ...rest,
      phaseSummaries: upsertPhaseSummary(next.phaseSummaries, { ...prior, state: "succeeded" }),
    };
  };
}

/**
 * Drive a checkpointed run to `awaiting-gate` — a run waiting on a decision.
 *
 * NOTHING IN PRODUCTION WRITES THIS STATE for a preparation run, which is why it
 * needs a fixture at all: measured, `src/` contains no appender targeting
 * `stateAfter: "awaiting-gate"` — every occurrence of the string is either the
 * substrate's own vocabulary or `src/workflows`, a different domain that reuses
 * the word. The `gate` operation records its decision and deliberately does not
 * move the run.
 *
 * SO THIS IS A LATENT STATE, and building it is how a latent defect gets
 * witnessed before a writer arrives to arm it. It goes through the run store's
 * own `gate-blocked` transition rather than editing a leaf, so the state is the
 * real one the substrate admits.
 *
 * The owner is already cleared by {@link driveCheckpointed}, which matters: a run
 * still carrying one would be refused by `pause`'s in-flight check and the
 * DOMAIN question — which states may be paused at all — would never be reached.
 */
export async function driveAwaitingGate(fixture: RunningRunFixture): Promise<void> {
  await driveCheckpointed(fixture);
  const { root, binding } = fixture;
  await acquireLock(root, { quiet: true });
  try {
    const read = await readPreparationRun(root, binding);
    if (read.status !== "ok") throw new Error("run unavailable");
    await appendPreparationTransitionLocked(root, binding, preparationRunPredecessor(read.run), {
      type: "gate-blocked", stateAfter: "awaiting-gate",
      actor: { id: "operator", surface: "cli" }, at: "2026-08-07T00:00:03.000Z",
      payload: { kind: "none" },
    });
  } finally {
    await releaseLock(root);
  }
}

/** Stage one durable preparation on a fresh temp root and bind its run. */
export async function stagedProject(prefix: string): Promise<RunningRunFixture> {
  const root = await mkdtemp(path.join(tmpdir(), `llmwiki-${prefix}-`));
  const staged = await stageRunIn(root);
  return { ...staged, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/**
 * Drive a staged run to `running` under an owner that is live or stranded.
 *
 * The transition is the same one the executor appends; only the lease's recorded
 * process identity differs, so the two fixtures are distinguishable by exactly
 * the field the liveness test reads.
 */
export async function driveRunning(
  fixture: RunningRunFixture, owner: FixtureOwner,
): Promise<void> {
  const { root, binding, phaseInstanceId } = fixture;
  const manifestRead = await readPreparationManifest(root, binding.workspaceId, binding.preparationId);
  if (manifestRead.status !== "ok") throw new Error("manifest unavailable");
  const phase = manifestRead.manifest.plan.phases.find((each) => each.logicalPhaseId === "collect");
  if (phase?.executor === undefined) throw new Error("fixture plan has no collect executor");
  const sealed = sealAttemptContext({
    manifest: manifestRead.manifest, executor: phase.executor, bounds: phase.bounds,
    extras: { inputExposureSetDigest: binding.manifestDigest, providerPinDigest: binding.manifestDigest },
    attemptId: deriveAttemptId(phaseInstanceId, 0), phaseInstanceId,
    logicalPhaseId: "collect", disposition: phase.disposition,
    lease: {
      leaseNonce: FIXTURE_LEASE_NONCE, acquiredAt: "2026-08-07T00:00:00.000Z",
      // The ONLY thing that varies across the three fixtures — same transition,
      // same projector, one recorded process identity.
      ...ownerIdentity(owner),
    },
    stateVersionAtSeal: 1,
  });
  await appendPhaseUnderLock(fixture, {
    type: "phase-started", phaseState: "running", at: "2026-08-07T00:00:01.000Z",
  }, attemptIntentProjector(sealed, 1));
}

/** A staged project whose single run is `running` under a stranded owner. */
export async function strandedRun(prefix: string): Promise<RunningRunFixture> {
  const fixture = await stagedProject(prefix);
  await driveRunning(fixture, "stranded");
  return fixture;
}

/** The run as it durably stands, for an assertion that reads disk not the DTO. */
export async function readRun(fixture: RunningRunFixture): Promise<PreparationRunV1> {
  const read = await readPreparationRun(fixture.root, fixture.binding);
  if (read.status !== "ok") throw new Error(`run ${read.status}`);
  return read.run;
}

/**
 * Assert one run is EXACTLY the zombie it was: still running, owner intact.
 *
 * Shared because it is the "nothing moved" half of every refusal case in this
 * family, and that half is the one a copy loses first — a test asserting only
 * the refusal passes against code that refuses after committing.
 */
export async function expectStillRunningWithOwner(fixture: RunningRunFixture): Promise<void> {
  const run = await readRun(fixture);
  expect(run.state).toBe("running");
  expect(run.executionOwner).toBeDefined();
}

/**
 * A request whose `runId` getter answers DIFFERENTLY on each read.
 *
 * The split-read probe: an operation reading the field twice drives one run and
 * names another in its result, so `reads()` pins the count and the second run
 * makes the divergence observable.
 */
export function countingRunIdRequest(
  first: RunningRunFixture, second: RunningRunFixture,
): { request: { readonly runId: string }; reads(): number } {
  let reads = 0;
  return {
    request: {
      get runId(): string {
        reads += 1;
        return reads === 1 ? first.binding.runId : second.binding.runId;
      },
    },
    reads: () => reads,
  };
}

/** The two grants this operation family costs, so a suite never guesses a token. */
export const CANCEL_RECOVERY_GRANTS: readonly PreparationGrant[] = [
  "preparation.cancel", "preparation.recovery",
];

/**
 * A service a SECOND HOST would construct, on a chosen surface and grant set.
 *
 * The `sdk` surface is where a grant check has content: a `cli` principal holds
 * the whole local-operator set by transport, so a refusal test written there
 * proves nothing at all.
 */
export function serviceOn(
  root: string, surface: PreparationSurface, grants: readonly PreparationGrant[],
  id = "host-2",
): PreparationServiceV1 {
  return createPreparationService({
    root, surface, principals: { principalFor: () => ({ id, surface, grants }) },
  });
}
