/**
 * @file test/workflow-input-bounds.test.ts
 * @description Unit coverage for the RAW workflow-input bounds (M3).
 *
 * The pre-parse byte guard and the post-parse depth guard fail CLOSED with a
 * `WorkflowInputBoundsError` BEFORE a payload is materialized/stringified, so the
 * CLI/MCP surfaces reject an oversize or deeply-nested payload without a crash.
 * A within-bounds payload passes both guards untouched.
 */

import { describe, it, expect } from "vitest";
import {
  assertRawInputJsonWithinBounds,
  assertInputDepthWithinBounds,
  WorkflowInputBoundsError,
} from "../src/workflows/input-bounds.js";
import { startWorkflow } from "../src/workflows/start.js";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { installWorkflowProfile, buildWorkflowProfile } from "./fixtures/workflow-profile.js";
import { MAX_WORKFLOW_INPUTS_BYTES, MAX_WORKFLOW_INPUT_DEPTH } from "../src/utils/constants.js";

/** Build an object nested exactly `depth` levels deep (`{a:{a:{...:1}}}`). */
function nest(depth: number): Record<string, unknown> {
  let inner: unknown = 1;
  for (let i = 0; i < depth; i++) inner = { a: inner };
  return inner as Record<string, unknown>;
}

describe("assertRawInputJsonWithinBounds — pre-parse byte cap", () => {
  it("throws WorkflowInputBoundsError for a raw string over the byte cap", () => {
    const raw = "x".repeat(MAX_WORKFLOW_INPUTS_BYTES + 1);
    expect(() => assertRawInputJsonWithinBounds(raw)).toThrow(WorkflowInputBoundsError);
  });

  it("accepts a raw string at the byte cap", () => {
    expect(() => assertRawInputJsonWithinBounds("x".repeat(MAX_WORKFLOW_INPUTS_BYTES))).not.toThrow();
  });
});

describe("assertInputDepthWithinBounds — post-parse depth cap", () => {
  it("throws WorkflowInputBoundsError past the depth cap (no overflow)", () => {
    expect(() => assertInputDepthWithinBounds(nest(MAX_WORKFLOW_INPUT_DEPTH + 2))).toThrow(WorkflowInputBoundsError);
  });

  it("accepts an object at the depth cap and a flat object", () => {
    expect(() => assertInputDepthWithinBounds(nest(MAX_WORKFLOW_INPUT_DEPTH))).not.toThrow();
    expect(() => assertInputDepthWithinBounds({ a: 1, b: ["x", "y"] })).not.toThrow();
  });
});

describe("startWorkflow — SDK/direct start path bounds inputs (R7 sibling surface)", () => {
  it("rejects deeply-nested SDK start inputs with WorkflowInputBoundsError (before the stringify)", async () => {
    const root = await makeTempRoot("wf-start-deep-inputs");
    await installWorkflowProfile(root, buildWorkflowProfile([{ id: "draft", reads: ["ideas"], writes: [] }]));
    await expect(
      startWorkflow(root, "build", nest(MAX_WORKFLOW_INPUT_DEPTH + 2)),
    ).rejects.toBeInstanceOf(WorkflowInputBoundsError);
  });
});
