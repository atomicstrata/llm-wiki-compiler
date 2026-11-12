/**
 * Smoke test for the aimock subprocess pattern.
 *
 * Proves that a `compile --review` subprocess invocation routes through
 * the aimock LLM stub and produces a candidate JSON record on disk —
 * closing the long-standing "no subprocess test for the compile happy
 * path" gap that has been documented on several branches' merged PRs.
 *
 * If this passes, the same pattern can be applied to backfill subprocess
 * coverage on any feature whose code path needs an LLM (compile, query,
 * compile --review, image vision, etc).
 */

import { describe, it, expect } from "bun:test";
import { readdir, readFile } from "fs/promises";
import path from "path";
import {
  mockClaudeEnv,
  useAimockLifecycle,
} from "./fixtures/aimock-helper.js";
import { runCLI, expectCLIExit } from "./fixtures/run-cli.js";

const aimock = useAimockLifecycle("aimock-smoke");

describe("aimock subprocess smoke", () => {
  it("compile --review writes a candidate using the mocked Claude response", async () => {
    const handle = await aimock.start();

    // Stub the extraction tool call: one new concept named "Mock Concept".
    handle.mock.onToolCall("extract_concepts", {
      toolCalls: [
        {
          name: "extract_concepts",
          arguments: {
            concepts: [
              {
                concept: "Mock Concept",
                summary: "A canned concept returned by aimock.",
                is_new: true,
                tags: ["smoke-test"],
                confidence: 0.95,
              },
            ],
          },
        },
      ],
    });

    // Stub the page-body generation: any subsequent message → canned body.
    handle.mock.onMessage(/.*/, {
      content: "Mock concept body produced via aimock for the smoke test.",
    });

    const cwd = await aimock.makeWorkspace(
      "# Mock Source\n\nA short source document for the smoke test.\n",
    );

    const result = await runCLI(
      ["compile", "--review"],
      cwd,
      mockClaudeEnv(handle),
    );

    expectCLIExit(result, 0);

    // Candidate JSON should land in .llmwiki/candidates/.
    const candidatesDir = path.join(cwd, ".llmwiki", "candidates");
    const candidateFiles = await readdir(candidatesDir);
    const jsonCandidates = candidateFiles.filter((f) => f.endsWith(".json"));
    expect(jsonCandidates.length).toBeGreaterThan(0);

    const candidatePath = path.join(candidatesDir, jsonCandidates[0]);
    const candidateText = await readFile(candidatePath, "utf-8");
    const candidate = JSON.parse(candidateText) as {
      title: string;
      slug: string;
      body: string;
    };

    expect(candidate.title).toBe("Mock Concept");
    expect(candidate.slug).toBe("mock-concept");
    expect(candidate.body).toContain("Mock concept body produced via aimock");

    // Review-mode contract: wiki/concepts/ must NOT have any pages written.
    const conceptsDir = path.join(cwd, "wiki", "concepts");
    const conceptFiles = await readdir(conceptsDir).catch(() => [] as string[]);
    expect(conceptFiles.filter((f) => f.endsWith(".md"))).toHaveLength(0);
  }, 30_000);
});
