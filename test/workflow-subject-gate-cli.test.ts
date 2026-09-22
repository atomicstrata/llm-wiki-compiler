/**
 * @file test/workflow-subject-gate-cli.test.ts
 * @description Subprocess witness that the shipped generic gate command runs
 * subject verification before its TTY challenge, so CLI approval cannot bypass
 * a missing core verifier receipt.
 */

import { afterEach, describe, expect, it } from "vitest";
import { useTempRoot } from "./fixtures/temp-root.js";
import { runCLI } from "./fixtures/run-cli.js";
import { advanceWorkflow } from "../src/workflows/advance.js";
import { readRun } from "../src/workflows/store.js";
import { recordSubjectSnapshot } from "./fixtures/subject-gate-product.js";

const root = useTempRoot();
afterEach(() => { delete process.env.LLMWIKI_TRUSTED_WRITE; });
/** Create a review-stage run whose artifact contains a forged verdict but no receipt. */
async function runWithoutReceipt() {
  const submitted = await recordSubjectSnapshot(
    root.dir, '{"coverage":"complete","verdict":"accepted"}', "forged",
  );
  return (await advanceWorkflow(root.dir, submitted.run.runId)).run;
}

describe("subject-bound gate CLI", () => {
  it("refuses a forged accepted artifact before prompting or mutating", async () => {
    const run = await runWithoutReceipt();
    const before = await readRun(root.dir, run.runId);
    const result = await runCLI(["workflow", "gate", "approve", run.runId, "editor"], root.dir);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/receipt-missing/);
    expect(result.stdout).not.toMatch(/Type this token/);
    expect(await readRun(root.dir, run.runId)).toEqual(before);
  });
});
