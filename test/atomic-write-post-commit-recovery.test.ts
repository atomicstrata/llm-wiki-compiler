/**
 * Approved filesystem-drift safety exceptions: a post-rename refusal may leave
 * published bytes. The real page executor must retain its journal and recover
 * only after the operator restores the original directory binding.
 */
import path from "node:path";
import { mkdir, readFile, realpath, rename, rmdir, writeFile } from "fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTempRoot } from "./fixtures/temp-root.js";
import { atomicWrite, AtomicWritePostCommitError } from "../src/utils/atomic-write.js";
import { readConfinedLeaf } from "../src/utils/confined-read.js";
import { planPageMutation } from "../src/trust/planner.js";
import { applyApprovedMutations } from "../src/trust/executor.js";
import { replayJournal } from "../src/trust/journal.js";
import { journalFileCount } from "./fixtures/compile-reroute-helpers.js";
import { installWorkflowProfile, WORKFLOW_PROFILE } from "./fixtures/workflow-profile.js";
import { startWorkflow } from "../src/workflows/start.js";
import { readRun } from "../src/workflows/store.js";
import { preflightApplyRecord } from "../src/workflows/stage-output-internals.js";
import { createLocalWorkflowHost } from "../src/local-workflow-host/index.js";
import { createLocalWorkflowRuntime } from "../src/workflows/runtime.js";

const fault = vi.hoisted(() => ({ target: "" }));
vi.mock("fs/promises", async (original) => {
  const fs = await original<typeof import("fs/promises")>();
  return { ...fs, rename: async (...args: Parameters<typeof fs.rename>) => {
    await fs.rename(...args);
    if (String(args[1]) !== fault.target) return;
    fault.target = "";
    const directory = path.dirname(String(args[1]));
    await fs.rename(directory, directory + ".moved");
    await fs.mkdir(directory);
  } };
});

const ctx = useTempRoot(["wiki/concepts", ".llmwiki"]);
afterEach(() => { fault.target = ""; });
const BODY = "---\ntitle: New\n---\n\nNew body.\n";

describe("post-commit filesystem drift", () => {
  it("retains the pending marker when the host reports a post-commit failure after a real page write", async () => {
    const root = await realpath(ctx.dir);
    await installWorkflowProfile(root);
    await mkdir(path.join(root, "wiki/ideas"), { recursive: true });
    const host = createLocalWorkflowHost();
    const runtime = createLocalWorkflowRuntime({ ...host, pages: { ...host.pages,
      apply: async (tx, projectRoot, planned) => {
        await host.pages.apply(tx, projectRoot, planned);
        throw new AtomicWritePostCommitError(new Error("injected post-commit host failure"));
      },
    } });
    const run = await runtime.start({ root, workflowId: "build", inputs: {} });
    await expect(runtime.submit(root, run.runId, { kind: "page", entityType: "ideas", slug: "page", body: BODY }))
      .rejects.toBeInstanceOf(AtomicWritePostCommitError);
    const stored = await readRun(root, run.runId);
    expect(stored).toMatchObject({ status: "ok", run: {
      status: "pending", outputs: {}, pendingOutput: { stageId: "draft" },
    } });
    expect(await readFile(path.join(root, "wiki/ideas/page.md"), "utf8")).toBe(BODY);
  });

  it("does not label a refused rename as a committed write", async () => {
    const target = path.join(ctx.dir, "wiki/concepts/directory.md");
    await mkdir(target);
    const failure = await atomicWrite(target, BODY, { confineRoot: ctx.dir }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(AtomicWritePostCommitError);
  });

  it("rejects after publication without claiming that the bytes were not written", async () => {
    const target = path.join(ctx.dir, "wiki/concepts/page.md");
    fault.target = target;
    await expect(atomicWrite(target, BODY, { confineRoot: ctx.dir })).rejects.toBeInstanceOf(AtomicWritePostCommitError);
    expect(await readFile(path.join(ctx.dir, "wiki/concepts.moved/page.md"), "utf8")).toBe(BODY);
    await expect(readFile(target, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains a pending page journal and restores pre-state after the binding is repaired", async () => {
    const root = await realpath(ctx.dir);
    const directory = path.join(root, "wiki/concepts");
    const target = path.join(directory, "page.md");
    const before = "---\ntitle: Old\n---\n\nOriginal body.\n";
    await writeFile(target, before);
    const plan = await planPageMutation({ root, target: { kind: "raw", directory: "concepts", slug: "page" },
      body: BODY, origin: "agent", reviewRouted: false, allowOverwrite: true });
    expect(plan.planned).toHaveLength(1);
    fault.target = target;
    const writeOne = (file: string, body: string) => atomicWrite(file, body, { confineRoot: root });
    await expect(applyApprovedMutations(root, plan.planned, { writeOne })).rejects.toThrow(/changed/);
    expect(await journalFileCount(root)).toBe(1);
    expect(await readFile(path.join(directory + ".moved", "page.md"), "utf8")).toBe(BODY);
    await rmdir(directory);
    await rename(directory + ".moved", directory);
    await replayJournal(root);
    expect(await readFile(target, "utf8")).toBe(before);
    expect(await journalFileCount(root)).toBe(0);
  });

  it("returns unavailable when the captured leaf changes size after reading", async () => {
    const directory = path.join(ctx.dir, "wiki/concepts");
    const target = path.join(directory, "page.md");
    await writeFile(target, "before");
    const result = await readConfinedLeaf(ctx.dir, target, directory, 100, {
      beforePostReadCheckForTest: () => writeFile(target, "changed length"),
    });
    expect(result).toEqual({ kind: "unavailable" });
  });

  it("keeps workflow pending-output intent when publication succeeded but verification failed", async () => {
    const root = await realpath(ctx.dir);
    await installWorkflowProfile(root);
    const run = await startWorkflow(root, "build", {});
    const stage = WORKFLOW_PROFILE.workflows!.build.stages[0];
    const target = path.join(root, "wiki/concepts/page.md");
    fault.target = target;
    const apply = async () => {
      await atomicWrite(target, BODY, { confineRoot: root });
      return { decision: "allow" as const, outputRef: {} };
    };
    const host = createLocalWorkflowHost();
    await expect(host.withMutation(root, transaction =>
      preflightApplyRecord(root, run, stage, {}, apply, undefined,
        (projectRoot, record) => host.records.write(transaction, projectRoot, record))))
      .rejects.toBeInstanceOf(AtomicWritePostCommitError);
    const stored = await readRun(root, run.runId);
    expect(stored.status).toBe("ok");
    if (stored.status !== "ok") throw new Error("run unreadable");
    expect(stored.run.pendingOutput?.stageId).toBe(stage.id);
    expect(stored.run.outputs).toEqual({});
    expect(await readFile(path.join(root, "wiki/concepts.moved/page.md"), "utf8")).toBe(BODY);
  });
});
