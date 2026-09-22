/**
 * @file test/operations-packs/source-evidence-descriptor.test.ts
 * @description The plan-sealed source-evidence descriptor end to end (spec
 * §2.1 generic change 1): a provider phase declaring one receives the retained
 * source's BYTES and the inputId→path table, sealed columns and all.
 *
 * THE SUCCEEDING CASE IS LOAD-BEARING, exactly as in the routing suite: the
 * exposure digest the authority seals must equal the exposure of the specs the
 * host sends, and both sides now derive from the SHARED builder — so a drive to
 * `succeeded` proves seal, build, materialization, and comparison all agree on
 * real bytes. The refusal cases then perturb one property each.
 *
 * WHAT EACH REFUSAL WITNESSES:
 * - column mismatch → the COMPILER refuses and the plan never exists — zipping
 *   the shorter column would seal a digest belonging to another file;
 * - digest drift → a source EDITED AFTER APPROVAL fails the leg rather than
 *   feeding the provider different bytes under an approved digest.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { providerInputRecord } from "../../src/capability-providers/host/invocation.js";
import { createPackAuthorityResolver } from "../../src/operations-packs/runtime/authority-resolver.js";
import { derivePhaseInstanceId, singleExpansionIdentity } from "../../src/preparations/ids.js";
import { runPreparation } from "../../src/index.js";
import { compilePackAction } from "../../src/operations-packs/compiler.js";
import { assembleRunnerInput } from "../../src/operations-packs/runtime/runner-input.js";
import type {
  PackProviderInvocationV1, PackSourceEvidenceContextV1,
} from "../../src/operations-packs/runtime/runner-input.js";
import { completed } from "./completed-provider.js";
import type { PackRecipeV2, SourceEvidenceDescriptorV2 } from "../../src/operations-packs/recipe-types.js";
import { compilableRecipe, requestWithRecipe } from "./compile-fixture.js";
import { bindingProviderRequest } from "./provider-invocation-fixture.js";
import { phaseStates, runnerContext, stageCompiledAction, stagedRunTracker } from "./runtime-fixture.js";

const runs = stagedRunTracker();
afterEach(() => runs.cleanupAll());

const SOURCE_TEXT = "The Transformer architecture uses Multi-Head Attention.\n";

/** The sealed descriptor every case shares. */
const DESCRIPTOR: SourceEvidenceDescriptorV2 = {
  pathsField: "source-paths", digestsField: "source-digests", byteCountsField: "source-byte-counts",
  inputIdPrefix: "src", kind: "source-evidence", provenanceLabel: "retained-source",
  mediaType: "text/markdown", maxItems: 4, maxBytes: 65_536, pathTableKey: "source-files",
};

/** The provider-bearing recipe, its phase carrying the descriptor. */
function descriptorRecipe(): PackRecipeV2 {
  const recipe = compilableRecipe();
  // FIRST in declaration order: the base recipe's own phases read the action
  // input too, and the added list columns change what they see — a failure
  // there must not mask whether the provider phase ran. Extract depends on
  // nothing, so running it first isolates what this suite measures.
  recipe.phases = [{
    phaseId: "extract", kind: "provider", dependencies: [], disposition: "required",
    inputBindings: [], outputSchema: [{ fieldId: "summary", valueKind: "string" }],
    bounds: { maxItems: 1, maxOutputBytes: 4096 }, missingInputDisposition: "fail",
    body: {
      providerRoleId: "primary-model", requestTemplateRef: "render.provider-request",
      sourceEvidenceDescriptor: DESCRIPTOR,
    },
  } as unknown as PackRecipeV2["phases"][number], ...recipe.phases];
  return recipe;
}

/** The compile request with the three columns declared and supplied. */
function requestWithColumns(digests: string[], byteCounts: string[]) {
  const base = requestWithRecipe(descriptorRecipe());
  const column = {
    kind: "string-list", required: false, overridable: true, sensitivityDisplay: "normal",
    maxItems: 4, maxItemBytes: 512,
  } as const;
  const action = base.pack.actions["demo.run"]!;
  return {
    ...base,
    pack: {
      ...base.pack,
      actions: {
        "demo.run": {
          ...action,
          inputSchema: {
            ...action.inputSchema,
            "source-paths": column, "source-digests": column, "source-byte-counts": column,
          },
        },
      },
    },
    input: {
      ...base.input,
      "source-paths": ["paper.md"], "source-digests": digests, "source-byte-counts": byteCounts,
    },
  };
}

/** Host-computed columns for the shared source text. */
function hostColumns(): { digests: string[]; byteCounts: string[] } {
  const bytes = Buffer.from(SOURCE_TEXT, "utf8");
  return {
    digests: [`sha256:${createHash("sha256").update(bytes).digest("hex")}`],
    byteCounts: [String(bytes.length)],
  };
}

/** An invocation that FORWARDS the built specs, as the real dev host does. */
function capturingInvocation(seen: PackSourceEvidenceContextV1[]): PackProviderInvocationV1 {
  return {
    legInputFor: (executor, _phase, _request, context) => {
      if (context.sourceEvidence !== undefined) seen.push(context.sourceEvidence);
      const request = {
        ...bindingProviderRequest(executor),
        inputSpecs: context.sourceEvidence?.specs ?? [],
      } as ReturnType<typeof bindingProviderRequest>;
      return { request, host: {} as never, preparationRunId: context.preparationRunId };
    },
    invoke: completed,
  };
}

/** Seal the declared bytes, then place the chosen actual bytes in retained storage. */
async function stageSource(actualBytes: string) {
  const { digests, byteCounts } = hostColumns();
  const action = await compilePackAction(requestWithColumns(digests, byteCounts));
  const staged = runs.add(await stageCompiledAction(action));
  await mkdir(path.join(staged.root, "sources"), { recursive: true });
  await writeFile(path.join(staged.root, "sources", "paper.md"), actualBytes, "utf8");
  return { action, staged };
}

describe("the sealed source-evidence descriptor", () => {
  it("delivers the retained source's bytes and path table to the provider leg", async () => {
    const { action, staged } = await stageSource(SOURCE_TEXT);

    const seen: PackSourceEvidenceContextV1[] = [];
    await runPreparation(assembleRunnerInput(action, {
      ...runnerContext(staged), providerInvocation: capturingInvocation(seen),
    }));
    const states = await phaseStates(staged);
    expect(states.get("extract"), JSON.stringify([...states])).toBe("succeeded");
    // The bytes the provider received are the retained file's, verified.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.specs).toHaveLength(1);
    expect(Buffer.from(seen[0]!.specs[0]!.bytes).toString("utf8")).toBe(SOURCE_TEXT);
    // The provider can name the file each claim cites (§4.1.3).
    expect(seen[0]!.pathTable).toEqual({ "src-0": "paper.md" });
    expect(seen[0]!.pathTableKey).toBe("source-files");
  }, 60_000);

  it("REFUSES at compile when the three columns disagree on length", async () => {
    const { digests } = hostColumns();
    await expect(compilePackAction(requestWithColumns(digests, [])))
      .rejects.toThrow(/source-evidence columns disagree/);
  });

  it("REFUSES a second provider phase declaring its own descriptor", async () => {
    // The grammar validates every descriptor; capturing only the first would
    // leave the second's digest columns undefined — accepted but uncompileable.
    // One action, one descriptor, stated at compile.
    const { digests, byteCounts } = hostColumns();
    const request = requestWithColumns(digests, byteCounts);
    const recipe = request.pack.recipes["demo.prepare"]!;
    recipe.phases = [...recipe.phases, {
      ...(recipe.phases.find((phase) => phase.phaseId === "extract")!),
      phaseId: "extract-again",
    }];
    await expect(compilePackAction(request))
      .rejects.toThrow(/2 provider phases declare a sourceEvidenceDescriptor/);
  });

  it("FAILS the leg when the source was edited after approval", async () => {
    // DIFFERENT bytes than the sealed digest describes.
    const { action, staged } = await stageSource("tampered\n");

    const seen: PackSourceEvidenceContextV1[] = [];
    const result = await runPreparation(assembleRunnerInput(action, {
      ...runnerContext(staged), providerInvocation: capturingInvocation(seen),
    }));
    // Caught at the authority SEAL, before any leg runs: the resolver reads the
    // tampered bytes, resolves unavailable, and the attempt PARKS — the
    // provider is never invoked and no phase records a state. Earlier than the
    // leg-level refusal, and stronger: the approved plan never executes at all.
    expect(result.status).not.toBe("handed-off");
    expect(JSON.stringify(result)).toContain("source-evidence-digest-drift");
    expect(seen).toHaveLength(0);
  }, 60_000);
});

describe("the path table cannot take the platform's own input keys", () => {
  /** The shared request with the descriptor's pathTableKey overridden (a COPY —
   * the suite's DESCRIPTOR const is shared by reference). */
  function requestWithPathTableKey(key: string) {
    const { digests, byteCounts } = hostColumns();
    const request = requestWithColumns(digests, byteCounts);
    const recipe = Object.values(request.pack.recipes)[0] as unknown as {
      phases: { body?: { sourceEvidenceDescriptor?: unknown } }[];
    };
    recipe.phases[0]!.body!.sourceEvidenceDescriptor = { ...DESCRIPTOR, pathTableKey: key };
    return request;
  }

  it("REFUSES pathTableKey 'request' at compile", async () => {
    // A descriptor claiming the platform's key would land its path table where
    // the host writes the SEALED rendered request.
    await expect(compilePackAction(requestWithPathTableKey("request")))
      .rejects.toThrow("pathTableKey may not take the reserved input key: request");
  });

  it("REFUSES pathTableKey 'templateRef' at compile", async () => {
    await expect(compilePackAction(requestWithPathTableKey("templateRef")))
      .rejects.toThrow("pathTableKey may not take the reserved input key: templateRef");
  });

  it("the PRODUCTION host input record keeps the sealed request even against a hostile key", () => {
    // The real assembly the dev host ships: platform fields written LAST, so a
    // context that somehow arrives carrying a reserved key cannot displace the
    // rendered request the plan sealed.
    const request = { text: "the sealed question", templateRef: "render.provider-request" } as never;
    const benign = providerInputRecord(request, {
      specs: [], pathTable: { "src-0": "sources/a.md" }, pathTableKey: "source-files",
    } as never);
    expect(benign).toEqual({
      "source-files": { "src-0": "sources/a.md" },
      request: "the sealed question", templateRef: "render.provider-request",
    });
    const hostile = providerInputRecord(request, {
      specs: [], pathTable: { "src-0": "sources/a.md" }, pathTableKey: "request",
    } as never);
    expect(hostile.request).toBe("the sealed question");
    expect(hostile.templateRef).toBe("render.provider-request");
  });
});

describe("the frozen-input read honours the prepared-input contract", () => {
  /** The columns request plus one wide string field carrying `bytes` of padding. */
  function requestWithPadding(bytes: number) {
    const { digests, byteCounts } = hostColumns();
    const request = requestWithColumns(digests, byteCounts);
    const action = request.pack.actions["demo.run"]!;
    return {
      ...request,
      pack: { ...request.pack, actions: { "demo.run": { ...action, inputSchema: {
        ...action.inputSchema,
        corpus: { kind: "string", required: false, overridable: true,
          sensitivityDisplay: "normal", maxBytes: 2_097_152 },
      } } } },
      input: { ...request.input, corpus: "x".repeat(bytes) },
    } as typeof request;
  }

  it("resolves a frozen action input LARGER than 1 MiB", async () => {
    // A schema-valid 1.05 MiB input compiled and staged, then FAILED authority
    // resolution as action-input-over-cap: the resolver kept a private 1 MiB
    // read cap while the prepared-input contract admits far larger objects.
    const action = await compilePackAction(requestWithPadding(1_100_000) as never);
    const staged = runs.add(await stageCompiledAction(action));
    await mkdir(path.join(staged.root, "sources"), { recursive: true });
    await writeFile(path.join(staged.root, "sources", "paper.md"), SOURCE_TEXT);
    const extract = staged.action.plan.phases.find((phase) => phase.logicalPhaseId === "extract")!;
    const resolution = await createPackAuthorityResolver({ root: staged.root, binding: staged.binding })
      .resolve({
        executor: extract.executor!, logicalPhaseId: extract.logicalPhaseId,
        phaseInstanceId: derivePhaseInstanceId({
          manifestDigest: staged.binding.manifestDigest, logicalPhaseId: extract.logicalPhaseId,
          expansionIdentity: singleExpansionIdentity(),
        }),
      });
    expect(resolution.status, JSON.stringify(resolution)).toBe("ok");
  }, 30_000);
});
