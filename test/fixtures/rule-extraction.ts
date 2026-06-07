/**
 * Shared fixtures for the rule-extraction tests.
 *
 * Stubs the LLM tool call so extraction is deterministic and offline, and
 * seeds a single source file with the provider env the model-id resolver
 * needs. Reused across the rule-candidate and rule-extraction-state suites so
 * the stub/seed boilerplate lives in one place.
 */

import { vi, afterEach } from "vitest";
import { writeFile } from "fs/promises";
import path from "path";

/** Provider env vars that {@link seedRuleSource} sets and must not leak. */
const PROVIDER_ENV_KEYS = ["LLMWIKI_PROVIDER", "ANTHROPIC_API_KEY"] as const;

/**
 * Snapshot the provider env at call time and restore it after every test in
 * the calling file. Call once at the top of any suite that uses
 * {@link seedRuleSource}, so the env mutation never leaks into other files and
 * makes their credential-dependent assertions order-dependent.
 */
export function restoreProviderEnvAfterEach(): void {
  const saved = Object.fromEntries(PROVIDER_ENV_KEYS.map((k) => [k, process.env[k]]));
  afterEach(() => {
    for (const key of PROVIDER_ENV_KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

/**
 * Stub `callClaude` so the extract_rules tool returns one deterministic rule.
 * @param category - Category the stubbed rule reports (default "Process").
 * @param evidenceLineEnd - End line the model "cites" (default 2; pass a large
 *   value to exercise out-of-bounds span dropping).
 */
export async function stubRuleExtraction(category = "Process", evidenceLineEnd = 2): Promise<void> {
  const llm = await import("../../src/utils/llm.js");
  vi.spyOn(llm, "callClaude").mockImplementation(async ({ tools }) => {
    if (!tools || tools.length === 0) return "";
    return JSON.stringify({
      rules: [{
        category,
        title: "Require tests before merge",
        description: "All PRs must include passing tests.",
        when: "a pull request is opened without test changes",
        then: "warn",
        confidence: "high",
        evidenceLineStart: 1,
        evidenceLineEnd,
      }],
    });
  });
}

/** Seed `sources/guide.md` and set the provider env for model-id resolution. */
export async function seedRuleSource(dir: string): Promise<void> {
  process.env.LLMWIKI_PROVIDER = "anthropic";
  process.env.ANTHROPIC_API_KEY = "test-key";
  await writeFile(
    path.join(dir, "sources", "guide.md"),
    "Always run the test suite before merging a change.\nNo exceptions.",
    "utf-8",
  );
}
