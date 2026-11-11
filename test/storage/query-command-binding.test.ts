/**
 * @file test/storage/query-command-binding.test.ts
 * @description The `llmwiki query` CLI controller as ONE body over its project
 * steps, `queryCommandWith` over `QueryCommandSteps`, with no project. This file
 * uses the body, which exists only after the controller was given its steps, so
 * it has NO before-edit run.
 *
 * HOW IT IS BUILT. Memory steps answer the index look and the answer pipeline and
 * log each call; terminal status lines are captured. Every decision is pinned
 * with the steps it reached: the save-option refusal before any step, the
 * missing-index guard (its message and a normal return with the exit code
 * untouched, never reaching the answer), the answer request the controller
 * builds, the no-match message, and a publication refusal's exit code. The
 * composition is shown reaching the answer pipeline's own body, and the root form
 * the incumbent index look and answer reads with its root.
 *
 * NOT SHOWN HERE: selection, hydration, the answer LLM and publication; the query
 * suites show those.
 */

import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import queryCommand, { queryCommandStepsOver, queryCommandWith, type QueryCommandSteps } from "../../src/commands/query.js";
import * as queryReads from "../../src/commands/query-reads.js";
import * as diskLocations from "../../src/storage/disk-locations.js";
import { INDEX_FILE } from "../../src/utils/constants.js";
import * as output from "../../src/utils/output.js";

const MISSING = "Wiki index not found. Run `llmwiki compile` first.";

let lines: string[];
beforeEach(() => {
  lines = [];
  vi.spyOn(output, "status").mockImplementation((_icon, message) => { lines.push(String(message)); });
  vi.spyOn(output, "header").mockImplementation(() => {});
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  process.exitCode = 0;
});
afterEach(() => { vi.restoreAllMocks(); });

/** Memory steps: an index that is there or not, and an answer pipeline returning `result`. Each call logged. */
function stepsOf(log: string[], indexExists: boolean, result: object = { answer: "an answer" }): QueryCommandSteps {
  return {
    indexExists: () => { log.push("index"); return indexExists; },
    answer: async (question, options) => {
      log.push(`answer ${question} save=${options.save} review=${options.review} debug=${options.debug} streams=${typeof options.onToken}`);
      return result as never;
    },
  };
}

describe("the query controller over its steps", () => {
  it("Q1 refuses review without save before any step", async () => {
    const log: string[] = [];
    await expect(queryCommandWith(stepsOf(log, true), "why?", { review: true })).rejects.toThrow("Query review requires save.");
    expect(log).toEqual([]);
  });

  it("Q2 a missing index prints the guard's message and returns normally, never reaching the answer", async () => {
    const log: string[] = [];
    expect(await queryCommandWith(stepsOf(log, false), "why?", { save: true })).toBeUndefined();
    expect([log, lines.some((line) => line.includes(MISSING)), process.exitCode]).toEqual([["index"], true, 0]);
  });

  it("Q3 asks the answer pipeline with the command's options and a streaming callback; no answer is a message, not a failure", async () => {
    const log: string[] = [];
    await queryCommandWith(stepsOf(log, true), "why?", { save: true, review: true, debug: false });
    await queryCommandWith(stepsOf(log, true, { answer: "" }), "how?", {});
    expect(log).toEqual(["index", "answer why? save=true review=true debug=false streams=function", "index", "answer how? save=undefined review=undefined debug=undefined streams=function"]);
    expect([lines.some((line) => line.includes("No matching pages found")), process.exitCode]).toEqual([true, 0]);
  });

  it("Q4 a publication refusal other than a disabled profile sets exit code 1", async () => {
    await queryCommandWith(stepsOf([], true, { answer: "a", publicationRefusal: { code: "invalid-citation", message: "refused" } }), "why?", { save: true });
    expect([process.exitCode, lines.some((line) => line.includes("refused"))]).toEqual([1, true]);
  });
});

/** Answer reads whose index look answers `present` and whose every other read is a test failure. */
const readsWithIndex = (present: boolean) => new Proxy({ indexPresent: async () => present }, {
  get: (target, name) => (name in target ? target[name as "indexPresent"] : () => { throw new Error(`unasked read ${String(name)}`); }),
}) as never;

describe("the composition and the root form", () => {
  it("B1 the composition reaches the answer pipeline's own body, whose index refusal throws where the controller's guard returns", async () => {
    await expect(queryCommandWith(queryCommandStepsOver(readsWithIndex(false), () => true), "why?", {})).rejects.toThrow(MISSING);
    expect(await queryCommandWith(queryCommandStepsOver(readsWithIndex(false), () => false), "why?", {})).toBeUndefined();
  });

  it("B2 the root form looks for the index under its root and reads the answer through the root's answer reads", async () => {
    const look = vi.spyOn(diskLocations, "locationExistsSync").mockReturnValue(true);
    const reads = vi.spyOn(queryReads, "diskQueryAnswerReads").mockReturnValue(readsWithIndex(false));
    await expect(queryCommand("/project", "why?", {})).rejects.toThrow(MISSING);
    expect([look.mock.calls, reads.mock.calls]).toEqual([[[path.join("/project", INDEX_FILE)]], [["/project"]]]);
  });
});
