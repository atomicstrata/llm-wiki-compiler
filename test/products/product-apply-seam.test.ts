/**
 * @file test/products/product-apply-seam.test.ts
 * @description What actually gates `product apply` — the operation grant that
 * separates proposing a bundle from approving it.
 *
 * THE GRANT IS ISOLATED, NOT ASSUMED. The CLI cannot witness the approve grant
 * at all — a local shell principal holds the whole operator set by transport, so
 * every CLI apply passes the check whatever list it declares. So the control
 * here holds the runtime, the project, the bundle and the call site FIXED and
 * varies exactly one thing: whether the principal carries
 * `operation-bundle.approve`. Granted applies and writes; ungranted refuses with
 * the executor's own `approval-grant-missing` and leaves the page absent. Remove
 * the grant from the CLI host and the subprocess suite stays green; remove it
 * here and this goes red.
 *
 * THE REFUSAL IS ASSERTED TO BE A REFUSAL, not merely a non-success. An
 * ungranted apply must leave the run exactly where it found it — still
 * `awaiting-approval`, still resumable — rather than burning a durable
 * transition, so the carried state is checked too.
 */

import { access } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { scanOperationInventory } from "../../src/operation-bundles/capacity.js";
import type { OperationGrant } from "../../src/operation-bundles/principal.js";
import { createCliOperationRuntime } from "../../src/operation-bundles/runtime-factory.js";
import { applyProductBundle, type ProductApplyResultV1 } from "../../src/products/apply.js";
import { writeJournal } from "../trust/journal-fixture.js";
import {
  activatedProject, type ActivatedProjectV1, verticalService,
  VERTICAL_ACTION_ID, VERTICAL_WORKSPACE_ID,
} from "./product-vertical-fixture.js";

/** The caller input every invocation in this suite declares. */
const INPUT = { topic: "superconductivity" } as const;

/** Where the vertical fixture's page-create mutation lands. */
const PAGE_PATH = path.join("wiki", "wiki-page", "action-input.md");

/** Whether the proposed page exists on disk. */
async function pageExists(root: string): Promise<boolean> {
  return access(path.join(root, PAGE_PATH)).then(() => true, () => false);
}

/**
 * Drive one activated project to a handoff and return the BUNDLE MANIFEST
 * DIGEST — the identifier `invoke` reports, and so the one `apply` must take.
 * `runId` on that result is the PREPARATION run id, a different identity space.
 */
async function handedOffDigest(root: string): Promise<string> {
  const result = await verticalService(root, ["preparation.run"]).invoke({
    workspaceId: VERTICAL_WORKSPACE_ID, token: VERTICAL_ACTION_ID, input: INPUT,
  });
  if (result.status !== "handed-off") throw new Error(`invoke did not hand off: ${JSON.stringify(result)}`);
  return result.bundleManifestDigest;
}

/** Apply one bundle under the production runtime with exactly these grants. */
function applyWith(
  root: string, bundle: string, grants: readonly OperationGrant[],
): Promise<ProductApplyResultV1> {
  return applyProductBundle({
    root,
    principal: { id: "seam-test", surface: "cli", grants },
    runtime: createCliOperationRuntime(),
  }, { bundle });
}

/** The problem codes one settled outcome carried. */
function codesOf(outcome: ProductApplyResultV1): string[] {
  return outcome.status === "refused" ? [] : outcome.problems.map((problem) => problem.code);
}

/** Assert one outcome refused and wrote no page, then release the project. */
async function expectRefusedNoWrite(
  project: ActivatedProjectV1, outcome: ProductApplyResultV1,
): Promise<void> {
  expect(outcome.status).toBe("refused");
  expect(await pageExists(project.root)).toBe(false);
  await project.cleanup();
}

describe("the approve grant is what gates an apply", () => {
  it("applies and writes the page when the principal carries the grant", async () => {
    const project = await activatedProject();
    const digest = await handedOffDigest(project.root);
    const outcome = await applyWith(project.root, digest, ["operation-bundle.approve"]);
    expect(outcome.status, JSON.stringify(outcome)).toBe("applied");
    expect(await pageExists(project.root)).toBe(true);
    await project.cleanup();
  });

  it("refuses and writes nothing when the SAME call carries no grant", async () => {
    const project = await activatedProject();
    const digest = await handedOffDigest(project.root);
    const outcome = await applyWith(project.root, digest, []);
    expect(outcome.status).toBe("not-applied");
    expect(codesOf(outcome)).toEqual(["approval-grant-missing"]);
    expect(await pageExists(project.root)).toBe(false);
    await project.cleanup();
  });

  it("leaves an ungranted run exactly where it found it", async () => {
    // A refusal must not be a durable transition: the run stays awaiting-approval
    // and a granted retry still settles it.
    const project = await activatedProject();
    const digest = await handedOffDigest(project.root);
    const refused = await applyWith(project.root, digest, []);
    expect(refused.status === "not-applied" && refused.runState).toBe("awaiting-approval");
    const retried = await applyWith(project.root, digest, ["operation-bundle.approve"]);
    expect(retried.status).toBe("applied");
    await project.cleanup();
  });

  it("reports the run's own counters rather than a count of its own", async () => {
    const project = await activatedProject();
    const digest = await handedOffDigest(project.root);
    const outcome = await applyWith(project.root, digest, ["operation-bundle.approve"]);
    if (outcome.status !== "applied") throw new Error("apply did not settle");
    expect(outcome.mutations).toEqual({ attempted: 1, applied: 1, skipped: 0, failed: 0 });
    expect(outcome.runState).toBe("succeeded");
    await project.cleanup();
  });

  it("resolves the identities off the durable manifest, not off the caller", async () => {
    const project = await activatedProject();
    const digest = await handedOffDigest(project.root);
    const stored = (await scanOperationInventory(project.root)).manifests[0]!;
    const outcome = await applyWith(project.root, digest, ["operation-bundle.approve"]);
    if (outcome.status === "refused") throw new Error(`apply refused: ${outcome.reason}`);
    // The caller named a DIGEST and never the bundle id; the bundle id came back
    // off the manifest the store loaded.
    expect(outcome.bundleId).toBe(stored.bundleId);
    await project.cleanup();
  });

  it("refuses an unknown target before taking the lock", async () => {
    const project = await activatedProject();
    await handedOffDigest(project.root);
    const outcome = await applyWith(project.root, "prr_nope", ["operation-bundle.approve"]);
    await expectRefusedNoWrite(project, outcome);
  });

  it("refuses rather than throwing when the page journal is unsafe", async () => {
    // A malformed pending journal makes pre-mutation recovery report `unsafe`, so
    // the mutation gate throws JournalUnsafeError. The seam must carry that as a
    // refusal with the gate's own sentence, never let the stack trace escape.
    const project = await activatedProject();
    const digest = await handedOffDigest(project.root);
    await writeJournal(project.root, "bad", "not json at all {{{");
    const outcome = await applyWith(project.root, digest, ["operation-bundle.approve"]);
    await expectRefusedNoWrite(project, outcome);
  });
});
