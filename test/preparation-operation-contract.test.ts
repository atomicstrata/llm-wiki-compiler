/**
 * @file test/preparation-operation-contract.test.ts
 * @description The aggregate contract gate over the closed FOURTEEN operations:
 * the set itself, the grant each one charges, and which surfaces expose it.
 *
 * THE SET IS QUOTED FROM THE PLAN, NEVER COMPUTED. The reconciled contract says
 * "twelve uniform operations + `reset` (CLI-only) + `fail` = fourteen", and
 * `PLAN_OPERATIONS` below is that sentence written out. Deriving the expected
 * set from the code and comparing it to itself is the failure this whole file
 * would otherwise be: a control that certifies whatever it was given. The DERIVED
 * side comes from the service's own closure map, the commander registry and the
 * constructed SDK facade; the DECLARED side comes from the document. They are
 * two authorities, and the comparison between them is the control.
 *
 * THE GRANTS ARE MEASURED, NOT READ. `OPERATION_GRANT` is a table in
 * `service.ts`, and asserting that a table equals a copy of itself proves
 * nothing about what any operation charges. So each row is established
 * BEHAVIOURALLY, twice: with an empty grant set the operation must refuse for
 * want of THIS grant, and holding exactly this grant it must not. Either half
 * alone is satisfied by code that refuses everything or authorizes everything,
 * and the mutation between them is one constructor field.
 *
 * THE CORRESPONDENCE IS THE POINT, and it is what "the table counts operations"
 * means in practice. Every operation is on both execution surfaces EXCEPT two,
 * and the two are opposite in kind:
 *
 *  - `handoff` — SDK/host-only (R-7). A CAPABILITY gap: its request carries
 *    host-authored compiled material with no textual operator form, so a CLI
 *    verb could only refuse. Enforced by nothing, and nothing should enforce it.
 *  - `reset` — CLI-only (D-10-14). A SECURITY boundary, enforced in the service,
 *    because its grant is the same token an SDK host legitimately holds.
 *
 * A THIRD asymmetry appearing here is drift, and it fails as drift rather than
 * being absorbed into a list. That is the whole reason both exclusions are
 * numbered decisions in the plan instead of comments in a facade.
 *
 * THE PARITY SCOPE IS DECLARED HERE AND DERIVED FROM THE ROW NUMBERS. v10 §5's
 * table is numbered, so "the twelve uniform operations" every parity clause
 * quantifies over is a membership fact to READ rather than a count to reproduce
 * — and reading it is what shows R-7's "minus `reset`" to be a no-op, since
 * reset is row 13 and was never inside that set. `fail` joins by R-10; see
 * `parityScope` for both, with reasons.
 *
 * WHAT THIS FILE DOES NOT COVER: parity itself — identical fixtures driven
 * through each surface and compared. That is 10.6's own gate, and this file
 * deliberately does not stand in for it. What it establishes is the two things
 * that gate rests on: WHICH operations are in scope, and that each surface
 * exposes exactly the operations the contract says it does.
 */

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerPreparationCommands } from "../src/cli/preparation-commands.js";
import { createPreparationService } from "../src/preparations/service.js";
import type {
  PreparationGrant, PreparationPrincipal, PreparationServiceV1,
} from "../src/preparations/service.js";
import { buildPreparationFacade } from "../src/sdk/preparation-facade.js";

/**
 * The marker for an operation whose grant is chosen by state the service has not
 * loaded, and is therefore charged inside the operation rather than at the door.
 */
const PER_GATE_KIND = "per-gate-kind" as const;

/** One row of the plan's operation table, as the plan states it. */
interface PlanOperationV1 {
  /** The service method name. */
  readonly operation: keyof PreparationServiceV1;
  /**
   * The v10 §5 table row this operation is, or `null` for one that has none.
   *
   * THE ROW NUMBER IS THE MEMBERSHIP FACT, and reading it rather than counting
   * is what settles which operations are "the twelve uniform operations" every
   * parity clause quantifies over. Rows **1–12** are the uniform twelve; **13**
   * is `reset`; `fail` has NO row, because it became official only through R-3,
   * after the table was written. Every set below is derived from this field —
   * a hand-copied twelve beside a numbered table is the divergence this program
   * has already paid for twice.
   */
  readonly planRow: number | null;
  /** The token it costs, `null` for grant-free, or the per-kind marker. */
  readonly grant: PreparationGrant | null | typeof PER_GATE_KIND;
  /** The `preparation <verb>` it registers, or `null` where it has none. */
  readonly cliVerb: string | null;
  /** The `Wiki` method that reaches it, or `null` where none does. */
  readonly sdkMethod: string | null;
}

/**
 * THE CLOSED FOURTEEN (reconciliation R-3, grants per D-10-13).
 *
 * Hand-written on purpose: it is the DOCUMENT's side of the comparison, so
 * deriving it would collapse the two authorities into one.
 */
const PLAN_OPERATIONS: readonly PlanOperationV1[] = [
  { operation: "preview", planRow: 1, grant: null, cliVerb: "preview", sdkMethod: "previewPreparation" },
  { operation: "list", planRow: 2, grant: null, cliVerb: "list", sdkMethod: "listPreparations" },
  { operation: "show", planRow: 3, grant: null, cliVerb: "show", sdkMethod: "showPreparation" },
  // §5 row 4 is `start`; R-2 renamed it to `stage` across all three surfaces to
  // match the substrate entry point it calls.
  { operation: "stage", planRow: 4, grant: "preparation.run", cliVerb: "stage", sdkMethod: "stagePreparation" },
  { operation: "gate", planRow: 5, grant: PER_GATE_KIND, cliVerb: "gate", sdkMethod: "gatePreparation" },
  { operation: "pause", planRow: 6, grant: "preparation.run", cliVerb: "pause", sdkMethod: "pausePreparation" },
  // THE SAME TOKEN AS `pause`, and that equality is a guarantee rather than a
  // coincidence: a paused run must be escapable by the least-privileged
  // principal that can pause it.
  { operation: "resume", planRow: 7, grant: "preparation.run", cliVerb: "resume", sdkMethod: "resumePreparation" },
  { operation: "cancel", planRow: 8, grant: "preparation.cancel", cliVerb: "cancel", sdkMethod: "cancelPreparation" },
  { operation: "recovery", planRow: 9, grant: "preparation.recovery", cliVerb: "recover", sdkMethod: "recoverPreparation" },
  // R-7: SDK/host-only. A capability gap, enforced by nothing.
  { operation: "handoff", planRow: 10, grant: "preparation.run", cliVerb: null, sdkMethod: "handoffPreparation" },
  { operation: "prune", planRow: 11, grant: "preparation.quarantine", cliVerb: "prune", sdkMethod: "prunePreparation" },
  { operation: "sweep", planRow: 12, grant: "preparation.quarantine", cliVerb: "sweep", sdkMethod: "sweepPreparations" },
  // R-3 made `fail` official: `planned -> failed` is the only terminal
  // transition the substrate can reach, and §5's table had no terminal verb.
  { operation: "fail", planRow: null, grant: "preparation.run", cliVerb: "fail", sdkMethod: "failPreparation" },
  // D-10-14: CLI-only, and the restriction is a SECURITY boundary enforced in
  // the service — see `preparation-reset-cli-only.test.ts`.
  { operation: "reset", planRow: 13, grant: "preparation.quarantine", cliVerb: "reset", sdkMethod: null },
];

/** A request superset: every field any operation reads, so none refuses on shape. */
const PROBE_REQUEST = {
  runId: `prr_${"a".repeat(32)}`,
  gateId: "review",
  decision: "approved",
  confirmation: "confirm-all-preparation-residual-state",
  documents: {},
  obligations: {},
};

let root = "";
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "prep-contract-")); });
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

/** The service as an SDK host holding exactly these grants constructs it. */
function sdkServiceWith(grants: readonly PreparationGrant[]): PreparationServiceV1 {
  const principal = { id: "contract-probe", surface: "sdk", grants } as PreparationPrincipal;
  return createPreparationService({
    root, surface: "sdk", principals: { principalFor: () => principal },
  });
}

/** How one invocation ended, keeping "refused for THIS grant" from every other end. */
type InvocationEndV1 = "missing-grant" | "other-throw" | "returned";

/**
 * Invoke one operation and classify only whether the GRANT check refused it.
 *
 * THREE ARMS, NOT TWO. Collapsing `other-throw` into `returned` would let an
 * operation that throws for an unrelated reason read as "the grant was
 * accepted", which is the absence-of-evidence relaxation this corpus keeps
 * paying for. Only `missing-grant` is positive evidence about the grant.
 */
async function invocationEnd(
  service: PreparationServiceV1, operation: keyof PreparationServiceV1,
): Promise<InvocationEndV1> {
  const method = service[operation] as (request?: unknown) => Promise<unknown>;
  try {
    await method(PROBE_REQUEST);
    return "returned";
  } catch (error) {
    return (error as { code?: string }).code === "missing-grant" ? "missing-grant" : "other-throw";
  }
}

/** The `preparation` verbs the CLI registrar actually registers. */
function registeredVerbs(): string[] {
  const program = new Command();
  registerPreparationCommands(program);
  const group = program.commands.find((command) => command.name() === "preparation");
  if (group === undefined) throw new Error("the preparation command group is not registered");
  return group.commands.map((command) => command.name()).sort();
}

/** The methods the SDK facade actually exposes. */
function facadeMethods(): string[] {
  return Object.keys(buildPreparationFacade(root, async (fn) => fn(), { id: "sdk", grants: [] })).sort();
}

/** The declared members of one column, sorted. */
function declared(column: "cliVerb" | "sdkMethod"): string[] {
  return PLAN_OPERATIONS.map((row) => row[column]).filter((name): name is string => name !== null).sort();
}

describe("the service exposes exactly the fourteen the contract names", () => {
  it("matches the plan's operation set, derived against declared", () => {
    const service = sdkServiceWith([]);
    expect(Object.keys(service).sort())
      .toEqual(PLAN_OPERATIONS.map((row) => row.operation).sort());
  });

  it("names fourteen rows, and the count is the plan's own sentence", () => {
    // ANTI-VACUITY for the comparison above: both sides are lists, so a
    // derivation that silently produced an empty one would satisfy `toEqual`
    // against an equally empty declaration.
    expect(PLAN_OPERATIONS).toHaveLength(14);
    expect(new Set(PLAN_OPERATIONS.map((row) => row.operation)).size).toBe(14);
  });
});

describe("each operation charges the grant the contract assigns it", () => {
  const charged = PLAN_OPERATIONS.filter(
    (row): row is PlanOperationV1 & { grant: PreparationGrant } =>
      row.grant !== null && row.grant !== PER_GATE_KIND,
  );

  it.each(charged)("refuses $operation without $grant", async ({ operation }) => {
    expect(await invocationEnd(sdkServiceWith([]), operation)).toBe("missing-grant");
  });

  it.each(charged)("accepts $operation holding exactly $grant", async ({ operation, grant }) => {
    // THE OTHER HALF, and it is what makes the refusals above evidence about
    // THIS token rather than about authorization in general.
    expect(await invocationEnd(sdkServiceWith([grant]), operation)).not.toBe("missing-grant");
  });

  it("charges nothing at the door for the grant-free reads and the gate", async () => {
    const service = sdkServiceWith([]);
    const marked = PLAN_OPERATIONS.filter((row) => row.grant === null || row.grant === PER_GATE_KIND);
    // `gate` is here with the reads and is NOT one of them: it charges
    // `GATE_GRANT[gateKind]` inside `authorGateProof`, against the kind it
    // loaded from the authenticated plan, which is check and executor at one
    // point. The marker records that the charge happens there.
    expect(marked.map((row) => row.operation).sort()).toEqual(["gate", "list", "preview", "show"]);
    for (const row of marked) {
      expect(await invocationEnd(service, row.operation)).not.toBe("missing-grant");
    }
  });
});

/** The highest v10 §5 row that is one of the uniform operations. */
const LAST_UNIFORM_ROW = 12;

/** Operations in cross-surface EXECUTION parity, derived from the rows (R-10). */
function parityScope(): string[] {
  return PLAN_OPERATIONS
    // THE UNIFORM TWELVE, from the row numbers — never a second hand-written
    // list beside the numbered table. `reset` is row 13 and drops out here by
    // NON-MEMBERSHIP rather than by subtraction; R-7's "minus `reset`" reads as
    // though reset were inside this set, and it never was.
    .filter((row) => (row.planRow !== null && row.planRow <= LAST_UNIFORM_ROW)
      // PLUS `fail`, by R-10 (2026-08-10). It has no §5 row at all, so the
      // strict reading of clauses written before it existed drops it — which
      // would assert a non-uniformity that is not true: it is on both execution
      // surfaces, takes a `{runId}` request like its neighbours, and is uniform
      // in every respect this gate measures. Its absence from the twelve is an
      // accident of discovery order, not a property.
      || row.operation === "fail")
    // MINUS `handoff` (R-7): SDK/host-only, a CAPABILITY gap rather than a
    // boundary, because no textual operator form for its obligation set exists.
    .filter((row) => row.cliVerb !== null && row.sdkMethod !== null)
    .map((row) => row.operation)
    .sort();
}

describe("cross-surface execution parity has the scope R-10 ratified", () => {
  it("covers the uniform twelve plus `fail`, minus `handoff`", () => {
    expect(parityScope()).toEqual([
      "cancel", "fail", "gate", "list", "pause", "preview", "prune", "recovery",
      "resume", "show", "stage", "sweep",
    ]);
  });

  it("excludes `reset` and `handoff`, for reasons that are not the same reason", () => {
    // TWO EXCLUSIONS, TWO MECHANISMS, and conflating them is what R-7 and R-8
    // each guarded against in their own way. `reset` is not in the uniform set
    // at all (row 13, CLI-only by a SECURITY boundary enforced in the service);
    // `handoff` is in it and is removed for want of a second surface.
    //
    // THIS CASE IS LOAD-BEARING AND THE PARITY LIST ABOVE IS NOT, which was
    // established by a mutant rather than by reading. Renumbering `reset` into
    // the twelve leaves `parityScope()` UNCHANGED — the second filter drops it
    // anyway, for want of an SDK method — so reset's exclusion is
    // over-determined in the derivation and the scope list alone cannot tell the
    // two mechanisms apart. The assertions below are what discriminate, and the
    // renumbering mutant reddens exactly them.
    expect(parityScope()).not.toContain("reset");
    expect(parityScope()).not.toContain("handoff");
    const uniform = PLAN_OPERATIONS.filter(
      (row) => row.planRow !== null && row.planRow <= LAST_UNIFORM_ROW).map((row) => row.operation);
    expect(uniform).toContain("handoff");
    expect(uniform).not.toContain("reset");
  });

  it("numbers the rows exactly as v10 §5 does, with `fail` outside the table", () => {
    // ANTI-VACUITY for every derivation above: they are all functions of
    // `planRow`, so a table whose rows drifted would compute a confident wrong
    // scope. The rows are 1..13 with no gaps and no repeats, and `fail` is the
    // one operation with none.
    const numbered = PLAN_OPERATIONS
      .map((row) => row.planRow).filter((row): row is number => row !== null).sort((a, b) => a - b);
    expect(numbered).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    expect(PLAN_OPERATIONS.filter((row) => row.planRow === null).map((row) => row.operation))
      .toEqual(["fail"]);
  });
});

describe("the surfaces expose exactly what the contract says", () => {
  it("registers the declared CLI verbs, derived from the commander registry", () => {
    expect(registeredVerbs()).toEqual(declared("cliVerb"));
  });

  it("exposes the declared SDK methods, derived from the constructed facade", () => {
    expect(facadeMethods()).toEqual(declared("sdkMethod"));
  });

  it("has EXACTLY TWO asymmetries, and each points the opposite way", () => {
    // THE CORRESPONDENCE THE OPERATION TABLE IS COUNTED FOR. A third asymmetry
    // is drift and fails here as drift; it does not get absorbed into a list.
    // Both exclusions are numbered plan decisions precisely so that a future one
    // has to be argued rather than added.
    const cliOnly = PLAN_OPERATIONS.filter((row) => row.sdkMethod === null).map((row) => row.operation);
    const sdkOnly = PLAN_OPERATIONS.filter((row) => row.cliVerb === null).map((row) => row.operation);
    expect(cliOnly).toEqual(["reset"]);
    expect(sdkOnly).toEqual(["handoff"]);
    // And every other operation is on BOTH — stated positively, because the two
    // assertions above are also satisfied by a table where nothing is anywhere.
    const both = PLAN_OPERATIONS.filter((row) => row.cliVerb !== null && row.sdkMethod !== null);
    expect(both).toHaveLength(12);
  });
});
