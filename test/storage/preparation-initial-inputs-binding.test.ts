/**
 * @file test/storage/preparation-initial-inputs-binding.test.ts
 * @description Initial-input materialization as ONE body over its two writes,
 * `materializePlannedInitialInputsWith` over `InitialInputMaterializeSteps`, with
 * no project directory. This file uses it, which exists only after the body was
 * given its steps, so it has NO before-edit run.
 *
 * HOW IT IS BUILT. Two structured inputs are PLANNED by the real planner (which
 * reads no project) and one planned caller file is added beside them; memory
 * steps log each write, so the digest order, the missing-only filter, the kind
 * dispatch and the first-refusal stop are pinned. The composition is shown
 * reaching the evidence writer's own body, and the root form reaching the
 * incumbent writers with exact arguments.
 *
 * NOT SHOWN HERE: the caller-file copy and recheck themselves, and the evidence
 * CAS; the inputs and evidence-store suites show those.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import * as evidenceStore from "../../src/preparations/evidence-store.js";
import {
  initialInputMaterializeStepsOver, materializePlannedInitialInputs, materializePlannedInitialInputsWith, planInitialInputs,
  type InitialInputMaterializeSteps, type PlannedInitialInputSetV1,
} from "../../src/preparations/initial-inputs.js";
import * as inputs from "../../src/preparations/inputs.js";
import { seedInput } from "../preparations/store-fixture.js";

afterEach(() => { vi.restoreAllMocks(); });

const LOCATION = { workspaceId: "ws", preparationId: "prep_1" } as never;
/** A planned caller file sorting between nothing and everything: its digest is all zeros. */
const CALLER_DIGEST = "0".repeat(64);
const CALLER = { kind: "caller-file", bareDigest: CALLER_DIGEST, byteCount: 3, input: {}, file: { tag: "caller" } };

/** The real planner's set for two structured seeds, plus one planned caller file; and the structured digests in order. */
async function plannedSet(): Promise<{ set: PlannedInitialInputSetV1; structured: string[] }> {
  const planned = await planInitialInputs([seedInput(), seedInput({ value: { other: 1 } })]);
  if (planned.status !== "planned") throw new Error("the seeds did not plan");
  const structured = planned.set.planned.map((item) => item.bareDigest).sort();
  return { set: { ...planned.set, planned: [...planned.set.planned, CALLER as never] }, structured };
}

/** Memory steps logging each write; the caller file answers `callerOutcome`. */
function stepsOf(log: string[], callerOutcome: unknown = { status: "materialized" }): InitialInputMaterializeSteps {
  return {
    writeStructured: async (_location, bytes) => { log.push(`structured ${bytes.byteLength}`); return "created"; },
    materializeCallerFile: async (_location, file) => { log.push(`caller ${(file as unknown as { tag: string }).tag}`); return callerOutcome as never; },
  };
}

describe("initial-input materialization over its steps", () => {
  it("I1 writes only the missing inputs, in digest order, each through its own kind's write", async () => {
    const { set, structured } = await plannedSet();
    const log: string[] = [];
    const outcome = await materializePlannedInitialInputsWith(stepsOf(log), LOCATION, set, new Set([CALLER_DIGEST, structured[1]!]));
    expect(outcome).toEqual({ status: "materialized" });
    expect(log).toEqual(["caller caller", expect.stringMatching(/^structured \d+$/)]);
  });

  it("I2 the first caller-file refusal stops: no later input is written", async () => {
    const { set, structured } = await plannedSet();
    const log: string[] = [];
    const refused = { status: "unavailable", code: "changed-digest" };
    const outcome = await materializePlannedInitialInputsWith(stepsOf(log, refused), LOCATION, set, new Set([CALLER_DIGEST, ...structured]));
    expect([outcome, log]).toEqual([refused, ["caller caller"]]);
  });

  it("I3 nothing missing writes nothing", async () => {
    const { set } = await plannedSet();
    const log: string[] = [];
    expect([await materializePlannedInitialInputsWith(stepsOf(log), LOCATION, set, new Set()), log]).toEqual([{ status: "materialized" }, []]);
  });
});

describe("the composition and the root form", () => {
  it("B1 the composition writes structured inputs through the evidence writer's own body, and carries the caller's caller-file step", async () => {
    const { set, structured } = await plannedSet();
    const writes = { tag: "writes" } as never;
    const body = vi.spyOn(evidenceStore, "writePreparationEvidenceCreateOnlyWith").mockResolvedValue("created");
    const caller = vi.fn(async () => ({ status: "materialized" as const }));
    await materializePlannedInitialInputsWith(initialInputMaterializeStepsOver(writes, caller), LOCATION, set, new Set([structured[0]!, CALLER_DIGEST]));
    expect([body.mock.calls.map((call) => call.slice(0, 2)), caller.mock.calls]).toEqual([[[writes, LOCATION]], [[LOCATION, CALLER.file]]]);
  });

  it("B2 the root form reaches the incumbent writers with its root, in digest order", async () => {
    const { set, structured } = await plannedSet();
    const order: string[] = [];
    const write = vi.spyOn(evidenceStore, "writePreparationEvidenceCreateOnly").mockImplementation(async () => { order.push("structured"); return "created"; });
    const caller = vi.spyOn(inputs, "materializeCallerFileInput").mockImplementation(async () => { order.push("caller"); return { status: "materialized" }; });
    await materializePlannedInitialInputs("/project", LOCATION, set, new Set([CALLER_DIGEST, ...structured]));
    expect([order, write.mock.calls.map((call) => call.slice(0, 2)), caller.mock.calls]).toEqual([
      ["caller", "structured", "structured"], [["/project", LOCATION], ["/project", LOCATION]], [["/project", LOCATION, CALLER.file]],
    ]);
  });
});
