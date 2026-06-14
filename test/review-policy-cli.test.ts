/**
 * Subprocess coverage for compile-time review policy.
 *
 * The CLI path is exercised with aimock rather than a live LLM. This pins the
 * user-facing contract that policy-held pages are reported loudly during a
 * normal `llmwiki compile` run.
 */

import { describe, it, expect } from "vitest";
import { access, mkdir, readFile, readdir, writeFile } from "fs/promises";
import path from "path";
import { mockClaudeEnv, useAimockLifecycle } from "./fixtures/aimock-helper.js";
import { runCLI, expectCLIExit } from "./fixtures/run-cli.js";
import type { ReviewCandidate } from "../src/utils/types.js";
import type { WikiState } from "../src/utils/types.js";

const aimock = useAimockLifecycle("review-policy-cli");

async function writePolicyConfig(cwd: string): Promise<void> {
  await mkdir(path.join(cwd, ".llmwiki"), { recursive: true });
  await writeFile(
    path.join(cwd, ".llmwiki", "config.json"),
    JSON.stringify({ version: 1, review: { hold: ["low-confidence"] } }),
    "utf-8",
  );
}

async function readFirstCandidate(cwd: string): Promise<ReviewCandidate> {
  const dir = path.join(cwd, ".llmwiki", "candidates");
  const [file] = (await readdir(dir)).filter((candidate) => candidate.endsWith(".json"));
  const raw = await readFile(path.join(dir, file), "utf-8");
  return JSON.parse(raw) as ReviewCandidate;
}

function stubPolicyCompile(handle: Awaited<ReturnType<typeof aimock.start>>): void {
  handle.mock.onToolCall("extract_concepts", {
    toolCalls: [
      {
        name: "extract_concepts",
        arguments: {
          concepts: [
            { concept: "Alpha", summary: "Alpha summary.", is_new: true, confidence: 0.2 },
            { concept: "Beta", summary: "Beta summary.", is_new: true, confidence: 0.9 },
          ],
        },
      },
    ],
  });
  handle.mock.onMessage(/.*/, { content: "Generated body from aimock for review policy." });
}

describe("review policy CLI", () => {
  it("reports policy-held pages in normal compile output", async () => {
    const handle = await aimock.start();
    stubPolicyCompile(handle);
    const cwd = await aimock.makeWorkspace("# Source\n\nAlpha and Beta.\n");
    await writePolicyConfig(cwd);

    const result = await runCLI(["compile"], cwd, mockClaudeEnv(handle));
    expectCLIExit(result, 0);

    expect(result.stdout).toContain("Wrote 1 page(s), held 1 for review");
    expect(result.stdout).toContain("llmwiki review list");
    const candidate = await readFirstCandidate(cwd);
    expect(candidate.slug).toBe("alpha");
    expect(candidate.reviewMode).toBe("policy");
    expect(candidate.heldReasons.map((r) => r.code)).toEqual(["low-confidence"]);
  }, 30_000);

  // Test #6: subprocess review list / review show surface reviewMode and reasons
  // Shared setup: run a policy compile and return the cwd + first candidate id.
  async function setupPolicyCompile(): Promise<{ cwd: string; candidateId: string }> {
    const handle = await aimock.start();
    stubPolicyCompile(handle);
    const cwd = await aimock.makeWorkspace("# Source\n\nAlpha and Beta.\n");
    await writePolicyConfig(cwd);
    await runCLI(["compile"], cwd, mockClaudeEnv(handle));
    const candidate = await readFirstCandidate(cwd);
    return { cwd, candidateId: candidate.id };
  }

  it("review list subprocess shows reviewMode and reason codes", async () => {
    const { cwd } = await setupPolicyCompile();
    const listResult = await runCLI(["review", "list"], cwd);
    expectCLIExit(listResult, 0);
    expect(listResult.stdout).toContain("policy");
    expect(listResult.stdout).toContain("low-confidence");
  }, 30_000);

  it("review show subprocess surfaces confidence and reviewMode", async () => {
    const { cwd, candidateId } = await setupPolicyCompile();
    const showResult = await runCLI(["review", "show", candidateId], cwd);
    expectCLIExit(showResult, 0);
    expect(showResult.stdout).toContain("policy");
    expect(showResult.stdout).toContain("low-confidence");
    expect(showResult.stdout).toContain("confidence");
  }, 30_000);

  // Test: full approve lifecycle — policy compile holds a candidate, then approve lands it.
  it("approve promotes held candidate to wiki/ and records slug in state", async () => {
    const handle = await aimock.start();
    stubPolicyCompile(handle);
    const cwd = await aimock.makeWorkspace("# Source\n\nAlpha and Beta.\n");
    await writePolicyConfig(cwd);

    // Step 1: compile with low-confidence policy — alpha should be HELD.
    const compileResult = await runCLI(["compile"], cwd, mockClaudeEnv(handle));
    expectCLIExit(compileResult, 0);
    const candidatesDir = path.join(cwd, ".llmwiki", "candidates");
    const candidateFiles = (await readdir(candidatesDir)).filter((f) => f.endsWith(".json"));
    expect(candidateFiles.length).toBeGreaterThanOrEqual(1);
    const conceptPage = path.join(cwd, "wiki", "concepts", "alpha.md");
    await expect(access(conceptPage)).rejects.toThrow();

    // Step 2: read the held candidate id.
    const candidate = await readFirstCandidate(cwd);
    const { id: candidateId, slug } = candidate;

    // Step 3: approve via subprocess (embeddings may warn but exit 0 is guaranteed).
    const approveResult = await runCLI(["review", "approve", candidateId], cwd, mockClaudeEnv(handle));
    expectCLIExit(approveResult, 0);

    // Step 4a: concept page is now live.
    await expect(access(path.join(cwd, "wiki", "concepts", `${slug}.md`))).resolves.toBeUndefined();

    // Step 4b: candidate file is cleared from the pending area.
    const remaining = await readdir(candidatesDir).catch(() => [] as string[]);
    expect(remaining.filter((f) => f === `${candidateId}.json`)).toHaveLength(0);

    // Step 4c: state.sources records the approved slug (requires sourceStates in candidate).
    if (candidate.sourceStates) {
      const stateRaw = await readFile(path.join(cwd, ".llmwiki", "state.json"), "utf-8");
      const state = JSON.parse(stateRaw) as WikiState;
      const allConcepts = Object.values(state.sources).flatMap((s) => s.concepts);
      expect(allConcepts).toContain(slug);
    }
  }, 60_000);
});
