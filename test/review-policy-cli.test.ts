/**
 * Subprocess coverage for compile-time review policy.
 *
 * The CLI path is exercised with aimock rather than a live LLM. This pins the
 * user-facing contract that policy-held pages are reported loudly during a
 * normal `llmwiki compile` run.
 */

import { describe, it, expect } from "vitest";
import { mkdir, readFile, readdir, writeFile } from "fs/promises";
import path from "path";
import { mockClaudeEnv, useAimockLifecycle } from "./fixtures/aimock-helper.js";
import { runCLI, expectCLIExit } from "./fixtures/run-cli.js";
import type { ReviewCandidate } from "../src/utils/types.js";

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
    expect(candidate.heldReasons?.map((r) => r.code)).toEqual(["low-confidence"]);
  }, 30_000);
});
