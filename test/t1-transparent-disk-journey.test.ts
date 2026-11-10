/**
 * @file test/t1-transparent-disk-journey.test.ts
 * @description Incumbent-versus-candidate compatibility witnesses for the first
 * transparent-disk increment (lane T, T1): an ordinary, unregistered local wiki
 * must behave exactly as it did before its content and configuration reads
 * moved behind the legacy-compatibility read binding.
 *
 * `fixtures/t1-journey-incumbent.json` is what the shared driver observed when
 * run against a build of the pinned public base `47769971`. It was first
 * recorded against an older base; re-recording on this base changed only what
 * the base's own `PROMPT_VERSION` bump (v6 to v7) changes: that line of the
 * shown candidate and the digests of the files that carry it. Each case runs
 * the SAME driver against this tree's build and requires an equal observation: every
 * command's exit code and output, every resulting file's digest, and every
 * provider request in order. Generated metadata is tokenized position by
 * position (`fixtures/t1-journey-compare.ts`); the seed carries prose that only
 * looks like a clock reading and a candidate id, and it is compared as written.
 *
 * The first block pins what the recorded observation itself shows, so a
 * scenario that silently stopped exercising its subject cannot stay green by
 * agreeing with an equally empty recording.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { journeyEnvironment, observeJourney, T1_SCENARIOS, type JourneyObservation, type T1Scenario } from "./fixtures/t1-journey.js";

const INCUMBENT = JSON.parse(
  readFileSync(path.resolve("test/fixtures/t1-journey-incumbent.json"), "utf-8"),
) as Record<T1Scenario, JourneyObservation>;

const CANDIDATE = { cli: path.resolve("dist/cli.js"), sdk: path.resolve("dist/index.js") };

/** The output of the one command a single-step scenario ran. */
function onlyOutput(scenario: T1Scenario): string {
  return INCUMBENT[scenario].steps[0].stdout;
}

describe("T1 recorded incumbent observation exercises each subject", () => {
  it("runs the whole journey to an approved page and a no-op reopen", () => {
    const { steps, files } = INCUMBENT["cli-journey"];
    expect(steps.map((taken) => taken.code)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(steps[3].stdout).toContain("Approved →");
    expect(steps[5].stdout).toContain("Nothing to compile");
    expect(Object.keys(files).filter((name) => name.includes("candidates"))).toEqual([]);
  });

  it("keeps prose that only looks like generated metadata, in output and in the approved page", () => {
    const shown = INCUMBENT["cli-journey"].steps[2].stdout;
    expect(shown).toContain("The event of 2026-01-01T01:02:03.000Z is filed as existing-topic-12345678.");
    expect(shown).toContain('createdAt: "<TIME>"');
    expect(INCUMBENT["cli-journey"].steps.map((taken) => taken.step).slice(2, 4)).toEqual(["review show <candidate>", "review approve <candidate>"]);
  });

  it("carries the hand-edited page into a prompt and excludes the configured source", () => {
    expect(INCUMBENT["cli-journey"].requestsCarryingHandEdit).toBe(1);
    expect(INCUMBENT["sdk-review-compile"].requestsCarryingHandEdit).toBe(1);
    expect(onlyOutput("sdk-review-compile")).toContain('"compiled":2');
  });

  it("refuses under a held lock and recovers a pending journal before compiling", () => {
    expect(onlyOutput("lock-held")).toContain("Could not acquire lock");
    expect(INCUMBENT["lock-held"].requests).toEqual([]);
    const recovered = INCUMBENT["pending-journal"].files;
    expect(recovered[".llmwiki/journal/interrupted.json"]).toBeUndefined();
    expect(recovered["wiki/concepts/existing-topic.md"]).toBe(INCUMBENT["lock-held"].files["wiki/concepts/existing-topic.md"]);
  });

  it("drops an escaping page, ignores a linked sources directory, and compiles through a linked root", () => {
    expect(onlyOutput("escaping-page-link")).toContain("Dropped wiki read (escapes-dir): wiki/concepts/escape.md");
    expect(onlyOutput("linked-sources")).toContain("Nothing to compile");
    expect(INCUMBENT["linked-sources"].requests).toEqual([]);
    expect(INCUMBENT["linked-root"].requests).toEqual(INCUMBENT["pending-journal"].requests);
  });
});

/** Inherited settings that would send chat or embedding calls somewhere other than the scenario's mock. */
const HOSTILE_INHERITED: Record<string, string> = {
  LLMWIKI_PROVIDER: "anthropic",
  LLMWIKI_MODEL: "hostile-chat-model",
  ANTHROPIC_API_KEY: "hostile-anthropic-key",
  OPENAI_BASE_URL: "http://127.0.0.1:9/hostile-chat",
  OPENAI_API_KEY: "hostile-openai-key",
  LLMWIKI_EMBEDDING_PROVIDER: "ollama",
  LLMWIKI_EMBEDDING_MODEL: "hostile-embedding-model",
  OPENAI_EMBEDDINGS_BASE_URL: "http://127.0.0.1:9/hostile-embeddings",
  OPENAI_EMBEDDINGS_API_KEY: "hostile-embeddings-key",
  OLLAMA_HOST: "http://127.0.0.1:9",
  VOYAGE_API_KEY: "hostile-voyage-key",
};

describe("T1 journey commands run in an isolated environment", () => {
  it("binds chat and embeddings to the mock and carries no inherited provider setting", async () => {
    const before = { ...process.env };
    Object.assign(process.env, HOSTILE_INHERITED);
    try {
      const environment = journeyEnvironment("http://127.0.0.1:1/v1", "/home-stand-in");
      expect(Object.values(environment).filter((value) => String(value).includes("hostile"))).toEqual([]);
      expect(Object.keys(environment).filter((name) => /KEY|HOST|ANTHROPIC|VOYAGE|OLLAMA/u.test(name)).sort())
        .toEqual(["OPENAI_API_KEY", "OPENAI_EMBEDDINGS_API_KEY"]);
      expect([environment.OPENAI_BASE_URL, environment.OPENAI_EMBEDDINGS_BASE_URL, environment.LLMWIKI_EMBEDDING_PROVIDER])
        .toEqual(["http://127.0.0.1:1/v1", "http://127.0.0.1:1/v1", "openai"]);
      // The whole journey, embeddings included, still reaches only the mock: the
      // observation equals the recording, whose embedding identity is verified.
      expect(await observeJourney(CANDIDATE, "cli-journey")).toEqual(INCUMBENT["cli-journey"]);
    } finally {
      for (const name of Object.keys(HOSTILE_INHERITED)) delete process.env[name];
      Object.assign(process.env, before);
    }
  });
});

describe("T1 candidate build matches the pinned incumbent", () => {
  it.each(T1_SCENARIOS)("%s", async (scenario) => {
    expect(await observeJourney(CANDIDATE, scenario)).toEqual(INCUMBENT[scenario]);
  });
});
