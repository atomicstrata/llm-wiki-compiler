/**
 * @file test/products/product-vertical-zero-draft.test.ts
 * @description THE mutation witness for the materializer's zero-draft refusal.
 *
 * An adversarial review made the intent family emit ZERO drafts and every
 * vertical suite stayed green: the materializer derived completeness from the
 * drafts that survived, so an empty draft set was "complete", and it emitted no
 * targets anyway, so the bundle looked exactly the same. A run that produced
 * nothing reached `handed-off`.
 *
 * WHAT CHANGED, AND WHAT DID NOT. A run that proposes nothing now settles
 * `nothing-to-propose` rather than `refused`, because an idempotent workflow —
 * seed a catalog, re-seed it — must be able to report a correct no-op without
 * calling it an error. The DEFECT this suite exists for is untouched: no bundle
 * is staged and `handed-off` is never reached, so no operator is told mutations
 * were prepared when none were. The honest cost is that a pack whose terminal
 * silently drafts nothing THROUGH A BUG now reads as "nothing to do" instead of
 * failing loudly; the materializer cannot tell the two apart from zero drafts
 * alone, and the second case below is what keeps the worse half impossible.
 *
 * This suite performs that exact mutation as a MODULE DOUBLE rather than a source
 * edit — the production `invoke`, service, compiler, runtime and runner are the
 * real ones; only the pure `compileIntents` family is wrapped so its result
 * declares no drafts. Revert either half of the fix (the zero-draft throw, or
 * `planned` derived from the sealed input instead of the survivors) and `invoke`
 * reaches `handed-off` again and these assertions go red.
 *
 * The double lives in its own file because `vi.mock` is module-scoped: the
 * neighbouring end-to-end suite must keep driving the REAL family.
 */

import { describe, expect, it, vi } from "vitest";
import { scanOperationInventory } from "../../src/operation-bundles/capacity.js";
import type { ProductInvokeResultV1 } from "../../src/products/service.js";
import {
  activatedProject, verticalService, VERTICAL_ACTION_ID, VERTICAL_WORKSPACE_ID,
} from "./product-vertical-fixture.js";

type IntentModule = typeof import("../../src/operations-packs/handlers/intent-compile.js");

// The reviewer's mutation, applied to the family the runtime dispatches to: the
// result keeps every other field the phase publishes, so ONLY the draft set is
// emptied and nothing else about the run changes.
vi.mock("../../src/operations-packs/handlers/intent-compile.js", async (importOriginal) => {
  const actual = await importOriginal<IntentModule>();
  return {
    ...actual,
    compileIntents: (input: Parameters<IntentModule["compileIntents"]>[0]) => {
      const result = actual.compileIntents(input);
      return { ...result, drafts: [], handoffCapacity: { ...result.handoffCapacity, declaredDrafts: 0 } };
    },
  };
});

/** Invoke the vertical action once on a fresh activated project. */
async function invokeWithNoDrafts(): Promise<{
  root: string; result: ProductInvokeResultV1; cleanup: () => Promise<void>;
}> {
  const project = await activatedProject();
  const result = await verticalService(project.root, ["preparation.run"]).invoke({
    workspaceId: VERTICAL_WORKSPACE_ID, token: VERTICAL_ACTION_ID, input: { topic: "superconductivity" },
  });
  return { root: project.root, result, cleanup: project.cleanup };
}

describe("WOP V3 product vertical: a terminal phase that published no drafts", () => {
  it("does NOT reach handed-off", async () => {
    const { result, cleanup } = await invokeWithNoDrafts();

    // NEVER handed-off: that is the false success this suite was written for.
    expect(result.status).not.toBe("handed-off");
    // Settled as a no-op rather than finalized, so the run is not stranded in a
    // terminal success and carries no bundle digest an operator could act on.
    expect(result.status).toBe("nothing-to-propose");
    await cleanup();
  });

  it("creates no Milestone A bundle at all", async () => {
    const { root, cleanup } = await invokeWithNoDrafts();

    // The complement of the positive proof next door: one real bundle there, none
    // here. A refusal that still staged a bundle would be a worse defect than the
    // one this witnesses.
    const inventory = await scanOperationInventory(root);
    expect(inventory.problems).toEqual([]);
    expect(inventory.manifests).toHaveLength(0);
    await cleanup();
  });
});
