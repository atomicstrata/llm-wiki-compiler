/**
 * CLI integration test: `compile --review` runs provenance lint against
 * the generated candidate body and persists the findings on the
 * candidate JSON record.
 *
 * Reproduces what would happen if the LLM produces a body with a
 * malformed claim citation: aimock returns the canned body, the compile
 * subprocess writes the candidate, and the saved JSON should now carry
 * `provenanceViolations` in addition to the existing `schemaViolations`
 * surface. Without the fix, `provenanceViolations` would be absent and
 * the reviewer would only see the issue on a normal compile after
 * approval.
 */

import { describe, it, expect } from "bun:test";
import { readdir, readFile } from "fs/promises";
import path from "path";
import {
  mockClaudeEnv,
  useAimockLifecycle,
  type MockClaudeHandle,
} from "./fixtures/aimock-helper.js";
import { runCLI, expectCLIExit } from "./fixtures/run-cli.js";

const aimock = useAimockLifecycle("review-provenance");

const CONCEPT = "Provenance Lint Test";
const CONCEPT_SLUG = "provenance-lint-test";

/** Stub the extraction tool call to produce a single new concept. */
function stubExtraction(handle: MockClaudeHandle): void {
  handle.mock.onToolCall("extract_concepts", {
    toolCalls: [
      {
        name: "extract_concepts",
        arguments: {
          concepts: [
            {
              concept: CONCEPT,
              summary: "Concept used to test review-mode provenance lint.",
              is_new: true,
              tags: ["test"],
              confidence: 0.9,
            },
          ],
        },
      },
    ],
  });
}

/** Read the single candidate JSON written by `compile --review`. */
async function readOnlyCandidate(cwd: string): Promise<{
  body: string;
  schemaViolations?: unknown[];
  provenanceViolations?: unknown[];
}> {
  const dir = path.join(cwd, ".llmwiki", "candidates");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  expect(files).toHaveLength(1);
  return JSON.parse(await readFile(path.join(dir, files[0]), "utf-8"));
}

/**
 * Stand up aimock with the canned extraction + a stubbed page body, run
 * `compile --review` through the CLI subprocess, and return the parsed
 * single candidate. Centralised so the per-test bodies focus on the
 * assertion that distinguishes them.
 */
async function compileReviewWithStubbedBody(stubBody: string): Promise<{
  body: string;
  schemaViolations?: unknown[];
  provenanceViolations?: unknown[];
}> {
  const handle = await aimock.start();
  stubExtraction(handle);
  handle.mock.onMessage(/.*/, { content: stubBody });
  const cwd = await aimock.makeWorkspace("# Source\n\nA short source for the review test.\n");
  const result = await runCLI(["compile", "--review"], cwd, mockClaudeEnv(handle));
  expectCLIExit(result, 0);
  return readOnlyCandidate(cwd);
}

describe("compile --review provenance lint integration", () => {
  it("attaches provenanceViolations when the candidate body has malformed claim citations", async () => {
    // Body ships TWO malformed claim citations (`:abc` and `#X`) — both surface.
    const candidate = await compileReviewWithStubbedBody(
      "First paragraph drawing from the source. ^[source.md:abc]\n\n" +
        "Second paragraph with a hash-form malformed span. ^[source.md#X]\n",
    );
    expect(candidate.provenanceViolations).toBeDefined();
    expect(candidate.provenanceViolations!.length).toBeGreaterThanOrEqual(2);
    const firstRule = (candidate.provenanceViolations![0] as { rule?: unknown }).rule;
    expect(firstRule).toBe("malformed-claim-citation");
  }, 30_000);

  it("attaches provenanceViolations when the candidate body cites a missing source file", async () => {
    const candidate = await compileReviewWithStubbedBody(
      "Body with an inline citation to a non-existent source. ^[does-not-exist.md]\n",
    );
    expect(candidate.provenanceViolations).toBeDefined();
    const rules = (candidate.provenanceViolations as Array<{ rule: string }>).map((v) => v.rule);
    expect(rules).toContain("broken-citation");
  }, 30_000);

  it("omits provenanceViolations when the candidate body has clean citations", async () => {
    const cleanBody = "Body without any citation markers — clean.\n";
    const candidate = await compileReviewWithStubbedBody(cleanBody);
    expect(candidate.provenanceViolations).toBeUndefined();
    // Real assertion replacing the prior no-op: the stubbed body content
    // must round-trip through the candidate write.
    expect(candidate.body).toContain("Body without any citation markers");
  }, 30_000);
});
