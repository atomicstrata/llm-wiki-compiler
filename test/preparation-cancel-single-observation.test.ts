/**
 * @file test/preparation-cancel-single-observation.test.ts
 * @description `cancel` observes the preparation inventory EXACTLY ONCE.
 *
 * WHY THIS NEEDS ITS OWN INSTRUMENT. The property is invisible to every
 * behavioural assertion in the family: composing the two public lookup entry
 * points instead of the shared one scans twice, produces byte-identical results
 * on a quiet store, and leaves the whole suite green. The operation's own source
 * claims it observes once and calls a second scan "the second-observation shape
 * this program has already had to remove from a gate" — and a claim nothing
 * counts is a comment, not a control.
 *
 * WHAT A SECOND SCAN WOULD ACTUALLY COST. Two scans of a LIVE store can disagree:
 * a run present in the first and gone from the second, or the reverse, means the
 * manifest this operation located and the run state it judged terminal came from
 * two different observations of the project. That is the shape that let a gate
 * authorize one unit and act on another.
 *
 * THE COUNT IS THE ASSERTION, so this file cannot pass vacuously: a mock that
 * failed to apply leaves the counter at zero and the expectation fails just as
 * loudly as a double scan would.
 *
 * IT LIVES ALONE because `vi.mock` is hoisted and module-scoped — folding it
 * into the behaviour suite would put every case in that file behind a wrapped
 * module.
 */

import { describe, expect, it, vi } from "vitest";

/** Hoisted so the mock factory — which runs before the module body — can reach it. */
const observed = vi.hoisted(() => ({ scans: 0 }));

vi.mock("../src/preparations/capacity.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/preparations/capacity.js")>();
  return {
    ...actual,
    // A PASSTHROUGH, not a stub: the operation runs against the real scan and
    // real bytes, and the only thing added is the count. A stub would prove the
    // test's own fixture rather than the operation.
    scanPreparationInventory: (...args: Parameters<typeof actual.scanPreparationInventory>) => {
      observed.scans += 1;
      return actual.scanPreparationInventory(...args);
    },
  };
});

const { CANCEL_RECOVERY_GRANTS, serviceOn, stagedProject } =
  await import("./preparation-recovery-fixture.js");

describe("cancel observes the inventory once", () => {
  it("performs exactly ONE scan for one published request", async () => {
    const fixture = await stagedProject("cancelonescan");
    try {
      const service = serviceOn(fixture.root, "sdk", CANCEL_RECOVERY_GRANTS);
      observed.scans = 0;

      expect(await service.cancel({ runId: fixture.binding.runId }))
        .toMatchObject({ status: "requested", request: "created" });

      // ONE. The operation locates the manifest and reads the run belonging to
      // THAT manifest; it does not resolve the run through a second lookup.
      expect(observed.scans).toBe(1);
    } finally { await fixture.cleanup(); }
  });

  it("performs exactly ONE scan even on the refusal that reads the run", async () => {
    // The terminal leg is the one that needs the run's durable state, so it is
    // the leg a second lookup would most naturally be written into.
    const fixture = await stagedProject("cancelonescanterminal");
    try {
      const { driveToFailed } = await import("./preparations/lifecycle-fixture.js");
      await driveToFailed(fixture.root, fixture.binding);
      const service = serviceOn(fixture.root, "sdk", CANCEL_RECOVERY_GRANTS);
      observed.scans = 0;

      expect(await service.cancel({ runId: fixture.binding.runId }))
        .toMatchObject({ status: "refused" });

      expect(observed.scans).toBe(1);
    } finally { await fixture.cleanup(); }
  });
});
