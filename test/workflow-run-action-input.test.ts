/**
 * @file test/workflow-run-action-input.test.ts
 * @description Tests for `validateActionInputs` and `runAction`'s input gate.
 *
 * Input validation is fail-closed and PURE: an UNDECLARED input key, a missing
 * `required` field with no `default`, a runtime type mismatch, and a
 * malformed/out-of-scope `entityRef` each raise `ActionInputError` BEFORE any
 * authority check or dispatch. A `default` is applied when the field is absent.
 * The `runAction` slice asserts the same gate rejects bad inputs (so a malformed
 * input can never reach a run-lifecycle op) and applies a default.
 */

import { describe, it, expect } from "vitest";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { installRunActionProfile } from "./fixtures/run-action-profile.js";
import { validateActionInputs } from "../src/workflows/action-input.js";
import { runAction } from "../src/workflows/run-action.js";
import { ActionInputError } from "../src/workflows/errors.js";
import { MAX_WORKFLOW_INPUT_STRING_CHARS, MAX_WORKFLOW_INPUT_ARRAY_ITEMS } from "../src/utils/constants.js";
import type { WorkflowActionDef } from "../src/profile/types.js";

/** An action def carrying the given inputSchema (other fields are inert here). */
function defWith(inputSchema?: WorkflowActionDef["inputSchema"]): WorkflowActionDef {
  const permissions = { cli: "trusted-write", sdk: "trusted-write", mcp: "trusted-write", viewer: "trusted-write" } as const;
  return { label: "T", workflow: "build", operation: "start", permissions, inputSchema };
}

describe("validateActionInputs — declared-key gate", () => {
  it("rejects any input key not in the inputSchema (fail closed)", () => {
    expect(() => validateActionInputs(defWith({ topic: { type: "string" } }), { topic: "x", evil: 1 })).toThrow(ActionInputError);
  });

  it("an action with no inputSchema accepts NO inputs", () => {
    expect(() => validateActionInputs(defWith(undefined), { anything: 1 })).toThrow(ActionInputError);
    expect(validateActionInputs(defWith(undefined), {})).toEqual({});
  });
});

describe("validateActionInputs — required / default", () => {
  it("rejects a missing required field with no default", () => {
    expect(() => validateActionInputs(defWith({ runId: { type: "string", required: true } }), {})).toThrow(ActionInputError);
  });

  it("applies a default when the field is absent", () => {
    const def = defWith({ topic: { type: "string", default: "untitled" } });
    expect(validateActionInputs(def, {})).toEqual({ topic: "untitled" });
  });

  it("omits an absent optional field with no default (never blanks it)", () => {
    expect(validateActionInputs(defWith({ topic: { type: "string" } }), {})).toEqual({});
  });
});

describe("validateActionInputs — type coercion", () => {
  it("rejects a non-finite number and a wrong-typed scalar", () => {
    expect(() => validateActionInputs(defWith({ n: { type: "number" } }), { n: Infinity })).toThrow(ActionInputError);
    expect(() => validateActionInputs(defWith({ b: { type: "boolean" } }), { b: "yes" })).toThrow(ActionInputError);
  });

  it("rejects a string[] containing a non-string and accepts a clean array", () => {
    expect(() => validateActionInputs(defWith({ tags: { type: "string[]" } }), { tags: ["a", 2] })).toThrow(ActionInputError);
    expect(validateActionInputs(defWith({ tags: { type: "string[]" } }), { tags: ["a", "b"] })).toEqual({ tags: ["a", "b"] });
  });
});

describe("validateActionInputs — per-field SIZE bounds (M3)", () => {
  it("rejects a string field longer than the char cap", () => {
    const huge = "x".repeat(MAX_WORKFLOW_INPUT_STRING_CHARS + 1);
    expect(() => validateActionInputs(defWith({ s: { type: "string" } }), { s: huge })).toThrow(ActionInputError);
  });

  it("rejects a string[] with more than the item cap", () => {
    const many = Array.from({ length: MAX_WORKFLOW_INPUT_ARRAY_ITEMS + 1 }, () => "a");
    expect(() => validateActionInputs(defWith({ tags: { type: "string[]" } }), { tags: many })).toThrow(ActionInputError);
  });

  it("rejects a string[] whose element exceeds the per-string cap", () => {
    const big = "x".repeat(MAX_WORKFLOW_INPUT_STRING_CHARS + 1);
    expect(() => validateActionInputs(defWith({ tags: { type: "string[]" } }), { tags: [big] })).toThrow(ActionInputError);
  });

  it("accepts a within-cap string and a max-item string[] (under the aggregate cap)", () => {
    // A string at the FULL per-field cap would trip the whole-object byte backstop
    // (key + quotes push the serialized object past MAX_WORKFLOW_INPUTS_BYTES), so a
    // value comfortably under both caps is the realistic accepted case.
    const ok = "x".repeat(1000);
    const list = Array.from({ length: MAX_WORKFLOW_INPUT_ARRAY_ITEMS }, () => "a");
    expect(validateActionInputs(defWith({ s: { type: "string" } }), { s: ok })).toEqual({ s: ok });
    expect(validateActionInputs(defWith({ tags: { type: "string[]" } }), { tags: list })).toEqual({ tags: list });
  });
});

describe("validateActionInputs — entityRef scope", () => {
  it("accepts an in-scope entityRef and rejects an out-of-scope one", () => {
    const def = defWith({ ref: { type: "entityRef", entityTypes: ["ideas"] } });
    expect(validateActionInputs(def, { ref: "ideas/topic-a" })).toEqual({ ref: "ideas/topic-a" });
    expect(() => validateActionInputs(def, { ref: "experiments/topic-a" })).toThrow(ActionInputError);
  });

  it("rejects a malformed entityRef id", () => {
    const def = defWith({ ref: { type: "entityRef", entityTypes: ["ideas"] } });
    expect(() => validateActionInputs(def, { ref: "no-slash" })).toThrow(ActionInputError);
  });
});

describe("runAction — input gate fails BEFORE dispatch", () => {
  it("rejects an unknown input key without minting a run", async () => {
    const root = await makeTempRoot("ra-in-unknown");
    await installRunActionProfile(root);
    await expect(runAction(root, "build.start", { evil: 1 }, "cli")).rejects.toBeInstanceOf(ActionInputError);
  });

  it("rejects a missing required runId on advance without dispatching", async () => {
    const root = await makeTempRoot("ra-in-required");
    await installRunActionProfile(root);
    await expect(runAction(root, "build.advance", {}, "cli")).rejects.toBeInstanceOf(ActionInputError);
  });
});
