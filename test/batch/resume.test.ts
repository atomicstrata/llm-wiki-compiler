/**
 * @file test/batch/resume.test.ts
 * @description A batch compile interrupted at a checkpoint boundary (an
 * injected failure as a phase advances) resumes from its committed cursor
 * and still leaves exactly what the incumbent leaves; one interrupted AFTER
 * its state commit finishes its residual work; a resumed run whose source
 * changed refuses (`compile_batch_inputs_changed`) until `restart`
 * supersedes it. (Process-kill journeys run out of process.)
 */

import { readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import type { BatchPhase } from "../../src/compiler/batch/contracts.js";
import { compileUnderTestProvider, expectResumeParity, failAdvanceInto, makeTwin, snapshotOf, sourceNaming, stubDeterministicProvider, useTwinFixture, type Twin } from "./helpers.js";

/** Each durable segment commit costs ~1.2 s on the loaded test volume; a case runs three compiles. */
const RESUME_TIMEOUT_MS = 900_000;

/** A batch compile refreshes no embeddings; both twins compile with them off. */
const OFF = { embeddings: false } as const;

const SOURCES = {
  "one.md": sourceNaming("One", "Shared Idea", "One Thing"),
  "two.md": sourceNaming("Two", "Shared Idea"),
  "three.md": sourceNaming("Three", "Third Idea"),
};

let twin: Twin;

useTwinFixture(() => twin);

/** Interrupt the segmented twin's compile before `phase`, then resume it; expect parity with the plain twin. */
async function interruptThenResume(phase: BatchPhase): Promise<void> {
  twin = await makeTwin(SOURCES);
  await expectResumeParity(twin, phase);
}

describe("batch compile resume", () => {
  it("resumes a run interrupted after page generation", () => interruptThenResume("plan-state"), RESUME_TIMEOUT_MS);

  it("finishes a run interrupted after its state commit", () => interruptThenResume("residual"), RESUME_TIMEOUT_MS);

  it("refuses a resumed run whose source changed, until restart supersedes it", async () => {
    twin = await makeTwin(SOURCES);
    stubDeterministicProvider();
    failAdvanceInto("generate");
    await expect(compileUnderTestProvider(twin.segmented, { batchSize: 1, ...OFF })).rejects.toThrow("injected failure before generate");
    const edited = sourceNaming("Two", "Shared Idea", "Late Idea");
    for (const root of [twin.plain, twin.segmented]) await writeFile(path.join(root, "sources", "two.md"), edited);
    await expect(compileUnderTestProvider(twin.segmented, OFF)).rejects.toThrow(/compile_batch_inputs_changed/);
    const restarted = await compileUnderTestProvider(twin.segmented, { restart: true, ...OFF });
    expect(restarted).toMatchObject({ mode: "batch", batch: { phase: "done" } });
    await compileUnderTestProvider(twin.plain, OFF);
    expect(await snapshotOf(twin.segmented)).toEqual(await snapshotOf(twin.plain));
  }, RESUME_TIMEOUT_MS);

  it.each([
    ["added", (root: string) => writeFile(path.join(root, "sources", "four.md"), sourceNaming("Four", "Fourth Idea"))],
    ["deleted", (root: string) => unlink(path.join(root, "sources", "three.md"))],
  ])("refuses a run resumed after its listing when a source was %s (no identity digest yet)", async (_label, change) => {
    twin = await makeTwin(SOURCES);
    stubDeterministicProvider();
    failAdvanceInto("detect");
    await expect(compileUnderTestProvider(twin.segmented, OFF)).rejects.toThrow("injected failure before detect");
    await change(twin.segmented);
    await expect(compileUnderTestProvider(twin.segmented, OFF)).rejects.toThrow(/compile_batch_inputs_changed/);
    expect(await readdir(path.join(twin.segmented, "wiki", "concepts"))).toEqual([]);
  }, RESUME_TIMEOUT_MS);
});
