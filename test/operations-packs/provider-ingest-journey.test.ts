/**
 * @file test/operations-packs/provider-ingest-journey.test.ts
 * @description AS-1 §4.4: a provider's extraction becomes proposed pages. The
 * journey a real `ingest` runs — provider extracts entities from a source, the
 * successor proposes one page per entity — with only the sandbox launch stubbed.
 *
 * THIS IS THE PRODUCTION CALLER THE DECODER LACKED. `decodeProviderResponse`
 * existed and was well tested, but nothing in `src/` called it, so a suite could
 * have certified it forever while no provider output ever reached a successor.
 * Here the bytes the successor chains from are the ones the stub provider wrote
 * to disk, read back through the real evidence store.
 *
 * THE PROVIDER PUBLISHES ITS OWN ANSWER, NOT THE PACK'S ENVELOPE, which is why
 * the read seam dispatches on the predecessor's sealed executor kind. A
 * pack-native decode of these bytes refuses them outright — that is the mutation
 * that reddens this file.
 *
 * WHAT IT IS ALLOWED TO RETURN WAS FIXED WHEN THE PLAN WAS APPROVED: the decode
 * runs against the output schema the plan SEALED for that phase, so a provider
 * returning an extra field is refused rather than widening the evidence.
 */

import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runPreparation } from "../../src/index.js";
import { compilePackAction } from "../../src/operations-packs/compiler.js";
import { assembleRunnerInput } from "../../src/operations-packs/runtime/runner-input.js";
import type { ProviderInvokeFn } from "../../src/preparations/attempts/provider.js";
import type { PackRecipeV2 } from "../../src/operations-packs/recipe-types.js";
import { providerIngestRecipe, requestWithRecipe } from "./compile-fixture.js";
import {
  phaseStates, readPhaseOutput, resultReason, runnerContext, stageCompiledAction, stagedRunTracker,
} from "./runtime-fixture.js";
import { providerLegInputFor } from "./provider-invocation-fixture.js";

const tracker = stagedRunTracker();
afterEach(() => tracker.cleanupAll());

/** The two entities the stub provider extracts from its source. */
const EXTRACTED = [
  { itemId: "entity-1", title: "superconductivity", definition: "zero resistance" },
  { itemId: "entity-2", title: "cuprates", definition: "copper oxide family" },
];


/** A provider that WRITES its answer to disk, as a real invocation would. */
function extractingProvider(body: unknown): ProviderInvokeFn {
  return async () => {
    const bytes = Buffer.from(JSON.stringify(body), "utf8");
    const dir = await mkdtemp(path.join(tmpdir(), "provider-out-"));
    const file = path.join(dir, "extraction.json");
    await writeFile(file, bytes);
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const;
    return {
      kind: "completed",
      admitted: {
        outcome: "succeeded", receipts: [],
        acceptedArtifacts: [{
          outputId: "extraction", mediaType: "application/json", digest,
          byteCount: bytes.byteLength, evidence: { evidencePath: file },
        }],
        counts: { declared: 1, acceptedArtifacts: 1, requiredMissing: 0, receipts: 0 },
        usage: { brokerRequestCount: 0, tokenCount: "unobserved", costMicros: "unobserved" },
        untrusted: { untrusted: true, providerReportedCounts: null, warnings: null, output: null },
      },
    } as never;
  };
}

/** Drive the ingest journey with one provider answer; return the run and result. */
async function ingest(body: unknown) {
  const action = await compilePackAction(requestWithRecipe(providerIngestRecipe()));
  const run = tracker.add(await stageCompiledAction(action));
  const result = await runPreparation(assembleRunnerInput(action, {
    ...runnerContext(run),
    providerInvocation: { legInputFor: providerLegInputFor, invoke: extractingProvider(body) },
  }));
  return { run, result };
}

describe("§4.4 a provider's extraction reaches the proposed pages", () => {
  it("proposes ONE page per extracted entity, titled from the provider's answer", async () => {
    const { run, result } = await ingest({ items: EXTRACTED });
    expect(result.status, resultReason(result)).toBe("handed-off");
    expect((await phaseStates(run)).get("extract")).toBe("succeeded");

    const published = await readPhaseOutput(run, "propose") as { drafts: Record<string, unknown>[] };
    // The provider's own field values, carried through decode, chaining and the
    // intent mapping. No other path produces these two titles in this order.
    expect(published.drafts.map((draft) => (draft.fields as Record<string, unknown>).title))
      .toEqual(["superconductivity", "cuprates"]);
  });

  it("REFUSES an answer carrying a field the sealed schema does not declare", async () => {
    // Widening is the failure that matters: an undeclared field admitted here
    // would reach a page as content the approved plan never promised.
    const { run, result } = await ingest({
      items: [{ ...EXTRACTED[0], confidence: 0.9 }],
    });
    expect(result.status).not.toBe("handed-off");
    expect((await phaseStates(run)).get("propose")).not.toBe("succeeded");
  });

  it("REFUSES an answer that is not the provider envelope at all", async () => {
    const { result } = await ingest({ entities: EXTRACTED });
    expect(result.status).not.toBe("handed-off");
  });
});
