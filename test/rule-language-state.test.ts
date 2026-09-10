/**
 * Rule extraction must invalidate its own per-source cursor when language
 * changes, without retiring work that failed partway through a run.
 */
import { afterEach, expect, it, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { extractRuleCandidates } from "../src/compiler/rule-extractor.js";
import * as llm from "../src/utils/llm.js";
import { useTempRoot } from "./fixtures/temp-root.js";
import { seedRuleSource, restoreProviderEnvAfterEach, stubRuleExtraction } from "./fixtures/rule-extraction.js";
import { listRuleCandidates } from "../src/compiler/rule-candidates.js";
import { runCLI, expectCLIExit } from "./fixtures/run-cli.js";

const ctx = useTempRoot(["sources"]);
restoreProviderEnvAfterEach();
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it("re-extracts changed and cleared language, but skips unchanged selections", async () => {
  await seedRuleSource(ctx.dir);
  const call = vi.spyOn(llm, "callClaude").mockResolvedValue('{"rules":[]}');
  for (const lang of [undefined, "Japanese", undefined]) {
    vi.stubEnv("LLMWIKI_OUTPUT_LANG", lang);
    expect((await extractRuleCandidates(ctx.dir)).processedSources).toEqual(["guide.md"]);
    const system = call.mock.calls.at(-1)![0].system;
    if (lang) expect(system).toContain("Write the output in Japanese.");
    else expect(system).not.toContain("Write the output in Japanese.");
    const calls = call.mock.calls.length;
    vi.stubEnv("LLMWIKI_OUTPUT_LANG", `  ${lang ?? ""}  `);
    expect((await extractRuleCandidates(ctx.dir)).processedSources).toEqual([]);
    expect(call).toHaveBeenCalledTimes(calls);
  }
});

it("retries only the failed source after a partial language change", async () => {
  await seedRuleSource(ctx.dir);
  await writeFile(path.join(ctx.dir, "sources/second.md"), "Another source.");
  vi.stubEnv("LLMWIKI_OUTPUT_LANG", undefined);
  const call = vi.spyOn(llm, "callClaude").mockResolvedValue('{"rules":[]}');
  await extractRuleCandidates(ctx.dir);
  vi.stubEnv("LLMWIKI_OUTPUT_LANG", "Japanese");
  call.mockResolvedValueOnce('{"rules":[]}').mockRejectedValueOnce(new Error("provider failed"));
  await expect(extractRuleCandidates(ctx.dir)).rejects.toThrow("provider failed");
  call.mockClear();
  expect((await extractRuleCandidates(ctx.dir)).processedSources).toHaveLength(1);
  expect(call).toHaveBeenCalledTimes(1);
  expect((await extractRuleCandidates(ctx.dir)).processedSources).toEqual([]);
});

it("does not resurrect a CLI-rejected rule when the language changes", async () => {
  await seedRuleSource(ctx.dir);
  vi.stubEnv("LLMWIKI_OUTPUT_LANG", undefined);
  await stubRuleExtraction();
  const first = await extractRuleCandidates(ctx.dir);
  expectCLIExit(await runCLI(["rules", "reject", first.candidates[0]!.id], ctx.dir), 0);
  expect(await listRuleCandidates(ctx.dir)).toEqual([]);
  vi.stubEnv("LLMWIKI_OUTPUT_LANG", "Japanese");
  const rerun = await extractRuleCandidates(ctx.dir);
  expect(rerun.processedSources).toEqual(["guide.md"]);
  expect(rerun.notes.some((note) => note.includes("Kept rejected"))).toBe(true);
  expect(await listRuleCandidates(ctx.dir)).toEqual([]);
});
