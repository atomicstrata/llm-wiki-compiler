/**
 * Compiled-CLI witnesses for the explicit candidate selector and advisory failure
 * report. Network-free runs use fast mode or an intentionally unconfigured provider.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { writeCandidate } from "../src/compiler/candidates.js";
import { useLintTempRoot } from "./fixtures/lint-temp-root.js";
import { runCLI, expectCLIExit } from "./fixtures/run-cli.js";

describe("eval --candidates CLI", () => {
  const env = useLintTempRoot("candidate-eval-cli");

  /** Stage one source-backed draft without introducing any live page. */
  async function stage() {
    await env.writeSource("ref.md", "Evidence.");
    return writeCandidate(env.dir, { title: "Pending", slug: "pending", summary: "", sources: ["ref.md"],
      body: "This claim has evidence. ^[ref.md:1-1]" });
  }

  it("routes fast JSON to pending drafts, not the default live evaluation", async () => {
    const candidate = await stage();
    const result = await runCLI(["eval", "--candidates", "--out", "json"], env.dir);
    expectCLIExit(result, 0);
    const report = JSON.parse(result.stdout);
    expect(report.selection).toBe("candidates");
    expect(report.candidates[0].id).toBe(candidate.id);
    expect(report.coverage.eligiblePairs).toBe(1);
    expect(report.meanScore).toBeNull();
    expect(report.health).toBeUndefined();
    await expect(readFile(path.join(env.dir, ".llmwiki/eval/history.jsonl"))).rejects.toThrow();
  });

  it("retains structured errors with exit 1 when the judge is unavailable", async () => {
    await stage();
    const result = await runCLI(["eval", "--candidates", "--suite", "full", "--out", "json"], env.dir,
      { LLMWIKI_PROVIDER: "minimax", MINIMAX_API_KEY: "" });
    expectCLIExit(result, 1);
    const report = JSON.parse(result.stdout);
    expect(report.coverage.judgeErrors).toBe(1);
    expect(report.judgeUnavailable).toContain("MINIMAX_API_KEY");
    expect(report.meanScore).toBeNull();
    expect(report.assessments[0].status).toBe("judge-error");
  });
});
