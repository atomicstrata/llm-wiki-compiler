/**
 * @file test/operations-packs/host-runtime-execute.test.ts
 * @description The WOP V3 slice 3C executable host-handler registry: a compiled
 * pack action's phase actually COMPUTES. Slice 3A's registry resolved every ref
 * to a handler that always returned `host-handler-runtime-unavailable`, which
 * settles the phase `failed` and makes handoff unreachable; these cases assert
 * the real content the families now produce over the run's frozen action input,
 * and the fixed-code refusals for every input or family the runtime cannot serve.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseSha256Digest } from "../../src/capability-providers/ids.js";
import { compilePackAction } from "../../src/operations-packs/compiler.js";
import { hostHandlerRefFor } from "../../src/operations-packs/handlers/registry.js";
import { createPackHostHandlerRegistry } from "../../src/operations-packs/runtime/host-registry.js";
import type { CompiledPackActionV1 } from "../../src/operations-packs/compiler-types.js";
import type {
  HostHandlerInvocationV1, HostHandlerResultV1,
} from "../../src/preparations/attempts/types.js";
import { deriveAttemptId, derivePhaseInstanceId, singleExpansionIdentity } from "../../src/preparations/ids.js";
import type { PreparationRunBinding } from "../../src/preparations/run-types.js";
import { multiSourcePaperRequest } from "./compile-fixture.js";
import {
  compileActionInputRenderAction, compileMultiSourceRenderAction, compileChainedAction, compileSingleIntentAction, compileTwoPhasePaperAction,
} from "./runtime-fixture.js";

/** A well-formed manifest digest; only the phase-instance derivation reads it. */
const MANIFEST = parseSha256Digest(`sha256:${"c".repeat(64)}`);
const PRINCIPAL = "pack-runtime";
const RUN_ID = "prr_00000000000000000000000000000001";

/**
 * A root with NO durable run and the binding it would be addressed by. These
 * isolated cases execute one phase over the frozen action input, so a phase with
 * no `phase-output` binding never reads them; the one case that binds a
 * predecessor output resolves it against this absent run and takes the fixed-code
 * refusal, which is exactly the "predecessor unreadable" leg under test.
 */
const NO_RUN_ROOT = "/pack-runtime-no-durable-run";
const NO_RUN_BINDING = {
  runId: RUN_ID, preparationId: "prp_00000000000000000000000000000001",
  manifestDigest: MANIFEST, workspaceId: "research",
} as unknown as PreparationRunBinding;

/** The invocation the attempt boundary would build for one logical phase. */
function invocationFor(logicalPhaseId: string): HostHandlerInvocationV1 {
  const phaseInstanceId = derivePhaseInstanceId({
    manifestDigest: MANIFEST, logicalPhaseId, expansionIdentity: singleExpansionIdentity(),
  });
  return {
    attemptId: deriveAttemptId(phaseInstanceId, 0), phaseInstanceId, leaseNonce: "nonce-1",
    inputExposureSetDigest: MANIFEST, maximumOutputBytes: 262_144, maximumWallTimeMs: 5_000,
  };
}

/** Execute one compiled action's named phase through the executable registry. */
function execute(action: CompiledPackActionV1, logicalPhaseId: string, family: string): Promise<HostHandlerResultV1> {
  const registry = createPackHostHandlerRegistry(action, {
    manifestDigest: MANIFEST, runId: RUN_ID, principal: PRINCIPAL,
    clock: { now: () => "2026-08-14T00:00:00.000Z" }, root: NO_RUN_ROOT, binding: NO_RUN_BINDING,
  });
  return registry.resolve(hostHandlerRefFor(family)).handler.execute(invocationFor(logicalPhaseId));
}

/** The single output object a completed result published, or a loud failure. */
function onlyOutput(result: HostHandlerResultV1) {
  if (result.kind !== "completed") throw new Error(`not completed: ${JSON.stringify(result)}`);
  const output = result.outputs[0];
  if (output === undefined || result.outputs.length !== 1) throw new Error("expected exactly one output");
  return output;
}

describe("pack host-handler runtime: intent-compile", () => {
  it("publishes the REAL drafts compiled from the frozen action input", async () => {
    const action = await compileSingleIntentAction();
    const output = onlyOutput(await execute(action, "propose", "intent-compile"));
    const result = JSON.parse(await readFile(output.sourcePath, "utf8"));

    expect(result.drafts.every((draft: { mutationKind: string }) => draft.mutationKind === "artifact-upsert")).toBe(true);
    expect(result.intentTemplateRef).toBe("intent.wiki-artifact");
    expect(result.drafts).toHaveLength(1);
    // The title is the CALLER's input value, threaded through the sealed input
    // bytes into the evidence item the family read — not a fixture constant.
    expect(result.drafts[0]).toMatchObject({
      sourceItemId: "action-input", mutationKind: "artifact-upsert", targetProfileClass: "wiki-page",
      fields: { title: "superconductivity", revision: 1, author: PRINCIPAL },
    });
  });

  it("describes the published bytes exactly: digest, byte count, and media type", async () => {
    const action = await compileSingleIntentAction();
    const output = onlyOutput(await execute(action, "propose", "intent-compile"));
    const bytes = await readFile(output.sourcePath);

    expect(output.digest).toBe(`sha256:${createHash("sha256").update(bytes).digest("hex")}`);
    expect(output.byteCount).toBe(bytes.byteLength);
    expect(output.mediaType).toBe("application/json");
    expect(output.provenanceLabel).toBe("pack-intent-compile-output");
  });

  it("carries the declared default alongside the caller value in one evidence item", async () => {
    // `depth` is never mapped into a draft, but it IS part of the frozen input, so
    // its presence proves the decode carried the WHOLE resolved input record.
    const action = await compileSingleIntentAction();
    expect(JSON.parse(action.initialInput.bytes.toString("utf8"))).toEqual({
      topic: "superconductivity", depth: 2,
    });
  });
});

describe("pack host-handler runtime: a second family and the closed refusals", () => {
  it("executes context-assemble over the same action input", async () => {
    const action = await compileChainedAction();
    const output = onlyOutput(await execute(action, "assemble", "context-assemble"));
    const result = JSON.parse(await readFile(output.sourcePath, "utf8"));

    expect(result.eligibilityPolicyId).toBe("context.default");
    // The action-input item declares no `evidenceClass`, so the family excludes it
    // by its own eligibility rule — a real computed verdict, not an empty result.
    expect(result.selection.excluded).toEqual([{ itemId: "action-input", reason: "ineligible-class" }]);
    expect(result.itemCount).toBe(0);
  });

  it("REFUSES a phase-output binding whose predecessor run is unreadable", async () => {
    // `propose` binds the render phase's output. Executed in isolation over the
    // NO_RUN root, the predecessor's committed evidence cannot be read, so the
    // phase-output resolution fails closed rather than substituting empty evidence.
    // (The chained SUCCESS path — where the predecessor really ran — is proven end
    // to end in pack-chaining-drive.test.ts.)
    const action = await compileChainedAction();
    const result = await execute(action, "propose", "intent-compile");

    expect(result).toMatchObject({ kind: "failed", problem: "pack-phase-output-input-deferred" });
  });

  it("REFUSES a phase-output binding whose predecessor is not a single expansion", async () => {
    // Multi-instance predecessors are out of G1's scope: which instance's output
    // a successor should read is undefined, so the resolution refuses BY NAME
    // before any run read — the detail discriminates it from the unreadable leg.
    const action = await compileTwoPhasePaperAction({ topic: "superconductivity", doi: "10.1/abc" });
    const phases = action.plan.phases.map((phase) => phase.logicalPhaseId !== "pick" ? phase : {
      ...phase,
      expansion: {
        kind: "map", sourceEvidenceBinding: "candidate", maximumItems: 2,
        itemIdentity: "host-id", duplicateDisposition: "fail", overflowDisposition: { kind: "fail-closed" },
      },
    });
    const mutated = { ...action, plan: { ...action.plan, phases } } as CompiledPackActionV1;
    const result = await execute(mutated, "propose", "intent-compile");

    expect(result).toMatchObject({ kind: "failed", problem: "pack-phase-output-input-deferred" });
    expect(result.kind === "failed" && result.detail).toMatch(/not a single expansion/);
  });

  it("RENDERS the last once-deferred family through its compile-resolved template", async () => {
    // No family is deferred any more: the compiler resolved the pack-shipped
    // template onto the action, so the render phase computes without any
    // registry lookup — and publishes the wrapped output item a successor chains.
    const action = await compileActionInputRenderAction();
    const result = await execute(action, "index", "render-template");

    expect(result.kind).toBe("completed");
  });

  it("refuses a near-ceiling render as its OWN bounds refusal, at the wrap site", async () => {
    // The output ceiling binds what the family PUBLISHES — the wrapped record.
    // 150 bytes: the unwrapped handler result fits, the wrapped one does not, so
    // the refusal must be this family's own bounds refusal where the contract
    // lives, never a downstream recustody failure in the admission leg.
    const action = await compileActionInputRenderAction(150);
    const result = await execute(action, "index", "render-template");

    expect(result).toMatchObject({ kind: "failed", problem: "pack-family-refused" });
    expect(result.kind === "failed" && result.detail).toMatch(/exceeds/);
  });

  it("fails closed on a phase instance the compiled action never bound", async () => {
    const action = await compileSingleIntentAction();
    const registry = createPackHostHandlerRegistry(action, {
      manifestDigest: MANIFEST, runId: RUN_ID, principal: PRINCIPAL,
      clock: { now: () => "2026-08-14T00:00:00.000Z" }, root: NO_RUN_ROOT, binding: NO_RUN_BINDING,
    });
    const stranger = { ...invocationFor("propose"), phaseInstanceId: `phi_${"d".repeat(64)}` as const };
    const result = await registry.resolve(hostHandlerRefFor("intent-compile")).handler.execute(stranger);

    expect(result).toMatchObject({ kind: "failed", problem: "pack-phase-not-bound" });
  });

  it("keeps 3A's drift refusals: a drifted contract digest never resolves", async () => {
    const action = await compileSingleIntentAction();
    const registry = createPackHostHandlerRegistry(action, {
      manifestDigest: MANIFEST, runId: RUN_ID, principal: PRINCIPAL,
      clock: { now: () => "2026-08-14T00:00:00.000Z" }, root: NO_RUN_ROOT, binding: NO_RUN_BINDING,
    });
    const drifted = { ...hostHandlerRefFor("intent-compile"), handlerContractDigest: MANIFEST };

    expect(() => registry.resolve(drifted)).toThrow(/contract digest drift/);
  });
});

describe("G4a registry semantics over a multi-source input", () => {
  it("keeps the render frame from the input's SCALAR fields when no action-input item exists", async () => {
    // The doi column decodes to source items — there is no `action-input` item —
    // yet the top-level `field topic` node must still render the shared frame.
    const action = await compileMultiSourceRenderAction({ topic: "superconductivity", doi: ["10.1/a", "10.1/b"] });
    const output = onlyOutput(await execute(action, "index", "render-template"));
    const published = JSON.parse(await readFile(output.sourcePath, "utf8")) as { output: string };
    expect(published.output).toBe("# superconductivity\n- superconductivity\n- superconductivity\n");
  });

  it("refuses list columns that disagree on length with the public mismatch code", async () => {
    const base = multiSourcePaperRequest({ topic: "t", doi: ["10.1/a", "10.1/b"] });
    const action = await compilePackAction({
      ...base,
      input: { ...base.input, url: ["only-one"] },
      pack: {
        ...base.pack,
        actions: {
          "demo.run": {
            ...base.pack.actions["demo.run"]!,
            inputSchema: {
              ...base.pack.actions["demo.run"]!.inputSchema,
              url: { kind: "string-list", required: true, overridable: true, sensitivityDisplay: "normal", maxItems: 8, maxItemBytes: 256 },
            },
          },
        },
      },
    });
    const result = await execute(action, "pick", "set-select");
    expect(result).toMatchObject({ kind: "failed", problem: "pack-input-list-length-mismatch" });
  });
});
