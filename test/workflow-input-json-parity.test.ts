/**
 * Legacy workflow SDK input serialization stays compatible while the approved
 * pre-await snapshot prevents caller mutation and hidden-field disclosure.
 * Assertions read the persisted run, not merely the returned in-memory copy.
 */
import { describe, expect, it } from "vitest";
import { startWorkflow } from "../src/workflows/start.js";
import { snapshotWorkflowInputs } from "../src/workflows/input-snapshot.js";
import { WorkflowInputBoundsError } from "../src/workflows/input-bounds.js";
import { deepCaptureData, RuntimeCaptureError } from "../src/utils/runtime-capture.js";
import { runAction } from "../src/workflows/run-action.js";
import { installRunActionProfile } from "./fixtures/run-action-profile.js";
import { useWorkflowRoot, readOkRun, ADAPT_BUILD_STAGES } from "./fixtures/workflow-profile.js";

const ctx = useWorkflowRoot("workflow-json-parity-", ADAPT_BUILD_STAGES);

/** A hidden property must never become an enumerable stored field. */
function hiddenRecord(): Record<string, unknown> {
  return Object.defineProperty({ visible: 1 }, "hidden", { value: "private", enumerable: false });
}

describe("workflow JSON input snapshots", () => {
  it.each([
    ["date", () => ({ value: new Date("2026-01-01T00:00:00Z") }), { value: "2026-01-01T00:00:00.000Z" }],
    ["getter", () => ({ get count() { return 1; } }), { count: 1 }],
    ["hidden", hiddenRecord, { visible: 1 }],
    ["nested hidden", () => ({ nested: hiddenRecord() }), { nested: { visible: 1 } }],
    ["toJSON", () => ({ value: { toJSON: () => "custom" } }), { value: "custom" }],
    ["sparse", () => ({ value: [, "second"] }), { value: [null, "second"] }],
    ["function", () => ({ value: 1, ignored: () => 2 }), { value: 1 }],
  ] as const)("persists the JSON representation: %s", async (_label, create, expected) => {
    const run = await startWorkflow(ctx.root, "build", create());
    expect(run.inputs).toEqual(expected);
    expect((await readOkRun(ctx.root, run.runId)).inputs).toEqual(expected);
  });

  it.each([NaN, Infinity, -Infinity])("does not normalize non-finite %s to null", (value) => {
    expect(() => snapshotWorkflowInputs({ value }))
      .toThrow(Number.isNaN(value) ? "NaN is not allowed" : "Infinity is not allowed");
  });

  it("bounds an arbitrarily deep tree produced by toJSON before stack overflow", () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < 20_000; i++) deep = { child: deep };
    expect(() => snapshotWorkflowInputs({ value: { toJSON: () => deep } }))
      .toThrow(WorkflowInputBoundsError);
  });

  it("keeps strict opt-in capture from exposing top-level or nested hidden data", () => {
    expect(() => deepCaptureData(hiddenRecord())).toThrow(RuntimeCaptureError);
    expect(() => deepCaptureData({ nested: hiddenRecord() })).toThrow(RuntimeCaptureError);
  });

  it("keeps action unknown-key checks even for JSON-omitted values", async () => {
    await installRunActionProfile(ctx.root);
    await expect(runAction(ctx.root, "build.startn", { count: 1, unknown: undefined }, "cli"))
      .rejects.toThrow("unknown input 'unknown'");
  });

  it("does not turn invalid action values into valid schema types", async () => {
    await installRunActionProfile(ctx.root);
    await expect(runAction(ctx.root, "build.statusone", { runId: new Date() }, "cli"))
      .rejects.toThrow("input 'runId' is not a string");
  });

  it("omits hidden action fields instead of treating them as unknown keys", async () => {
    await installRunActionProfile(ctx.root);
    const inputs = Object.defineProperty({ count: 1 }, "hidden", { value: "private" });
    const result = await runAction(ctx.root, "build.startn", inputs, "cli");
    const run = await readOkRun(ctx.root, (result.result as { runId: string }).runId);
    expect(run.inputs).toEqual({ count: 1 });
  });
});
