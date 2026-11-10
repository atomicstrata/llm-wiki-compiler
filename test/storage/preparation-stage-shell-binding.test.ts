/**
 * @file test/storage/preparation-stage-shell-binding.test.ts
 * @description The `stage` and `preview` operations' SHELLS as ONE body each
 * over steps that take no project root: `stagePreparationOperationWith` over
 * `StageOperationSteps` and `previewPreparationOperationWith` over
 * `StageShellSteps`. This file uses them, which exist only after each shell was
 * given its steps, so it has NO before-edit run.
 *
 * HOW IT IS BUILT. Memory steps and memory documents log every call, so the
 * capture, the preflight, the two documents, the lock's acquire/release
 * pairing (stage only) and the one publication are pinned in order, with the
 * request the shell builds field by field. The composition is shown reaching
 * the preflight's own body, and the root forms every incumbent with exact
 * arguments.
 *
 * NOT SHOWN HERE: the publication's own decision body, `stagePreparationLocked`,
 * which this binding does NOT bind (a residual), nor the plan and seed grammars;
 * the stage, preview-purity and plan suites show those.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import * as lockGate from "../../src/operation-bundles/lock-gate.js";
import * as preview from "../../src/preparations/preview.js";
import * as readiness from "../../src/preparations/service-readiness.js";
import {
  previewPreparationOperation, previewPreparationOperationWith, stagePreparationOperation, stagePreparationOperationWith,
  stageShellStepsOver, type StageOperationSteps,
} from "../../src/preparations/service-stage.js";
import * as stage from "../../src/preparations/stage.js";
import * as lock from "../../src/utils/lock.js";
import { SEED_VALUE, fixturePlan } from "../preparations/store-fixture.js";
import { orderedStubs } from "./call-log.js";

afterEach(() => { vi.restoreAllMocks(); });

const PRINCIPAL = { id: "operator", surface: "cli", grants: [] } as never;
const STAGED = { status: "staged", manifest: { runId: "prr_1", workspaceId: "ws" } } as never;

/** What the memory steps answer. */
interface World { blocked?: string; acquire?: boolean | Error; published?: unknown; plan?: string }

/** Memory steps and documents over `world`, each call logged; the published requests are kept. */
function harness(world: World = {}) {
  const log: string[] = [], published: unknown[] = [];
  const steps: StageOperationSteps = {
    preflightRefusal: async () => { log.push("preflight"); return world.blocked ?? null; },
    publish: async (request) => { log.push(`publish dryRun=${String(request.dryRun ?? false)}`); published.push(request); return (world.published ?? STAGED) as never; },
    lock: {
      acquire: async () => { log.push("acquire"); if (world.acquire instanceof Error) throw world.acquire; return world.acquire ?? true; },
      release: async () => { log.push("release"); },
    },
  };
  const request = {
    documents: {
      plan: async () => { log.push("plan"); return { ok: true as const, text: world.plan ?? JSON.stringify(fixturePlan()) }; },
      seed: async () => { log.push("seed"); return { ok: true as const, text: JSON.stringify(SEED_VALUE) }; },
    },
    controlTransitionAllowance: 16,
  };
  return { log, published, steps, request };
}

describe("the stage shell over its steps", () => {
  it("S1 captures, preflights, reads both documents, takes the lock, publishes the field-built request once, then releases", async () => {
    const { log, published, steps, request } = harness();
    expect(await stagePreparationOperationWith(steps, PRINCIPAL, request)).toEqual({ status: "staged", runId: "prr_1", workspaceId: "ws" });
    expect(log).toEqual(["preflight", "plan", "seed", "acquire", "publish dryRun=false", "release"]);
    expect(published).toEqual([expect.objectContaining({
      createdBy: { id: "operator", surface: "cli" }, actor: { id: "operator", surface: "cli" }, controlTransitionAllowance: 16,
      initialInputs: [expect.objectContaining({ kind: "structured", source: expect.objectContaining({ value: SEED_VALUE, sourceIdentity: "cli-seed" }) })],
    })]);
  });

  it("S2 refuses a preflight block or a bad plan before the lock, and either lock refusal without publishing or releasing", async () => {
    const run = async (world: World) => {
      const { log, steps, request } = harness(world);
      return [await stagePreparationOperationWith(steps, PRINCIPAL, request), log];
    };
    expect(await run({ blocked: "key unreadable" })).toEqual([{ status: "refused", reason: "key unreadable" }, ["preflight"]]);
    expect((await run({ plan: "{" }))[1]).toEqual(["preflight", "plan"]);
    expect(await run({ acquire: false })).toEqual([{ status: "refused", reason: "project lock is busy" }, ["preflight", "plan", "seed", "acquire"]]);
    expect(await run({ acquire: new lockGate.RecoveryGateError("x" as never, "reset pending") }))
      .toEqual([{ status: "refused", reason: "reset pending" }, ["preflight", "plan", "seed", "acquire"]]);
  });

  it("S3 a parked publication is a refusal, and the lock is still released", async () => {
    const { log, steps, request } = harness({ published: { status: "parked", reason: "workflow-parent-absent" } });
    expect(await stagePreparationOperationWith(steps, PRINCIPAL, request)).toEqual({ status: "refused", reason: "staging refused: workflow-parent-absent" });
    expect(log.slice(-2)).toEqual(["publish dryRun=false", "release"]);
  });
});

describe("the preview shell over its steps", () => {
  it("P1 runs the same capture, preflight and documents, takes NO lock, and projects the answer without a run id", async () => {
    const { log, published, steps, request } = harness();
    expect(await previewPreparationOperationWith(steps, "mcp", request)).toEqual({ status: "previewed", workspaceId: "ws" });
    expect(log).toEqual(["preflight", "plan", "seed", "publish dryRun=false"]);
    expect(published).toEqual([expect.objectContaining({ actor: { id: "preview", surface: "mcp" } })]);
  });
});

describe("the composition and the root forms", () => {
  it("B1 the composition reaches the preflight's own body over its seam and carries the caller's publication", async () => {
    const reads = { tag: "readiness" } as never;
    const from = vi.spyOn(readiness, "preparationPreflightRefusalFrom").mockResolvedValue(null);
    const publish = vi.fn();
    const shell = stageShellStepsOver(reads, publish);
    expect([await shell.preflightRefusal(), from.mock.calls, shell.publish]).toEqual([null, [[reads]], publish]);
  });

  it("B2 the stage root form reaches the incumbent preflight, lock and durable publication with exact arguments, in order", async () => {
    const { order, note } = orderedStubs();
    const pre = vi.spyOn(readiness, "preparationPreflightRefusal").mockImplementation(note("preflight", null));
    const acquire = vi.spyOn(lockGate, "acquireMutationLock").mockImplementation(note("acquire", true));
    const locked = vi.spyOn(stage, "stagePreparationLocked").mockImplementation(note("publish", STAGED));
    const release = vi.spyOn(lock, "releaseLock").mockImplementation(note("release", undefined));
    const { request } = harness();
    expect((await stagePreparationOperation("/project", PRINCIPAL, request)).status).toBe("staged");
    expect([order, pre.mock.calls, acquire.mock.calls, locked.mock.calls[0]?.[0], release.mock.calls]).toEqual([
      ["preflight", "acquire", "publish", "release"], [["/project"]], [["/project", "ordinary"]], "/project", [["/project"]],
    ]);
  });

  it("B3 the preview root form reaches the incumbent preflight and dry-run publication, and never the lock", async () => {
    const pre = vi.spyOn(readiness, "preparationPreflightRefusal").mockResolvedValue(null);
    const dry = vi.spyOn(preview, "previewPreparation").mockResolvedValue(STAGED);
    const acquire = vi.spyOn(lockGate, "acquireMutationLock");
    const { request } = harness();
    expect((await previewPreparationOperation("/project", "cli", request)).status).toBe("previewed");
    expect([pre.mock.calls, dry.mock.calls[0]?.[0], acquire.mock.calls]).toEqual([[["/project"]], "/project", []]);
  });
});
