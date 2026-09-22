/**
 * @file test/preparations/lifecycle-custody-observations.test.ts
 * @description Exact namespace-binding counts for one custody operation.
 *
 * WHAT EACH COUNTER SEES, AND WHAT IT DOES NOT. Read this before citing a number
 * from here, because a mis-aimed meter cost this task a full review round.
 *
 *   `captures`      — calls to `withPreparationLifecycleRead`. Sees the driver's
 *                     capture. Blind to any read that does not go through it.
 *   `bindings`      — calls to `openPreparationLifecycleNamespace`. Sees reads
 *                     that BIND THE NAMESPACE. **Blind to path-walking scans**,
 *                     which is how a full re-enumeration of the lifecycle
 *                     registry sat at zero on this meter for several rounds while
 *                     it ran on every operation. External review found that by
 *                     reading the code; this file did not find it by measuring.
 *   `registryWalks` — calls to `scanPreparationOrphans`. Exists precisely because
 *                     `bindings` could not see it.
 *
 * All three are mutation-tested against the change they claim to detect: adding a
 * driver capture moves the first, adding a namespace open moves the second, and
 * restoring the registry re-walk moves the third. A counter that does not move
 * under its own subject is measuring something adjacent.
 *
 * The driver opens EXACTLY ONE capture per operation, with no way to opt out.
 *
 * An earlier design let an adapter declare `consumesCapture: false` and assess
 * from its own independent reads. Measured before this file existed: flipping
 * that flag left the entire suite green — it documented a cost nothing charged.
 * External review then rejected the flag outright as the deferred variant this
 * migration exists to replace, so the flag is gone and these count what is left.
 *
 * These count namespace BINDINGS on the real production path. They are exact
 * equalities, not upper bounds: an operation that binds fewer times has also
 * changed its observation protocol and should come back through review.
 */

import { gateDecision } from "./lifecycle-fixture.js";
import { describe, expect, it, vi } from "vitest";
import { useTempRoot } from "../fixtures/temp-root.js";

const observed = vi.hoisted(() => ({ captures: 0, bindings: [] as string[], registryWalks: 0 }));

type OrphanScanModule = typeof import("../../src/preparations/orphan-scan.js");

// The registry-walking scanner, counted directly. The namespace-binding counter
// above never saw this: the orphan scan walks paths without binding the
// namespace, so a full re-enumeration of the lifecycle registry cost ZERO on that
// meter. External review found the re-walk by reading the code, which is the
// tell that the meter was pointed at the wrong thing.
vi.mock("../../src/preparations/orphan-scan.js", async () => {
  const actual = await vi.importActual<OrphanScanModule>("../../src/preparations/orphan-scan.js");
  return {
    ...actual,
    scanPreparationOrphans: async (...args: Parameters<OrphanScanModule["scanPreparationOrphans"]>) => {
      observed.registryWalks += 1;
      return actual.scanPreparationOrphans(...args);
    },
  };
});

type NamespaceModule = typeof import("../../src/preparations/lifecycle-fs/namespace.js");
type ReadModule = typeof import("../../src/preparations/lifecycle-snapshot/read.js");

// Two counters, because one cannot fail for two reasons distinguishably. The
// DRIVER's capture must be exactly one; total namespace bindings are what the
// operation costs overall, and the gap between them is the recorded
// multi-observation debt that 9E owns.
vi.mock("../../src/preparations/lifecycle-snapshot/read.js", async () => {
  const actual = await vi.importActual<ReadModule>(
    "../../src/preparations/lifecycle-snapshot/read.js",
  );
  return {
    ...actual,
    withPreparationLifecycleRead: async (
      ...args: Parameters<ReadModule["withPreparationLifecycleRead"]>
    ) => {
      observed.captures += 1;
      return actual.withPreparationLifecycleRead(...args);
    },
  };
});

vi.mock("../../src/preparations/lifecycle-fs/namespace.js", async () => {
  const actual = await vi.importActual<NamespaceModule>(
    "../../src/preparations/lifecycle-fs/namespace.js",
  );
  return {
    ...actual,
    // The real opener still runs, so every downstream revalidation and brand
    // check behaves exactly as in production.
    openPreparationLifecycleNamespace: async (
      root: Parameters<NamespaceModule["openPreparationLifecycleNamespace"]>[0],
      mode: Parameters<NamespaceModule["openPreparationLifecycleNamespace"]>[1],
    ) => {
      observed.bindings.push(mode);
      return actual.openPreparationLifecycleNamespace(root, mode);
    },
  };
});

import { quarantinePreparationRunLocked } from "../../src/preparations/quarantine.js";
import {
  prunePreparationRunLocked, sweepPreparationOrphansLocked,
} from "../../src/preparations/retention.js";
import { preparationPaths } from "../../src/preparations/paths.js";
import { pruneUnitIdFor } from "../../src/preparations/prune-delete.js";
import { rm } from "node:fs/promises";
import {
  driveToFailed, LIFECYCLE_ACTOR, stagePreparation, tamperRun,
} from "./lifecycle-fixture.js";

const AT = "2026-07-31T02:00:00.000Z";

/** Quarantine one tampered run, counting what it observed while doing so. */
async function measuredQuarantine(root: string): Promise<typeof observed> {
  const { binding } = await stagePreparation(root);
  await tamperRun(root, binding);
  observed.captures = 0;
  observed.bindings.length = 0;
  observed.registryWalks = 0;
  await quarantinePreparationRunLocked(root, {
    binding, actor: LIFECYCLE_ACTOR, at: AT, confirmResidualState: true,
  });
  return observed;
}

/** Reset the counters immediately before the measured call. */
function resetCounters(): void {
  observed.captures = 0;
  observed.bindings.length = 0;
  observed.registryWalks = 0;
}

/** Prune one eligible run, counting what it observed. */
async function measuredPrune(root: string): Promise<typeof observed> {
  const { binding } = await stagePreparation(root);
  await driveToFailed(root, binding);
  resetCounters();
  await prunePreparationRunLocked(root, {
    authorization: gateDecision("prune", pruneUnitIdFor(binding.runId)),
        target: { kind: "run", binding }, actor: LIFECYCLE_ACTOR, at: AT,
    clock: { now: () => new Date("2026-08-30T02:00:00.000Z") },
  });
  return observed;
}

/** Sweep one provably-absent-owner orphan, counting what it observed. */
async function measuredSweep(root: string): Promise<typeof observed> {
  const { binding } = await stagePreparation(root);
  await driveToFailed(root, binding);
  // Remove the run leaf so its preparation is a provably-absent-owner orphan.
  await rm(preparationPaths(root, binding.workspaceId).runFile(binding.runId), { force: true });
  resetCounters();
  await sweepPreparationOrphansLocked(root, { actor: LIFECYCLE_ACTOR, at: AT, authorization: gateDecision("sweep")});
  return observed;
}

describe("custody operation observation counts", () => {
  const tempRoot = useTempRoot();

  it("opens EXACTLY ONE driver capture, with no way to opt out", async () => {
    const counted = await measuredQuarantine(tempRoot.dir);

    // The invariant that replaced `consumesCapture`. The flag let an adapter
    // declare it did not need the driver's capture and assess from its own
    // independent reads — the deferred variant this migration exists to replace.
    // There is no flag now, so this is one capture for every operation.
    expect(counted.captures).toBe(1);
  });

  it("opens EXACTLY ONE capture for a PRUNE", async () => {
    // Measured on the real public entry point, not on the adapter.
    expect((await measuredPrune(tempRoot.dir)).captures).toBe(1);
  });

  it("opens EXACTLY ONE capture for a SWEEP", async () => {
    // This read THREE before the fix: one to find the pending unit, one to
    // enumerate orphans, and the driver's own -- which the adapter ignored. Two
    // were mine, and the second arrived with the very change that removed sibling
    // enumeration. Trading an uncaptured walk for an extra capture is not what
    // PLA-INV-03 asks for, and no control saw it because this file measured
    // quarantine ONLY.
    expect((await measuredSweep(tempRoot.dir)).captures).toBe(1);
  });

  it("never re-enumerates the lifecycle registry the capture already observed", async () => {
    // The finding this file existed to catch and did not. Planning called
    // `scanPreparationOrphans`, which walks active storage AND the lifecycle
    // registry — a second observation of state the driver's capture had just
    // taken, leaving open the inconsistent-observation window this migration
    // exists to close. Both callers then filtered every quarantine leaf back out,
    // so the second walk fed nothing but its own problem list.
    const counted = await measuredQuarantine(tempRoot.dir);

    expect(counted.registryWalks).toBe(0);
  });

  it("pins what per-run quarantine's assessment actually observes", async () => {
    const counted = await measuredQuarantine(tempRoot.dir);

    // Recorded as a NUMBER rather than described in prose, because prose is how
    // this debt stayed invisible before. Eligibility now comes from the driver's
    // capture; what remains are the observations a lifecycle snapshot genuinely
    // cannot serve — key BYTES for HMAC and the custody phase, receipt BYTES for
    // digests, and the destructive traversal. Those are the
    // `9D/9E-destructive-traversal` obligation, and this figure is what 9E has to
    // move. If it goes UP, an independent read came back.
    expect(counted.bindings.filter((mode) => mode === "read")).toHaveLength(
      READ_BINDINGS_PER_RUN_QUARANTINE,
    );
  });
});

/**
 * Measured, not chosen, and it WENT UP by one when the capture became
 * unconditional — stated plainly rather than buried, because the honest number is
 * the only thing that makes the remaining debt reviewable.
 *
 * Removing `consumesCapture` means every operation now pays for the driver's
 * capture. Eligibility moved onto it, but three independent reads remain that a
 * lifecycle snapshot cannot serve: key BYTES (it carries state and epoch id, never
 * key material), receipt BYTES for digests and HMAC checks, and the destructive
 * traversal. So the structural requirement — one driver-owned capture, no opt-out
 * — is met, while the observation TOTAL is one worse until 9E collapses the rest.
 *
 * That is the trade this number records. If it rises again, an independent read
 * came back.
 */
const READ_BINDINGS_PER_RUN_QUARANTINE = 4;
