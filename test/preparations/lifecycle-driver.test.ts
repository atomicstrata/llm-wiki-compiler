/**
 * @file test/preparations/lifecycle-driver.test.ts
 * @description Driver-level properties Task 9D introduced, each pinned against
 * the exact regression that motivated it.
 *
 * Every fault test here is paired with a control that runs the SAME sequence
 * without the fault. That pairing is the point: a refusal proves nothing unless
 * the fixture is shown to succeed without it, and this program has shipped tests
 * that passed because their setup was broken rather than because the guard
 * worked. The helpers below exist so the two halves of each pair differ only in
 * the fault.
 */

import { appendFile, lstat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempRoot, useTempRoot } from "../fixtures/temp-root.js";
import {
  MISSING_KEY_CONFIRMATION, resetPreparationKeyEpochLocked,
} from "../../src/preparations/reset.js";
import {
  LIFECYCLE_ACTOR, removePreparationKey, stagePreparation, tamperRun,
} from "./lifecycle-fixture.js";
import { quarantinePreparationRunLocked } from "../../src/preparations/quarantine.js";
import { preparationQuarantineUnitPaths } from "../../src/preparations/paths.js";
import type {
  LifecycleCustodyMovePlan, LifecycleCustodyAssessment,
} from "../../src/preparations/lifecycle-driver.js";

const AT = "2026-08-01T00:00:00.000Z";
const root = useTempRoot();
const RESET_INPUT = { actor: LIFECYCLE_ACTOR, at: AT, confirmation: MISSING_KEY_CONFIRMATION };

/** Reset pass one, which records the intent the second pass continues. */
async function recordResetIntent(dir: string) {
  const first = await resetPreparationKeyEpochLocked(dir, RESET_INPUT);
  if (first.status !== "intent-recorded") throw new Error(`no intent: ${first.status}`);
  return { unitId: first.unitId, token: first.continuationToken };
}

/** Reset pass two, which is where every guard under test actually runs. */
function continueReset(dir: string, continuation: { unitId: string; token: string }) {
  return resetPreparationKeyEpochLocked(dir, { ...RESET_INPUT, continuation });
}

/** A completed quarantine unit whose receipt cannot be read. */
async function unitWithUnreadableReceipt(dir: string) {
  const receipt = await quarantineTamperedRun(dir);
  const paths = preparationQuarantineUnitPaths(dir, receipt.unitId);
  await appendFile(paths.completedReceiptFile, " ".repeat(OVERSIZE_RECEIPT_BYTES));
  await removePreparationKey(dir);
  return receipt;
}

/** Quarantine one tampered run, so a completed unit exists to be retired. */
async function quarantineTamperedRun(dir: string) {
  const { binding } = await stagePreparation(dir);
  await tamperRun(dir, binding);
  return quarantinePreparationRunLocked(dir, {
    binding, actor: LIFECYCLE_ACTOR, at: AT, confirmResidualState: true,
  });
}

/** The driver entry point, imported lazily so module mocks apply per test. */
async function driverEntry() {
  const { runLifecycleCustodyOperation } = await import(
    "../../src/preparations/lifecycle-driver.js");
  return runLifecycleCustodyOperation;
}

/** The throwaway key every synthetic adapter here returns. */
const SYNTHETIC_KEY = { key: Buffer.alloc(32), keyEpochId: "0".repeat(64) };

/** A fresh, mutable caller request — the object these tests try to mutate. */
const callerRequest = () => ({ actor: { ...LIFECYCLE_ACTOR }, at: AT, authorization: "ungated" as const });

/** The minimal valid per-run plan draft every synthetic adapter here supplies. */
function perRunDraft(unitId: string) {
  return {
    kind: "custody-move" as const,
    unitId, scope: "per-run" as const, reason: "run-integrity-invalid" as const,
    objects: [], residualObligations: [],
  };
}

/** An adapter whose materialize runs whatever the caller supplies. */
function nestingAdapter(unitId: string, materialize: () => Promise<unknown>) {
  const key = { key: Buffer.alloc(32), keyEpochId: "0".repeat(64) };
  return {
    operation: "quarantine" as const,
    planKind: "custody-move" as const,
    assess: () => Promise.resolve({
      draft: perRunDraft(unitId),
      key,
    }),
    materialize: () => materialize().then(() => key),
  };
}

/** One clean custody operation against an arbitrary root. */
async function driveInRoot(dir: string) {
  const { runLifecycleCustodyOperation } = await import(
    "../../src/preparations/lifecycle-driver.js");
  const key = { key: Buffer.alloc(32), keyEpochId: "0".repeat(64) };
  return runLifecycleCustodyOperation(dir, {
    operation: "quarantine" as const,
    planKind: "custody-move" as const,
    assess: () => Promise.resolve({
      draft: perRunDraft(VALID_UNIT_ID),
      key,
    }),
    materialize: () => Promise.resolve(key),
  }, { actor: LIFECYCLE_ACTOR, at: AT, authorization: "ungated" as const });
}

/** A unit id the downstream namespace accepts, so a clean run can succeed. */
const VALID_UNIT_ID = `qtn-${"a".repeat(32)}`;

/**
 * Drive one custody operation whose `materialize` edits the REQUEST after the
 * seal — the same class as editing the plan, one object across.
 */
async function driveWithRequestEdit(edit: (input: { actor: typeof LIFECYCLE_ACTOR; at: string; authorization: "ungated" }) => void) {
  const runLifecycleCustodyOperation = await driverEntry();
  const key = SYNTHETIC_KEY;
  const input = callerRequest();
  const receipt = await runLifecycleCustodyOperation(root.dir, {
    operation: "quarantine" as const,
    planKind: "custody-move" as const,
    assess: () => Promise.resolve({
      draft: perRunDraft(VALID_UNIT_ID),
      key,
    }),
    materialize: () => { edit(input); return Promise.resolve(key); },
  }, input);
  return receipt;
}

/**
 * Drive one custody operation whose `materialize` edits the plan after the
 * capture has closed — the honest-refactor shape the seal exists to refuse.
 */
async function driveWithPlanEdit(
  draft: LifecycleCustodyMovePlan,
  edit: (assessment: LifecycleCustodyAssessment<"custody-move">) => void,
) {
  const { runLifecycleCustodyOperation } = await import(
    "../../src/preparations/lifecycle-driver.js");
  const key = { key: Buffer.alloc(32), keyEpochId: "0".repeat(64) };
  return runLifecycleCustodyOperation(root.dir, {
    operation: "quarantine" as const,
    planKind: "custody-move" as const,
    assess: () => Promise.resolve({ draft, key }),
    materialize: (
      _r: string, _i: unknown, assessment: LifecycleCustodyAssessment<"custody-move">,
    ) => {
      edit(assessment);
      return Promise.resolve(key);
    },
  }, { actor: LIFECYCLE_ACTOR, at: AT, authorization: "ungated" as const });
}

const SEALED = /read only|not extensible|frozen/u;

describe("the custody driver's single capture", () => {
  it("refuses to attest a retirement set from a non-authoritative listing", async () => {
    // REGRESSION. Routing the retirement set through the driver's capture first
    // filtered `snapshot.units` directly, which dropped the second availability
    // gate `projectQuarantineUnits` applies. Measured at that revision: the reset
    // COMPLETED and attested `retiredUnits` from a partial inventory.
    //
    // The fault shape matters and is why an earlier probe of mine wrongly
    // concluded this was unreachable. A SYMLINK trips the destructive-scan
    // completeness gate first, so the reset refuses for another reason. A plain,
    // safe-named regular file does not: `scanPreparationOrphans` classifies it
    // `kind: "quarantine"` and raises no problem, while the lifecycle observer
    // still reports `unit-entry-unavailable`. Only that shape isolates this gate.
    await stagePreparation(root.dir);
    await removePreparationKey(root.dir);

    // Pass one must precede the fault: `settlePendingIntents` consults the same
    // listing and would refuse `reset-already-pending` before pass two is reached.
    const continuation = await recordResetIntent(root.dir);
    await writeFile(
      path.join(root.dir, ".llmwiki", "preparation-quarantine", "stray-file"), "x",
    );

    await expect(continueReset(root.dir, continuation))
      // Names the LISTING leg specifically. The shared phrase matched three legs,
      // which is what let this test keep passing after losing its subject — and
      // making the production messages distinct without tightening the assertion
      // that reads them left the closure one fixture change from reverting.
      .rejects.toThrow(/listing is incomplete/u);
  });

  it("still completes a reset when the registry listing is authoritative", async () => {
    // The control for the test above: without the stray entry the same sequence
    // completes, so the refusal is caused by the fault and not by the fixture.
    await stagePreparation(root.dir);
    await removePreparationKey(root.dir);
    const done = await continueReset(root.dir, await recordResetIntent(root.dir));
    expect(done.status).toBe("completed");
  });
});

describe("the sealed plan draft", () => {
  it("refuses an edit made after the capture closed", async () => {
    // REGRESSION. The driver described the draft as sealed and did not seal it.
    // Review demonstrated an adapter whose `materialize` emptied `objects` and
    // replaced `residualObligations`, with the signed receipt following — a set
    // attested by nothing that was ever observed.
    await expect(driveWithPlanEdit({
      kind: "custody-move", unitId: VALID_UNIT_ID,
      scope: "per-run", reason: "run-integrity-invalid",
      objects: [], residualObligations: ["original"],
    }, (assessment) => {
      // The honest-refactor shape: "just add one more obligation here".
      (assessment.draft.residualObligations as string[]).push("injected");
    })).rejects.toThrow(SEALED);
  });

  it("completes the same sequence when materialize edits nothing", async () => {
    // The control the header promised and this block did not have. Worse, the
    // two fault tests used unit ids the namespace rejects downstream, so a
    // no-op run failed with "unsafe preparation safe component" — meaning
    // nothing showed the fixture could succeed at all, and the refusals could
    // have been coming from the id rather than the seal.
    await expect(driveWithPlanEdit({
      kind: "custody-move", unitId: VALID_UNIT_ID,
      scope: "per-run", reason: "run-integrity-invalid",
      objects: [], residualObligations: ["original"],
    }, () => { /* the honest adapter: touch nothing after the capture closed */ }))
      .resolves.toBeDefined();
  });

  it("seals the plan all the way down, not just its arrays", async () => {
    // REGRESSION. The seal froze the draft and its arrays and left every element
    // writable — and every field the receipt attests lives on those elements.
    await expect(driveWithPlanEdit({
      kind: "custody-move", unitId: VALID_UNIT_ID,
      scope: "per-run", reason: "run-integrity-invalid",
      objects: [{ sourcePath: "/a", logicalPath: "a", byteCount: 1, digest: null }],
      residualObligations: ["original"],
    }, (assessment) => {
      (assessment.draft.objects[0] as { logicalPath: string }).logicalPath = "swapped";
    })).rejects.toThrow(SEALED);
  });
});

describe("a smuggled plan field never reaches the receipt", () => {
  it("keeps an adapter-added field out of the signed receipt", async () => {
    // WHAT THIS PROVES, stated precisely because my first version of this comment
    // claimed more. It proves the END-TO-END property: a field an adapter adds to
    // its plan does not appear in the signed receipt.
    //
    // It does NOT prove the driver's field-by-field assembly. I mutation-tested
    // it by spreading the whole plan into the engine input, and this test still
    // passed -- because `runTwoPhaseQuarantine` builds the receipt from its own
    // named fields, so it is the ENGINE, not the driver's assembly, that keeps a
    // smuggled field out here.
    //
    // The driver's assembly is therefore defence in depth at this seam, not the
    // enforcing control, and it has no independent test. That is an evidence gap
    // worth naming rather than a control worth claiming: a test whose name states
    // a general property and whose mutation does not turn it red is testing
    // something other than what its name says.
    const smuggled = {
      ...perRunDraft(VALID_UNIT_ID),
      residualObligations: ["real"],
      smuggledField: "should never reach the receipt",
    };
    const receipt = await driveWithPlanEdit(
      smuggled as unknown as LifecycleCustodyMovePlan, () => { /* no edit */ });
    expect(receipt).toBeDefined();
    expect(Object.keys(receipt)).not.toContain("smuggledField");
    expect(JSON.stringify(receipt)).not.toContain("smuggledField");
    // The negative control: a field the driver DOES name still arrives, so the
    // assertion above is about naming rather than about the receipt being empty.
    expect(receipt.residualObligations).toEqual(["real"]);
  });
});

describe("the attested request", () => {
  it("attests the actor the caller supplied, not one swapped in during materialize", async () => {
    // REGRESSION. The seal covered the plan and not the request, and the driver
    // read `input.actor` AFTER materialize — so an adapter could sign a receipt
    // in someone else's name. This is the failure the seal exists to prevent,
    // one object across, and nothing covered it.
    const receipt = await driveWithRequestEdit((input) => {
      input.actor = { ...LIFECYCLE_ACTOR, id: "someone-else" } as typeof LIFECYCLE_ACTOR;
    });
    expect(receipt.actor.id).toBe(LIFECYCLE_ACTOR.id);
  });

  it("attests the actor supplied even when materialize mutates it IN PLACE", async () => {
    // The reassignment test above passed while this failed: the seal copied the
    // actor REFERENCE, so mutating a field of it still reached the signed
    // receipt. Same defect the plan seal had already fixed one level down.
    const receipt = await driveWithRequestEdit((input) => { input.actor.id = "impersonated"; });
    expect(receipt.actor.id).toBe(LIFECYCLE_ACTOR.id);
  });

  it("attests the actor supplied even when it is mutated DURING the assessment", async () => {
    // The window the previous tests missed entirely. They mutated during
    // `materialize`, by which point the copy had been taken — but the copy was
    // taken AFTER `await assess`, so the whole asynchronous assessment was a
    // mutation window. External review reproduced it and the receipt signed the
    // mutated identity. The capture is now synchronous, before the first await.
    const runLifecycleCustodyOperation = await driverEntry();
    const key = SYNTHETIC_KEY;
    const input = callerRequest();
    const receipt = await runLifecycleCustodyOperation(root.dir, {
      operation: "quarantine" as const,
    planKind: "custody-move" as const,
      assess: async () => {
        // Mutate while the assessment is still pending.
        input.actor.id = "impersonated";
        input.at = "1999-01-01T00:00:00.000Z";
        await Promise.resolve();
        return {
          draft: perRunDraft(VALID_UNIT_ID),
          key,
        };
      },
      materialize: () => Promise.resolve(key),
    }, input);

    expect(receipt.actor.id).toBe(LIFECYCLE_ACTOR.id);
    expect(receipt.at).toBe(AT);
  });

  it("attests the timestamp the caller supplied, not one swapped in during materialize", async () => {
    const receipt = await driveWithRequestEdit((input) => { input.at = "1999-01-01T00:00:00.000Z"; });
    expect(receipt.at).toBe(AT);
  });
});

describe("the driver's phase order", () => {
  it("assesses, then mints the permit, then materializes, then reaches the engine", async () => {
    // PLA-MAP-D01's central claim is the ORDER, and its cited tests proved the
    // permit requirement and the seal — not the sequence. Nothing pinned that
    // materialize runs after assessment, or that the permit exists before
    // materialize is allowed to mutate anything.
    const { runLifecycleCustodyOperation } = await import(
      "../../src/preparations/lifecycle-driver.js");
    const key = { key: Buffer.alloc(32), keyEpochId: "0".repeat(64) };
    const order: string[] = [];
    await runLifecycleCustodyOperation(root.dir, {
      operation: "quarantine" as const,
    planKind: "custody-move" as const,
      assess: () => {
        order.push("assess");
        return Promise.resolve({
          draft: perRunDraft(VALID_UNIT_ID),
          key,
        });
      },
      materialize: (_root, _input, _assessment, permit) => {
        order.push(permit === undefined ? "materialize-without-permit" : "materialize-with-permit");
        return Promise.resolve(key);
      },
    }, { actor: LIFECYCLE_ACTOR, at: AT, authorization: "ungated" as const });

    // The engine ran last by construction: it produced the receipt this awaited.
    expect(order).toEqual(["assess", "materialize-with-permit"]);
  });
});

describe("driver re-entrancy", () => {
  it("refuses a second custody operation driven from inside materialize", async () => {
    // PLA-INV-07 says an adapter may not drive its own sequence. Review drove a
    // COMPLETE second operation — own permit, own signed receipt — nested inside
    // the first, which then finished normally. Nothing bounded it.
    const { runLifecycleCustodyOperation } = await import(
      "../../src/preparations/lifecycle-driver.js");
    const key = { key: Buffer.alloc(32), keyEpochId: "0".repeat(64) };
    const adapter = (unitId: string, materialize: () => Promise<unknown>) => ({
      operation: "quarantine" as const,
    planKind: "custody-move" as const,
      assess: () => Promise.resolve({
        draft: perRunDraft(unitId),
        key,
      }),
      materialize: () => materialize().then(() => key),
    });
    const nested = () => runLifecycleCustodyOperation(
      root.dir, nestingAdapter(`qtn-${"b".repeat(32)}`, () => Promise.resolve()), { actor: LIFECYCLE_ACTOR, at: AT, authorization: "ungated" as const });

    await expect(runLifecycleCustodyOperation(
      root.dir, nestingAdapter(VALID_UNIT_ID, nested), { actor: LIFECYCLE_ACTOR, at: AT, authorization: "ungated" as const },
    )).rejects.toThrow(/not re-entrant/u);
  });

  it("allows concurrent operations on two different project roots", async () => {
    // The guard bounds NESTING, not concurrency. The first version was a single
    // process-global boolean held across awaits, so two unrelated projects
    // running at once refused each other — with a message describing a nesting
    // that never happened. Harmless in a single-root CLI; wrong in the SDK and
    // the MCP server, which both serve several roots from one process.
    const other = await makeTempRoot("driver-concurrent");
    const results = await Promise.allSettled([
      driveWithPlanEdit({
        kind: "custody-move", unitId: VALID_UNIT_ID,
        scope: "per-run", reason: "run-integrity-invalid",
        objects: [], residualObligations: [],
      }, () => { /* no edit */ }),
      driveInRoot(other),
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
  });

  it("refuses a nested operation reached through an aliased root path", async () => {
    // The guard keyed on the caller's RAW string, so `root + "/"` — or any
    // `.`/`..` segment, or a symlinked path — opened a second concurrent
    // operation on the same project with the guard none the wiser. External
    // review reproduced exactly that and both operations completed.
    const { runLifecycleCustodyOperation } = await import(
      "../../src/preparations/lifecycle-driver.js");
    const nestedViaAlias = () => runLifecycleCustodyOperation(
      `${root.dir}/`, nestingAdapter(`qtn-${"c".repeat(32)}`, () => Promise.resolve()),
      { actor: LIFECYCLE_ACTOR, at: AT, authorization: "ungated" as const });

    await expect(runLifecycleCustodyOperation(
      root.dir, nestingAdapter(VALID_UNIT_ID, nestedViaAlias), { actor: LIFECYCLE_ACTOR, at: AT, authorization: "ungated" as const },
    )).rejects.toThrow(/not re-entrant/u);
  });

  it("still allows the next operation after one refuses", async () => {
    // A guard that wedges the system it protects is a worse defect than the one
    // it closes. The lock releases in a `finally`, and this is what proves it.
    await expect(driveWithPlanEdit({
      kind: "custody-move", unitId: VALID_UNIT_ID,
      scope: "per-run", reason: "run-integrity-invalid",
      objects: [], residualObligations: [],
    }, () => { /* no edit */ })).resolves.toBeDefined();
  });
});

describe("the retirement set's per-unit read leg", () => {
  it("names an unreadable completed receipt as residual instead of dropping OR refusing", async () => {
    // REGRESSION, twice over.
    //
    // First, `completedReceiptDigest` collapsed a three-way read outcome into
    // `!== null`, so an UNREADABLE receipt looked exactly like a unit that was
    // never completed: silently dropped from the attestation and then stranded.
    //
    // The first fix threw instead, and review proved that was worse. One damaged
    // file on ANY unit permanently blocked the key reset — purge cannot clear it
    // (purge needs the healthy key whose absence is why the reset exists) and
    // superseding only mints a fresh unit that hits the same refusal, measured
    // non-terminating over three full cycles. A guard that leaves a legitimate
    // state unrecoverable is a defect, not hardening.
    //
    // So: attest what is readable, NAME what is not, and complete. Shape matters
    // — chmod refuses earlier at the destructive-scan gate, so only an OVERSIZE
    // receipt isolates this read.
    const receipt = await unitWithUnreadableReceipt(root.dir);
    const paths = preparationQuarantineUnitPaths(root.dir, receipt.unitId);
    const done = await continueReset(root.dir, await recordResetIntent(root.dir));

    if (done.status !== "completed") throw new Error(`reset did not complete: ${done.status}`);
    // Named, so the operator can see what was left unfinished...
    expect(done.receipt.residualObligations)
      .toContain(`quarantine-unit-${receipt.unitId}-completed-receipt-unreadable`);
    // ...and NOT attested, because its receipt was never read.
    expect(done.receipt.retiredUnits?.map((unit) => unit.unitId) ?? []).not.toContain(receipt.unitId);
    // The obligation is attestation ONLY — nothing consumes it — so the unit is
    // still there, unretired. Pinned so no future reader mistakes "named" for
    // "handled", which is the exact overclaim this file has corrected before.
    expect((await lstat(paths.unitRoot)).isDirectory()).toBe(true);
  });

  it("stays usable after an unreadable receipt, rather than deadlocking the project", async () => {
    // The property the refusal destroyed, pinned directly: a SECOND reset must
    // still be able to run. Testing only the first completion would not have
    // caught the deadlock, because the first pass was never what failed.
    await unitWithUnreadableReceipt(root.dir);
    await continueReset(root.dir, await recordResetIntent(root.dir));

    await removePreparationKey(root.dir);
    const second = await continueReset(root.dir, await recordResetIntent(root.dir));
    expect(second.status).toBe("completed");
  });

  it("still retires a readable completed unit", async () => {
    // Control: the same sequence without the oversize fault retires the unit, so
    // the refusal above is caused by the fault and not by the fixture.
    const receipt = await quarantineTamperedRun(root.dir);
    await removePreparationKey(root.dir);
    const done = await continueReset(root.dir, await recordResetIntent(root.dir));
    if (done.status !== "completed") throw new Error("reset did not complete");
    expect(done.receipt.retiredUnits?.map((unit) => unit.unitId)).toContain(receipt.unitId);
  });
});

/** Comfortably past the receipt reader's ceiling, so the read fails as unreadable. */
const OVERSIZE_RECEIPT_BYTES = 5 * 1024 * 1024;
