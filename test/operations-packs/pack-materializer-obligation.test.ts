/**
 * @file test/operations-packs/pack-materializer-obligation.test.ts
 * @description The obligation the pack materializer authors, driven against a
 * REAL durable run whose terminal draft set is substituted case by case.
 *
 * THE SUBSTITUTION IS AT THE ONE SEAM THE MATERIALIZER READS. The run, its phase
 * summaries, its evidence references and its producing attempt are all the ones a
 * real drive produced; only the BYTES the runner would have read back for the
 * terminal phase are supplied per case. That is exactly the surface an intent
 * family controls, so each case is a fault a handler could actually cause.
 *
 * THE POSITIVE CASE IS LOAD-BEARING. Four of these cases assert a refusal, and a
 * refusal-only suite would stay green if the harness simply always threw. The
 * first case proves the same harness materializes a complete page-create
 * obligation, so every refusal below is attributable to the property it perturbs.
 */

import { afterEach, describe, expect, it } from "vitest";
import { runPreparation } from "../../src/index.js";
import { NoObligationError } from "../../src/preparations/materialization.js";
import {
  createPackMaterializer, PackMaterializationError,
} from "../../src/operations-packs/runtime/materializer.js";
import { assembleRunnerInput } from "../../src/operations-packs/runtime/runner-input.js";
import type { PackIntentDraftV1 } from "../../src/operations-packs/handlers/types.js";
import { createHash } from "node:crypto";
import { draftPayloadBytes } from "../../src/operations-packs/handlers/page-payload.js";
import { readPreparationRun } from "../../src/preparations/run-store.js";
import type { PreparationRunV1 } from "../../src/preparations/run-types.js";
import { runnerContext, stagedRunTracker, type StagedPackRunV1 } from "./runtime-fixture.js";

/** The terminal intent phase of the minimal single-intent recipe. */
const TERMINAL_PHASE_ID = "propose";

/** The one item identity the frozen action input decodes to. */
const ACTION_INPUT_ITEM_ID = "action-input";

const runs = stagedRunTracker();

afterEach(() => runs.cleanupAll());

/** One well-formed draft: the shape the intent family publishes, digest and all. */
function draftFor(sourceItemId: string, overrides: Partial<PackIntentDraftV1> = {}): PackIntentDraftV1 {
  const body = {
    mutationKind: "artifact-upsert" as const, targetProfileClass: "wiki-page",
    fields: { title: "superconductivity", revision: 1, author: "pack-runtime" },
  };
  return { sourceItemId, ...body, payloadDigest: `sha256:${createHash("sha256").update(draftPayloadBytes(body)).digest("hex")}`, ...overrides };
}

/**
 * One `artifact-update` draft whose payload digest binds its OWN kind.
 *
 * The digest folds the mutation kind, so overriding the kind on an upsert draft
 * would break the bind before the update path was ever reached — the failure
 * would look like a digest defect rather than the thing under test.
 */
function updateDraftFor(
  sourceItemId: string, expectedCurrent?: { digest: string; byteCount: number },
): PackIntentDraftV1 {
  const body = {
    mutationKind: "artifact-update" as const, targetProfileClass: "wiki-page",
    fields: { title: "superconductivity", revision: 1, author: "pack-runtime" },
  };
  return {
    sourceItemId, ...body,
    ...(expectedCurrent === undefined ? {} : { expectedCurrent }),
    payloadDigest: `sha256:${createHash("sha256").update(draftPayloadBytes(body)).digest("hex")}`,
  };
}

/** Drive one action to handoff and keep the durable run its attempts produced. */
async function driven(): Promise<{ run: StagedPackRunV1; durable: PreparationRunV1 }> {
  const run = await runs.stage();
  const result = await runPreparation(assembleRunnerInput(run.action, runnerContext(run)));
  expect(result.status, "reason" in result ? result.reason : result.status).toBe("handed-off");
  const read = await readPreparationRun(run.root, run.binding);
  if (read.status !== "ok") throw new Error(`run ${read.status}`);
  return { run, durable: read.run };
}

/** The read-back map the runner would supply if the phase had published `drafts`. */
function evidenceDeclaring(
  durable: PreparationRunV1, drafts: readonly unknown[],
): ReadonlyMap<string, Buffer> {
  const digest = durable.phaseSummaries
    .find((entry) => entry.logicalPhaseId === TERMINAL_PHASE_ID)?.outputEvidenceDigest;
  if (digest === undefined) throw new Error("driven run published no terminal output evidence");
  return new Map([[digest.replace("sha256:", ""), Buffer.from(JSON.stringify({ drafts }))]]);
}

/** Materialize one substituted draft set against the real durable run. */
function materializeWith(
  run: StagedPackRunV1, durable: PreparationRunV1, drafts: readonly unknown[],
): ReturnType<ReturnType<typeof createPackMaterializer>["materialize"]> {
  return createPackMaterializer(run.action)
    .materialize({ run: durable, evidence: evidenceDeclaring(durable, drafts) });
}

describe("pack materializer: the obligation it authors from terminal drafts", () => {
  it("emits a complete page-create target, proposal, and accept for one draft", async () => {
    const { run, durable } = await driven();

    const candidate = materializeWith(run, durable, [draftFor(ACTION_INPUT_ITEM_ID)]);
    const result = candidate.result as {
      targets: readonly { logicalIdentity: string; draft: Record<string, unknown> }[];
      proposals: readonly { targetLogicalIdentity?: string }[];
      reconciliations: readonly { decision: string }[];
    };
    expect(result.targets).toHaveLength(1);
    expect(result.targets[0]!.logicalIdentity).toBe("entity:wiki-page:action-input");
    expect(result.targets[0]!.draft.kind).toBe("page");
    expect(result.targets[0]!.draft.operation).toBe("create");
    expect(result.proposals[0]!.targetLogicalIdentity).toBe("entity:wiki-page:action-input");
    expect(result.reconciliations[0]!.decision).toBe("accept");
  });

  it("binds the postcondition to the payload it also hands over", async () => {
    const { run, durable } = await driven();

    const candidate = materializeWith(run, durable, [draftFor(ACTION_INPUT_ITEM_ID)]);
    const draft = (candidate.result as { targets: readonly { draft: Record<string, unknown> }[] })
      .targets[0]!.draft;
    const payloadRef = draft.payloadRef as string;

    // The honest-sourcing property, at the seam: the postcondition is the digest
    // of the bytes actually supplied, never a post-apply observation.
    expect(draft.postcondition).toEqual({
      digest: `sha256:${payloadRef}`, byteCount: candidate.payloads.get(payloadRef)!.byteLength,
    });
  });

  it("authors an UPDATE as operation `update`, preconditioned on the bytes it saw", async () => {
    const { run, durable } = await driven();
    const expected = { digest: "d".repeat(64), byteCount: 77 };
    const update = updateDraftFor(ACTION_INPUT_ITEM_ID, expected);
    const candidate = materializeWith(run, durable, [update]);
    const draft = (candidate.result as { targets: readonly { draft: Record<string, unknown> }[] })
      .targets[0]!.draft;
    // `update`, not `create` — and preconditioned on EXACTLY the bytes the draft
    // was computed against, which is what makes a stale edit park instead of
    // overwriting whatever the page became between proposal and apply.
    expect(draft.operation).toBe("update");
    // A page precondition is a digest STATE the manifest parser accepts; the
    // byte count rides the postcondition, not the precondition.
    expect(draft.precondition).toEqual({ kind: "digest", digest: `sha256:${expected.digest}` });
  });

  it("REFUSES an update draft that carries no precondition", async () => {
    const { run, durable } = await driven();
    const update = updateDraftFor(ACTION_INPUT_ITEM_ID);
    // Never downgraded to an absent-precondition create: that is a blind
    // overwrite of a page nobody reviewed.
    expect(() => materializeWith(run, durable, [update])).toThrow(/no precondition/);
  });

  it("declares NO OBLIGATION for a terminal phase that published zero drafts", async () => {
    const { run, durable } = await driven();

    // Still not an obligation — an obligation over nothing is not one — but a
    // distinct type, because "the store already holds everything" is not a
    // failure. The runner settles this arm without a bundle instead of refusing.
    expect(() => materializeWith(run, durable, [])).toThrow(NoObligationError);
  });

  it("REFUSES a draft naming an item the sealed action input never declared", async () => {
    const { run, durable } = await driven();

    // Witnesses that `planned` comes from the SEALED INPUT, not from the drafts:
    // derived from the survivors this set would be self-consistent and complete.
    expect(() => materializeWith(run, durable, [draftFor("invented-item")]))
      .toThrow(/never declared/);
  });

  it("REFUSES a draft whose payload digest does not bind its own fields", async () => {
    const { run, durable } = await driven();

    const forged = draftFor(ACTION_INPUT_ITEM_ID, { payloadDigest: `sha256:${"0".repeat(64)}` });
    expect(() => materializeWith(run, durable, [forged])).toThrow(/payload digest/);
  });

  it("authors a catalog append whose payload digest is known before apply", async () => {
    const { run, durable } = await driven();
    const body = {
      mutationKind: "catalog-append" as const, targetProfileClass: "wiki-page",
      fields: { source: "newsroom-retained-source/source@sha256:abc", digest: "sha256:abc" },
    };
    const catalog = {
      sourceItemId: ACTION_INPUT_ITEM_ID, ...body,
      payloadDigest: `sha256:${createHash("sha256").update(draftPayloadBytes(body)).digest("hex")}`,
    } as PackIntentDraftV1;
    const candidate = materializeWith(run, durable, [catalog]);
    const target = (candidate.result as { targets: readonly { draft: Record<string, unknown> }[] })
      .targets[0]!.draft;
    expect(target).toMatchObject({
      kind: "catalog-record", operation: "create",
      target: { logicalRecordId: ACTION_INPUT_ITEM_ID }, precondition: { kind: "absent" },
    });
    expect(target.postcondition).toEqual({ digest: catalog.payloadDigest });
  });

  it("REFUSES a truly apply-time-only mutation kind", async () => {
    const { run, durable } = await driven();
    const deferred = draftFor(ACTION_INPUT_ITEM_ID, { mutationKind: "projection-register" });
    expect(() => materializeWith(run, durable, [deferred])).toThrow(/cannot be authored/);
  });
});

describe("authoring a delete", () => {
  it("authors operation `delete` declaring ABSENCE, preconditioned on the bytes it saw", async () => {
    const { run, durable } = await driven();
    const expected = { digest: "e".repeat(64), byteCount: 41 };
    const body = {
      mutationKind: "artifact-delete" as const, targetProfileClass: "wiki-page",
      fields: { title: "superconductivity", revision: 1, author: "pack-runtime" },
    };
    const draft = {
      sourceItemId: ACTION_INPUT_ITEM_ID, ...body, expectedCurrent: expected,
      payloadDigest: `sha256:${createHash("sha256").update(draftPayloadBytes(body)).digest("hex")}`,
    } as PackIntentDraftV1;

    const candidate = materializeWith(run, durable, [draft]);
    const authored = (candidate.result as { targets: readonly { draft: Record<string, unknown> }[] })
      .targets[0]!.draft;
    expect(authored.operation).toBe("delete");
    // ABSENCE, not a digest: a delete produces no bytes, so claiming a
    // resulting digest would attest to something that will never exist.
    expect(authored.postcondition).toEqual({ kind: "absent" });
    // And it still says WHICH bytes it expected to remove, so a page that
    // changed between proposal and apply conflicts instead of vanishing.
    expect(authored.precondition).toEqual({ kind: "digest", digest: `sha256:${expected.digest}` });
  });
});
