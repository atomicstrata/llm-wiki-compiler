/**
 * Public mutation parity for confined private-directory aliases. Opt-in
 * lifecycle custody must still fail closed rather than disappear behind one.
 */
import { mkdir, rename, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { startWorkflow } from "../src/workflows/start.js";
import { acquireMutationLock, PreparationLifecycleGateError } from "../src/operation-bundles/lock-gate.js";
import { releaseLock } from "../src/utils/lock.js";
import { readActiveProductBinding } from "../src/products/binding/store.js";
import { useWorkflowRoot, ADAPT_BUILD_STAGES, readOkRun } from "./fixtures/workflow-profile.js";

const ctx = useWorkflowRoot("legacy-private-layout-", ADAPT_BUILD_STAGES);

/** Move the baseline private directory behind an alias entirely inside root. */
async function aliasPrivateDirectory(): Promise<string> {
  const target = path.join(ctx.root, "private-store");
  await rename(path.join(ctx.root, ".llmwiki"), target);
  await symlink(target, path.join(ctx.root, ".llmwiki"), "dir");
  return target;
}

describe("legacy private-directory layout", () => {
  it("starts and reopens a workflow through a confined alias", async () => {
    await aliasPrivateDirectory();
    const run = await startWorkflow(ctx.root, "build", { title: "legacy" });
    expect((await readOkRun(ctx.root, run.runId)).inputs).toEqual({ title: "legacy" });
  });

  it("allows the ordinary mutation lock without creating lifecycle registries", async () => {
    await aliasPrivateDirectory();
    await acquireMutationLock(ctx.root, "ordinary");
    await releaseLock(ctx.root);
  });

  it.each(["preparation-quarantine", "preparation-prune"])("refuses an aliased %s registry", async (name) => {
    const target = await aliasPrivateDirectory();
    await mkdir(path.join(target, name));
    await expect(acquireMutationLock(ctx.root, "ordinary")).rejects.toBeInstanceOf(PreparationLifecycleGateError);
  });

  it("does not treat a dangling registry symlink as absent", async () => {
    const target = await aliasPrivateDirectory();
    await symlink(path.join(target, "missing"), path.join(target, "preparation-quarantine"));
    await expect(acquireMutationLock(ctx.root, "ordinary")).rejects.toBeInstanceOf(PreparationLifecycleGateError);
  });

  it("does not treat a malformed registry leaf as absent", async () => {
    const target = await aliasPrivateDirectory();
    await writeFile(path.join(target, "preparation-quarantine"), "invalid");
    await expect(acquireMutationLock(ctx.root, "ordinary")).rejects.toBeInstanceOf(PreparationLifecycleGateError);
  });

  it("does not ignore an active-product binding behind an alias", async () => {
    const target = await aliasPrivateDirectory();
    await writeFile(path.join(target, "active-product.json"), "invalid");
    expect(await readActiveProductBinding(ctx.root)).toMatchObject({ kind: "malformed" });
  });

  it("does not treat a dangling active-product binding as absent", async () => {
    const target = await aliasPrivateDirectory();
    await symlink(path.join(target, "missing"), path.join(target, "active-product.json"));
    expect(await readActiveProductBinding(ctx.root)).toMatchObject({ kind: "malformed" });
  });
});
