/**
 * Integration tests for src/eval/index.ts — runEval record flag.
 *
 * Verifies that runEval does not write to history.jsonl by default (record=false),
 * and does write when record=true.
 */

import { existsSync } from "fs";
import path from "path";
import { runEval } from "../src/eval/index.js";
import { useLintTempRoot } from "./fixtures/lint-temp-root.js";

describe("runEval record flag", () => {
  const env = useLintTempRoot("eval-run");
  const historyPath = () => path.join(env.dir, ".llmwiki", "eval", "history.jsonl");

  it("does NOT write history when record is false", async () => {
    await runEval(env.dir, "fast", 20, false);
    expect(existsSync(historyPath())).toBe(false);
  });

  it("writes history when record is true", async () => {
    await runEval(env.dir, "fast", 20, true);
    expect(existsSync(historyPath())).toBe(true);
  });
});
