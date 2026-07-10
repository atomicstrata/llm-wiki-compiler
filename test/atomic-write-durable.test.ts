/**
 * @file test/atomic-write-durable.test.ts
 * @description Regression tests for the OPT-IN power-loss durability of
 * {@link atomicWrite} (`{ durable: true }`) and its threading from `writeRun`.
 *
 * fsync itself is not directly observable in a unit test, so these assert the
 * BEHAVIOUR around it: `durable: true` is accepted, the write path does not error,
 * and the content round-trips byte-for-byte. A separate test spies on `atomicWrite`
 * to prove `writeRun` (the run-record source of truth) threads `durable: true`.
 */

import { describe, it, expect, vi } from "vitest";
import { readFile } from "fs/promises";
import path from "path";
import { atomicWrite } from "../src/utils/markdown.js";
import * as markdown from "../src/utils/markdown.js";
import { writeRun, readRun } from "../src/workflows/store.js";
import { startWorkflow } from "../src/workflows/start.js";
import { buildWorkflowProfile, installWorkflowProfile } from "./fixtures/workflow-profile.js";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { useConfinementRoots } from "./fixtures/confinement-roots.js";
import type { WorkflowRun } from "../src/workflows/types.js";

const ctx = useConfinementRoots("durable-write");

describe("atomicWrite durable:true", () => {
  it("accepts durable:true and round-trips the content", async () => {
    const target = path.join(ctx.root, "page.md");
    await atomicWrite(target, "durable body", { durable: true });
    expect(await readFile(target, "utf-8")).toBe("durable body");
  });

  it("durable:true composes with confineRoot and still writes correctly", async () => {
    const target = path.join(ctx.root, "nested", "doc.md");
    await atomicWrite(target, "confined+durable", { durable: true, confineRoot: ctx.root });
    expect(await readFile(target, "utf-8")).toBe("confined+durable");
  });
});

describe("writeRun threads durable:true", () => {
  it("calls atomicWrite with durable:true for the run record", async () => {
    const root = await makeTempRoot("wf-durable-run");
    await installWorkflowProfile(root, buildWorkflowProfile([{ id: "run", reads: [], writes: ["experiments"] }]));
    const run = await startWorkflow(root, "build", {});
    const read = await readRun(root, run.runId);
    if (read.status !== "ok") throw new Error("run unreadable");

    const spy = vi.spyOn(markdown, "atomicWrite");
    try {
      await writeRun(root, read.run as WorkflowRun);
      expect(spy).toHaveBeenCalled();
      const opts = spy.mock.calls.at(-1)?.[2];
      expect(opts?.durable).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
