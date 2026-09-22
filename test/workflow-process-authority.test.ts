/**
 * @file test/workflow-process-authority.test.ts
 * @description Proves that a product-declared process is sealed with explicit
 * workspace authority and revalidated by generic workflow operations. The
 * controls distinguish legacy compatibility from opted-in product authority and
 * make process/workspace drift fail before stage advancement.
 */

import { describe, expect, it } from "vitest";
import { useTempRoot } from "./fixtures/temp-root.js";
import { activateProductLocked } from "../src/products/binding/activate.js";
import { writeRun } from "../src/workflows/store.js";
import { advanceWorkflow } from "../src/workflows/advance.js";
import { startProductWorkflow, startWorkflow } from "../src/workflows/start.js";
import { workflowStatus } from "../src/workflows/status.js";
import {
  assertRunWorkspace, WorkflowProcessAuthorityError,
} from "../src/workflows/process-authority.js";
import {
  buildActivatableProduct, commitBuilt, FIXTURE_PRINCIPAL,
} from "./products/binding-fixture.js";

const root = useTempRoot();

/** Activate a product whose runtime authority includes a process definition. */
async function activateProcessProduct(): Promise<void> {
  const product = buildActivatableProduct("Process Product", '{"processId":"build/v1"}');
  const digest = await commitBuilt(root.dir, product);
  await activateProductLocked(root.dir, digest, FIXTURE_PRINCIPAL);
}

describe("product workflow process authority", () => {
  it("seals process and explicit workspace identities on a new run", async () => {
    await activateProcessProduct();
    const run = await startProductWorkflow(root.dir, "desk-a", "build", {});
    expect(run.processAuthority).toMatchObject({
      schemaVersion: 1, productId: "com.example.demo", workspaceId: "desk-a",
    });
    expect(run.processAuthority?.processDefinitionDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(run.processAuthority?.workspaceCompositionDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("refuses a product process start that omits its workspace", async () => {
    await activateProcessProduct();
    await expect(startWorkflow(root.dir, "build", {}))
      .rejects.toMatchObject({ reason: "missing-workspace" });
  });

  it("refuses the product-only start API when no process is declared", async () => {
    const product = buildActivatableProduct();
    const digest = await commitBuilt(root.dir, product);
    await activateProductLocked(root.dir, digest, FIXTURE_PRINCIPAL);
    await expect(startProductWorkflow(root.dir, "desk-a", "build", {}))
      .rejects.toMatchObject({ reason: "not-declared" });
  });

  it("blocks generic advancement after workspace-composition drift", async () => {
    await activateProcessProduct();
    const run = await startProductWorkflow(root.dir, "desk-a", "build", {});
    const forged = { ...run, processAuthority: {
      ...run.processAuthority!, workspaceCompositionDigest: `sha256:${"0".repeat(64)}`,
    } };
    await writeRun(root.dir, forged);
    await expect(advanceWorkflow(root.dir, run.runId))
      .rejects.toBeInstanceOf(WorkflowProcessAuthorityError);
  });

  it("reports process-authority drift as blocked configuration", async () => {
    await activateProcessProduct();
    const run = await startProductWorkflow(root.dir, "desk-a", "build", {});
    await writeRun(root.dir, { ...run, processAuthority: {
      ...run.processAuthority!, processDefinitionDigest: `sha256:${"0".repeat(64)}`,
    } });
    const [status] = await workflowStatus(root.dir, run.runId);
    expect(status).toMatchObject({ classification: "blocked-by-config" });
    expect(status.problem).toMatch(/process authority.*stale-or-invalid/i);
  });

  it("does not let another workspace operate the run", async () => {
    await activateProcessProduct();
    const run = await startProductWorkflow(root.dir, "desk-a", "build", {});
    expect(() => assertRunWorkspace(run, "desk-b"))
      .toThrow(WorkflowProcessAuthorityError);
    expect(() => assertRunWorkspace(run, "desk-a")).not.toThrow();
  });
});
