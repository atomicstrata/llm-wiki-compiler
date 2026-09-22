/**
 * @file test/operations-packs/host-invocation-request.test.ts
 * @description What a host invocation RECEIVES: the request the platform
 * rendered from the plan's sealed template and the run's frozen input.
 *
 * THE HOST DOES NOT COMPOSE THE QUESTION. A host that built the request itself
 * could ask something other than what the approved plan says it asks, and the
 * plan digest would stop describing the invocation. So this captures the text
 * handed to `legInputFor` and pins that the operator's own input is inside it.
 *
 * WHAT THIS FILE DOES NOT COVER, stated because the distinction cost a review
 * round: it drives `assembleRunnerInput` + `runPreparation` directly, so it
 * measures the ROUTING seam. It does not exercise `createProductService`, and a
 * service that accepted a provider invocation and then dropped it would still
 * pass here. The absent-host case below is the shipped default — llmwiki
 * supplies no backend — and shows the refusal is the host's capability rather
 * than anything about the pack.
 */

import { afterEach, describe, expect, it } from "vitest";
import { compilePackAction } from "../../src/operations-packs/compiler.js";
import { assembleRunnerInput } from "../../src/operations-packs/runtime/runner-input.js";
import type { PackProviderInvocationV1 } from "../../src/operations-packs/runtime/runner-input.js";
import type { ProviderInvokeFn } from "../../src/preparations/attempts/provider.js";
import { runPreparation } from "../../src/index.js";
import { providerIngestRecipe, requestWithRecipe } from "../operations-packs/compile-fixture.js";
import { providerLegInputFor } from "../operations-packs/provider-invocation-fixture.js";
import {
  phaseStates, runnerContext, stageCompiledAction, stagedRunTracker,
} from "../operations-packs/runtime-fixture.js";

const runs = stagedRunTracker();
afterEach(() => runs.cleanupAll());

const USAGE = { brokerRequestCount: 0, tokenCount: "unobserved" as const, costMicros: "unobserved" as const };

/** An invocation that records the request it was handed and completes. */
function recordingInvocation(
  seen: string[], contexts: Record<string, unknown>[] = [],
): PackProviderInvocationV1 {
  const invoke: ProviderInvokeFn = async () => ({
    kind: "completed",
    admitted: {
      outcome: "succeeded", acceptedArtifacts: [], receipts: [], usage: USAGE,
      counts: { declared: 0, acceptedArtifacts: 0, requiredMissing: 0, receipts: 0 },
      untrusted: { untrusted: true, providerReportedCounts: null, warnings: null, output: null },
    },
  });
  return {
    legInputFor: (executor, phase, request, context) => {
      seen.push(request.text);
      contexts.push({ ...context });
      return providerLegInputFor(executor);
    },
    invoke,
  };
}

/** Drive the provider-bearing action with or without a host invocation. */
async function drive(
  providerInvocation: PackProviderInvocationV1 | undefined,
  surface: "cli" | "sdk" | "mcp" = "sdk",
) {
  const action = await compilePackAction({
    ...requestWithRecipe(providerIngestRecipe()), input: { topic: "cuprates" },
  });
  const staged = runs.add(await stageCompiledAction(action));
  await runPreparation(assembleRunnerInput(action, {
    ...runnerContext(staged), surface,
    ...(providerInvocation === undefined ? {} : { providerInvocation }),
  }));
  return { states: await phaseStates(staged), staged };
}

describe("a host-supplied provider invocation reaches the runner", () => {
  it("EXECUTES the provider phase and hands it the rendered request", async () => {
    const seen: string[] = [];
    const { states } = await drive(recordingInvocation(seen));
    expect(states.get("extract")).toBe("succeeded");
    // The platform rendered it from the plan's sealed template and the run's
    // frozen input; the host only carried it.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("cuprates");
  });

  it("REFUSES the provider phase when the host supplies none — the shipped default", async () => {
    expect((await drive(undefined)).states.get("extract")).toBe("failed");
  });

  it("binds the invocation to the REAL run and the surface it arrived on", async () => {
    // A host is built before anything is staged, so a run id or workspace baked
    // in at construction is a guess — and the real run id does not exist until
    // staging. Grants and authority snapshots bind these, so a guessed value
    // binds the wrong run, and a guessed root binds the wrong PROJECT.
    const contexts: Record<string, unknown>[] = [];
    const { staged } = await drive(recordingInvocation([], contexts), "cli");
    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toMatchObject({
      root: staged.root,
      workspaceId: staged.binding.workspaceId,
      preparationRunId: staged.binding.runId,
      surface: "cli",
    });
  });
});
