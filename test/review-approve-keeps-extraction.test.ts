/**
 * @file test/review-approve-keeps-extraction.test.ts
 * @description Approving a shared-page candidate must not throw away the
 * saved extraction of co-owners whose bytes and concepts it leaves unchanged.
 *
 * Approval rewrites every contributing source's state entry. It used to drop
 * the extraction snapshot there, so after any approval each co-owner was
 * re-extracted on the next compile that touched the shared page, even though
 * nothing about it had changed. Runs the real compile, review and approve
 * paths with only the model stubbed.
 */
import { describe, expect, it, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { compileAndReport } from "../src/compiler/index.js";
import { listCandidates } from "../src/compiler/candidate-read.js";
import reviewApproveCommand from "../src/commands/review-approve.js";
import { approveBatch } from "./fixtures/review-batch.js";
import { readState } from "../src/utils/state.js";
import { mockSharedConceptProvider, useReconciliationProject } from "./fixtures/reconciliation-project.js";

const ctx = useReconciliationProject({
  dirSuffix: "approve-keeps-extraction", sourceFile: "alpha.md",
  sourceContent: "# Alpha\n\nAlpha evidence about the shared subject.",
});

/** Write a source whose body names it, so the stub can tell sources apart. */
async function addSource(name: string): Promise<void> {
  await writeFile(path.join(ctx.dir, `sources/${name.toLowerCase()}.md`), `# ${name}\n\n${name} evidence about the shared subject.`);
}

/** Approve every pending candidate, run from the project root as the CLI would be. */
async function approveAll(mode: "single" | "batch"): Promise<void> {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const previous = process.cwd();
  process.chdir(ctx.dir);
  try {
    const candidates = await listCandidates(ctx.dir);
    if (mode === "batch") {
      expect((await approveBatch(ctx.dir, ...candidates.map(candidate => candidate.id))).status).toBe("completed");
    } else {
      for (const candidate of candidates) await reviewApproveCommand(candidate.id);
    }
  } finally {
    process.chdir(previous);
  }
  expect(process.exitCode ?? 0).toBe(0);
}

describe("review approval keeps unchanged co-owner extraction", () => {
  it.each(["single", "batch"] as const)("%s approval leaves shared-page co-owners reusable on the next compile", async mode => {
    const provider = mockSharedConceptProvider(["Alpha", "Beta", "Gamma", "Delta"]);
    await addSource("Beta");
    await compileAndReport(ctx.dir);
    await addSource("Gamma");
    await compileAndReport(ctx.dir, { review: true });
    await approveAll(mode);
    const state = (await readState(ctx.dir)).sources;
    expect(state["gamma.md"].concepts).toEqual(expect.arrayContaining(["shared", "gamma"]));
    expect(state["alpha.md"].extraction).toBeDefined();
    expect(state["beta.md"].extraction).toBeDefined();
    provider.toolCall.mockClear();
    await addSource("Delta");
    expect((await compileAndReport(ctx.dir)).errors).toEqual([]);
    const extracted = provider.toolCall.mock.calls.map(([system]) => system.split("--- SOURCE DOCUMENT ---")[1]);
    expect(extracted.some((source) => source.includes("Alpha") || source.includes("Beta"))).toBe(false);
  });
});
