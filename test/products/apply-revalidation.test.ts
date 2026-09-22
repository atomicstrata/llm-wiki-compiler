/**
 * @file test/products/apply-revalidation.test.ts
 * @description AS-1 §4.7: a proposal REVALIDATES against current state before
 * it applies, because proposal and apply are separated in time.
 *
 * THE GAP BETWEEN INVOKE AND APPLY IS REAL. A bundle is produced, a person
 * reads it, and only then approves — and the wiki can change in between, by
 * another run, another operator, or a hand edit. Applying a proposal computed
 * against a world that no longer exists is how a review gets silently
 * overridden: the operator approved creating a page, and what actually happens
 * is overwriting someone else's.
 *
 * SO THE APPLY MUST NOT SUCCEED BLINDLY. This drives the real product surface —
 * invoke, then mutate the wiki underneath, then apply — and asserts both halves:
 * the apply does not report success, and the bytes that were there beforehand
 * are still there afterwards. Reporting a refusal while having written anyway
 * would be the worse failure of the two.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCliOperationRuntime } from "../../src/operation-bundles/runtime-factory.js";
import { applyProductBundle } from "../../src/products/apply.js";
import {
  activatedProject, verticalService, VERTICAL_ACTION_ID, VERTICAL_WORKSPACE_ID,
  type ActivatedProjectV1,
} from "./product-vertical-fixture.js";

const projects: ActivatedProjectV1[] = [];
afterEach(async () => { await Promise.all(projects.splice(0).map(project => project.cleanup())); });

/** Invoke a domain-neutral action and retain the project until test cleanup. */
async function proposedBundle(project: ActivatedProjectV1): Promise<string> {
  projects.push(project);
  const invoked = await verticalService(project.root, ["preparation.run"]).invoke({
    workspaceId: VERTICAL_WORKSPACE_ID, token: VERTICAL_ACTION_ID, input: { topic: "revalidation" },
  });
  if (invoked.status !== "handed-off") throw new Error(JSON.stringify(invoked));
  return invoked.bundleManifestDigest;
}

/** Apply through the real operator boundary, not through embedder authority. */
function applyBundle(root: string, bundle: string) {
  return applyProductBundle({ root, runtime: createCliOperationRuntime(),
    principal: { id: "revalidation-test", surface: "cli", grants: ["operation-bundle.approve"] },
  }, { bundle });
}

describe("a proposal revalidates before it applies", () => {
  it("does NOT overwrite a page that appeared after the proposal was made", async () => {
    const project = await activatedProject();
    const digest = await proposedBundle(project);

    // Someone else writes the page this bundle proposes to create, in the
    // window between review and apply.
    await mkdir(path.join(project.root, "wiki", "wiki-page"), { recursive: true });
    const target = path.join(project.root, "wiki", "wiki-page", "action-input.md");
    const theirs = "---\ntitle: Someone else's work\nauthors:\n  - Other\nstage: imported\n---\nMine.\n";
    await writeFile(target, theirs, "utf8");

    const outcome = await applyBundle(project.root, digest);

    // Both halves: the apply must not claim success, AND their bytes must
    // survive. A refusal that had already written would be worse than either.
    expect(outcome.status).not.toBe("applied");
    expect(await readFile(target, "utf8")).toBe(theirs);
  }, 120_000);

  it("still applies cleanly when nothing changed underneath", async () => {
    // The precondition for the case above: an apply that always refused would
    // satisfy it while proving nothing about revalidation.
    const project = await activatedProject();
    const digest = await proposedBundle(project);
    const outcome = await applyBundle(project.root, digest);
    expect(outcome.status).toBe("applied");
  }, 120_000);
});
