/**
 * @file test/preparation-service-preview-purity.test.ts
 * @description `preview` writes nothing — asserted over the WHOLE PROJECT with a
 * settleable obligation present, which is the case the shipped controls could not
 * see.
 *
 * THE OLD CONTROLS COUNTED MANIFESTS, and a manifest count is not the quantity
 * this operation is accountable for. `preview` shared `stage`'s acquisition, and
 * `acquireMutationLock` is not a mutex: the gate behind it recovers the page
 * journal, gates the lifecycle, and SETTLES OUTSTANDING PREPARATION HANDOFFS.
 * A run sitting at `handoff-started` therefore advanced to `handed-off` because
 * somebody asked what a plan would do — a durable transition appended by the one
 * verb whose entire contract is that it appends nothing. Every manifest count in
 * the suite stayed at 1 throughout. That is not a weak assertion that could be
 * tightened; it is an assertion about a different proposition, so it is replaced
 * here rather than strengthened.
 *
 * SO THE FIXTURE CARRIES A REAL SETTLEABLE OBLIGATION, and the assertions are
 * over IDENTITY: the run's own durable state, and the content address of every
 * file in the project. A count cannot move while damage happens; a state can only
 * move when it does.
 *
 * THE SECOND CASE WITNESSES THE ABSENCE ITSELF. Purity over a clean project is
 * satisfied by an implementation that takes the gated lock and happens to find
 * nothing to settle, so it proves nothing about the acquisition. Answering while
 * another holder owns the lock can only be true of an operation that does not
 * acquire it — and `stage`, in the same fixture, refuses.
 */

import { describe, expect, it } from "vitest";
import { useTempRoot } from "./fixtures/temp-root.js";
import { createPreparationService } from "../src/preparations/service.js";
import type { PreparationServiceV1, PreviewRequestV1 } from "../src/preparations/service.js";
import { handoffPreparation } from "../src/preparations/handoff.js";
import { readPreparationRun } from "../src/preparations/run-store.js";
import { acquireLock, releaseLock } from "../src/utils/lock.js";
import type { PreparationRunBinding } from "../src/preparations/run-types.js";
import { fixturePlan, SEED_VALUE } from "./preparations/store-fixture.js";
import { snapshotTree } from "./preparations/inputs-fixture.js";
import {
  stageReadyPreparation, handoffRequest, CRASH_AFTER_STAGE,
} from "./preparations/handoff-fixture.js";

const root = useTempRoot();

/** The exact key set a preview answer may carry — see {@link previewNamesNoRun}. */
const PREVIEWED_KEYS = ["status", "workspaceId"];

/**
 * An allowance past the 3,200-transition cap (`run-budget.ts:81`).
 *
 * The refusal it produces is raised by the substrate under the publish leg, which
 * is what makes it a case that can observe an acquisition.
 */
const OVER_CAP_ALLOWANCE = 4_000;

/** The documents a preview reads, as text, exactly as a surface supplies them. */
function previewRequest(): PreviewRequestV1 {
  return {
    documents: {
      plan: async () => ({ ok: true as const, text: JSON.stringify(fixturePlan()) }),
      seed: async () => ({ ok: true as const, text: JSON.stringify(SEED_VALUE) }),
    },
    controlTransitionAllowance: 16,
  };
}

/** A service on the local-operator surface, as the CLI host constructs one. */
function serviceFor(dir: string): PreparationServiceV1 {
  return createPreparationService({
    root: dir, surface: "cli",
    principals: { principalFor: () => ({ id: "operator", surface: "cli", grants: [] }) },
  });
}

/** One run's durable state, or why it could not be read — never collapsed. */
async function stateOf(dir: string, binding: PreparationRunBinding): Promise<string> {
  const read = await readPreparationRun(dir, binding);
  return read.status === "ok" ? read.run.state : `unreadable:${read.status}`;
}

/**
 * A project holding a run stranded at `handoff-started` with its bundle created.
 *
 * Driven through the REAL crash seam rather than a hand-written transition, so
 * the obligation the gate would settle is the genuine one: the same fixture that
 * `handoff-faults` uses to prove the gate settles it.
 */
async function strandedHandoff(dir: string): Promise<PreparationRunBinding> {
  const binding = await stageReadyPreparation(dir);
  await expect(handoffPreparation(
    dir, handoffRequest(binding, "ada", { faultsForTest: CRASH_AFTER_STAGE }),
  )).rejects.toThrow("crash");
  expect(await stateOf(dir, binding)).toBe("handoff-started");
  return binding;
}

describe("preview writes nothing, with a settleable obligation present", () => {
  it("leaves the run at handoff-started and the project byte-identical", async () => {
    const binding = await strandedHandoff(root.dir);
    const before = await snapshotTree(root.dir);

    const outcome = await serviceFor(root.dir).preview(previewRequest());

    expect(outcome.status).toBe("previewed");
    // THE STATE FIRST. It names the exact damage; the tree below names any other.
    expect(await stateOf(root.dir, binding)).toBe("handoff-started");
    expect(await snapshotTree(root.dir)).toEqual(before);
  });

  it("still writes nothing when the SUBSTRATE refuses the projection", async () => {
    // A REFUSAL FROM PAST THE ACQUISITION, chosen deliberately. A malformed plan
    // is refused by the document legs BEFORE the publish leg is reached, so it
    // never witnessed the settlement at all — restoring the gated acquisition
    // leaves such a case green, which is how it was measured rather than assumed.
    // An over-cap allowance is refused by `planStage` INSIDE the publish leg, so
    // this case runs everything the acquisition would have run.
    const binding = await strandedHandoff(root.dir);
    const before = await snapshotTree(root.dir);
    const request = { ...previewRequest(), controlTransitionAllowance: OVER_CAP_ALLOWANCE };

    expect(await serviceFor(root.dir).preview(request)).toMatchObject({ status: "refused" });

    expect(await stateOf(root.dir, binding)).toBe("handoff-started");
    expect(await snapshotTree(root.dir)).toEqual(before);
  });
});

describe("preview takes no lock", () => {
  it("answers while the project lock is held by another holder", async () => {
    await stageReadyPreparation(root.dir);
    const service = serviceFor(root.dir);
    await acquireLock(root.dir, { quiet: true });
    try {
      expect((await service.preview(previewRequest())).status).toBe("previewed");
      // THE CONTRAST, IN THE SAME FIXTURE. `stage` acquires and refuses here, so
      // the preview answer above is a property of preview rather than of a lock
      // this test failed to take.
      expect(await service.stage(previewRequest()))
        .toEqual({ status: "refused", reason: "project lock is busy" });
    } finally {
      await releaseLock(root.dir);
    }
  });
});

/** The whole answer, so a re-added identity cannot arrive unnoticed. */
function previewNamesNoRun(outcome: Record<string, unknown>): void {
  expect(Object.keys(outcome).sort()).toEqual(PREVIEWED_KEYS);
}

describe("preview names no run", () => {
  it("carries the workspace it was asked about and no run identity", async () => {
    await stageReadyPreparation(root.dir);
    const outcome = await serviceFor(root.dir).preview(previewRequest());
    // AN EXACT KEY SET, not `toBeUndefined()` on the field somebody thought of.
    // The substrate answers `staged` with a minted `runId` for a run it did not
    // create, and every surface used to receive it.
    previewNamesNoRun(outcome as unknown as Record<string, unknown>);
    expect(outcome).toMatchObject({ status: "previewed", workspaceId: "research" });
  });
});
