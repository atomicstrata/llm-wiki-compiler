/**
 * @file test/workflow-run-action-capture.test.ts
 * @description D-10-9 for `runAction`'s caller inputs.
 *
 * `runAction` retains the caller's `inputs` object across `await loadProfile()`
 * and only then validates it, so a caller that mutates its own object after the
 * call returns changes what is validated, dispatched and DURABLY RECORDED. That
 * is not a contract falsity: the run on disk carries a value the caller never
 * asked for.
 */

import { describe, expect, it } from "vitest";
import { readRun } from "../src/workflows/store.js";
import { runAction } from "../src/workflows/run-action.js";
import { startWorkflow } from "../src/workflows/start.js";
import { WorkflowInputBoundsError } from "../src/workflows/input-bounds.js";
import { ActionInputError } from "../src/workflows/errors.js";
import { installRunActionProfile } from "./fixtures/run-action-profile.js";
import { makeTempRoot } from "./fixtures/temp-root.js";

/** The inputs the run durably recorded, read back off disk. */
async function recordedInputs(root: string, runId: string): Promise<Record<string, unknown>> {
  const read = await readRun(root, runId);
  if (read.status !== "ok") throw new Error(`run ${read.status}`);
  return read.run.inputs;
}

/** The `count` the run durably recorded. */
async function recordedCount(root: string, runId: string): Promise<unknown> {
  return (await recordedInputs(root, runId)).count;
}

/** The `tags` the run durably recorded. */
async function recordedTags(root: string, runId: string): Promise<unknown> {
  return (await recordedInputs(root, runId)).tags;
}

describe("runAction captures its inputs before the first await", () => {
  it("records the value the caller supplied, not one written after the call", async () => {
    const root = await makeTempRoot("runaction-capture-mutate");
    await installRunActionProfile(root);
    const inputs: Record<string, unknown> = { count: 1 };

    const pending = runAction(root, "build.startn", inputs, "cli");
    // Synchronously after the call returns, before any await resolves — the
    // window `loadProfile` opens between entry and validation.
    inputs.count = 2;
    const result = await pending;

    const runId = (result.result as { runId: string }).runId;
    expect(await recordedCount(root, runId)).toBe(1);
  });

  // THE DEPTH CASE. A top-level snapshot copies `count` by value and would leave
  // `tags` aliased to the caller's array, so this is what decides that the
  // capture has to be DEEP rather than a one-level own-data read.
  it("records the array the caller supplied, not one mutated after the call", async () => {
    const root = await makeTempRoot("runaction-capture-deep");
    await installRunActionProfile(root);
    const tags = ["original"];
    const inputs: Record<string, unknown> = { count: 1, tags };

    const pending = runAction(root, "build.startn", inputs, "cli");
    tags[0] = "substituted";
    const result = await pending;

    const runId = (result.result as { runId: string }).runId;
    expect(await recordedTags(root, runId)).toEqual(["original"]);
  });

  // Legacy getters remain supported, but no caller code runs after the snapshot.
  it("resolves legacy accessors before the first await", async () => {
    const root = await makeTempRoot("runaction-capture-accessor");
    await installRunActionProfile(root);
    let reads = 0;
    const inputs: Record<string, unknown> = {};
    Object.defineProperty(inputs, "count", {
      enumerable: true, configurable: true,
      get() { reads += 1; return 1; },
    });

    const pending = runAction(root, "build.startn", inputs, "cli");
    const capturedReads = reads;
    const result = await pending;
    expect(capturedReads).toBeGreaterThan(0);
    expect(reads).toBe(capturedReads);
    expect(await recordedCount(root, (result.result as { runId: string }).runId)).toBe(1);
  });
});

/**
 * The SAME defect on the OTHER surface, proved independently.
 *
 * `startWorkflow` is a public SDK method (`wiki.workflows.startWorkflow`) that
 * does NOT route through `runAction` and has no `inputSchema` at all, so nothing
 * in the `runAction` fix reaches it. Its window is also wider: the first await is
 * a BLOCKING LOCK acquisition, so the caller can rewrite its object for as long
 * as the project lock stays contended.
 */
describe("startWorkflow captures its inputs before the first await", () => {
  it("records the value the caller supplied, not one written after the call", async () => {
    const root = await makeTempRoot("start-capture-mutate");
    await installRunActionProfile(root);
    const inputs: Record<string, unknown> = { count: 1 };

    const pending = startWorkflow(root, "build", inputs);
    inputs.count = 2;
    const run = await pending;

    expect(await recordedCount(root, run.runId)).toBe(1);
  });

  it("records the array the caller supplied, not one mutated after the call", async () => {
    const root = await makeTempRoot("start-capture-deep");
    await installRunActionProfile(root);
    const tags = ["original"];

    const pending = startWorkflow(root, "build", { tags });
    tags[0] = "substituted";
    const run = await pending;

    expect(await recordedTags(root, run.runId)).toEqual(["original"]);
  });

  it("resolves legacy accessors before the first await", async () => {
    const root = await makeTempRoot("start-capture-accessor");
    await installRunActionProfile(root);
    let reads = 0;
    const inputs: Record<string, unknown> = {};
    Object.defineProperty(inputs, "viaGetter", {
      enumerable: true, configurable: true,
      get() { reads += 1; return "getter-value"; },
    });

    const pending = startWorkflow(root, "build", inputs);
    const capturedReads = reads;
    const run = await pending;
    expect(capturedReads).toBeGreaterThan(0);
    expect(reads).toBe(capturedReads);
    expect(await recordedInputs(root, run.runId)).toEqual({ viaGetter: "getter-value" });
  });
});

/**
 * The ORDERING hazard the capture creates, on both surfaces.
 *
 * Both surfaces already refuse an over-deep input, and both did so through a
 * guard that never recurses far: the depth check short-circuits at its cap and
 * the action validator rejects the undeclared key outright. Putting a RECURSIVE
 * capture in front of them moved the first deep traversal earlier, and a 20,000
 * level input then overflowed the stack — turning a typed refusal into a raw
 * `RangeError` out of a public boundary. The capture is depth-bounded for that
 * reason; these cases pin the boundary's answer rather than the primitive's.
 */
describe("an over-deep input is still refused by type, not by stack overflow", () => {
  /** An input object nested `depth` levels deep. */
  const deepInput = (depth: number): Record<string, unknown> => {
    let node: Record<string, unknown> = { leaf: 1 };
    for (let index = 0; index < depth; index += 1) node = { nested: node };
    return node;
  };

  it("startWorkflow raises its own bounds error", async () => {
    const root = await makeTempRoot("start-capture-depth");
    await installRunActionProfile(root);

    await expect(startWorkflow(root, "build", deepInput(20_000)))
      .rejects.toBeInstanceOf(WorkflowInputBoundsError);
  });

  it("runAction raises its own input error", async () => {
    const root = await makeTempRoot("runaction-capture-depth");
    await installRunActionProfile(root);

    await expect(runAction(root, "build.startn", deepInput(20_000), "cli"))
      .rejects.toBeInstanceOf(ActionInputError);
  });
});
