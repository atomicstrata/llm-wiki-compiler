/** Real compile/review plumbing with deterministic provider responses, not a live-model claim. */
import { afterEach, expect, it, vi } from "bun:test";
import { restoreEnv, stubEnv } from "./stubs.js";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { createDemo } from "./fixtures/source-review-project.js";
import { compileAndReport } from "../src/compiler/index.js";
import { listCandidates } from "../src/compiler/candidates.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); restoreEnv();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it("generates a real pending candidate and reuses its nested source coverage", async () => {
  const root = await createDemo(false); roots.push(root);
  stubEnv("LLMWIKI_PROVIDER", "anthropic"); stubEnv("ANTHROPIC_API_KEY", "test-key");
  stubEnv("LLMWIKI_EMBEDDING_PROVIDER", "offline");
  vi.spyOn(console, "log").mockImplementation(() => {});
  const extract = vi.spyOn(AnthropicProvider.prototype, "toolCall").mockResolvedValue(JSON.stringify({
    concepts: [{ concept: "Request timeouts", summary: "Timeout and retry policy", is_new: false }],
  }));
  const generate = vi.spyOn(AnthropicProvider.prototype, "complete").mockResolvedValue(
    "Requests time out after **60 seconds**. Streaming is exempt. ^[api/timeouts.md]\nRetry once after a timeout. ^[retry.md]");
  const before = await readFile(path.join(root, "wiki/concepts/request-timeouts.md"), "utf8");
  const result = await compileAndReport(root, { review: true });
  const [candidate] = await listCandidates(root);
  expect(result.errors).toEqual([]);
  expect(candidate.sourceStates?.["api/timeouts.md"]).toBeDefined();
  expect(generate.mock.calls.flat().join(" ")).toContain("Streaming is exempt");
  expect(generate.mock.calls.flat().join(" ")).toContain("Retry once");
  expect(await readFile(path.join(root, "wiki/concepts/request-timeouts.md"), "utf8")).toBe(before);
  const extractionCalls = extract.mock.calls.length;
  expect((await compileAndReport(root, { review: true })).compiled).toBe(0);
  expect(extract).toHaveBeenCalledTimes(extractionCalls);
});
