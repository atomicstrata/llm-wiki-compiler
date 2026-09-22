/**
 * Built-CLI witnesses for declared profile confidence with no credentials.
 * Exercise the real profile loader and lint registration, pin warning exits,
 * and retain the existing default corpus transcript independently of profiles.
 */
import { expect, it } from "vitest";
import { readFile, realpath } from "node:fs/promises";
import { useLintTempRoot } from "./fixtures/lint-temp-root.js";
import { writeMarkdownPage, writeProfileFile } from "./fixtures/profile-fixtures.js";
import { buildParityCorpus } from "./fixtures/parity-corpus.js";
import { runCLI, expectCLIExit } from "./fixtures/run-cli.js";
import { stripAnsi } from "./fixtures/cli-runner.js";

const env = useLintTempRoot("profile-confidence-cli");
const NO_CREDENTIALS = {
  LLMWIKI_PROVIDER: "openai", ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "",
  OPENAI_API_KEY: "", ORCAROUTER_API_KEY: "", VOYAGE_API_KEY: "",
  MINIMAX_API_KEY: "", GITHUB_TOKEN: "", ATLASCLOUD_API_KEY: "", ATLAS_CLOUD_API_KEY: "",
};
const LOW_CONFIDENCE = "Page confidence 0.30 is below 0.5";

/** Write a real profile and valid prose, varying only confidence's YAML scalar. */
async function seedConfidence(value?: string, required = false): Promise<void> {
  await writeProfileFile(env.dir, {
    schemaVersion: 1, profileId: "cli-confidence",
    entities: { notes: { directory: "wiki/notes", fields: { confidence: { type: "number", required } } } },
  });
  const confidence = value === undefined ? "" : `confidence: ${value}\n`;
  await writeMarkdownPage(env.dir, "wiki/notes", "sample",
    `---\ntitle: Sample\n${confidence}---\nA complete note with enough prose to avoid unrelated empty-page warnings.\n`);
}

it.each([0.3, 0.5, 0.7])("lints declared confidence %s without credentials", async (value) => {
  await seedConfidence(String(value));
  const result = await runCLI(["lint"], env.dir, NO_CREDENTIALS);
  expectCLIExit(result, 0);
  expect(result.stderr).toBe("");
  expect(result.stdout.includes(LOW_CONFIDENCE)).toBe(value === 0.3);
  expect(stripAnsi(result.stdout)).toContain(`0 error(s), ${value === 0.3 ? 1 : 0} warning(s), 0 info`);
});

it.each([
  { label: "nonnumeric", value: '"0.3"', message: 'Field "confidence" value "0.3" is not a valid number.' },
  { label: "required missing", value: undefined, message: 'Required field "confidence" is missing from frontmatter.' },
])("keeps $label confidence as a schema warning", async ({ value, message }) => {
  await seedConfidence(value, true);
  const result = await runCLI(["lint"], env.dir, NO_CREDENTIALS);
  expectCLIExit(result, 0);
  expect(result.stdout).toContain(message);
  expect(result.stdout).not.toContain("Page confidence");
  expect(stripAnsi(result.stdout)).toContain("0 error(s), 1 warning(s), 0 info");
  const cache = JSON.parse(await readFile(`${env.dir}/.llmwiki/last-lint.json`, "utf8"));
  expect(cache.rules).toEqual([{
    rule: "profile/field-violation", severity: "warning", count: 1,
    fileCount: 1, topFile: "wiki/notes/sample.md", topFileCount: 1,
  }]);
});

it("does not fabricate a judgment for optional missing confidence", async () => {
  await seedConfidence();
  const result = await runCLI(["lint"], env.dir, NO_CREDENTIALS);
  expectCLIExit(result, 0);
  expect(result.stdout).not.toContain("Page confidence");
  expect(stripAnsi(result.stdout)).toContain("0 error(s), 0 warning(s), 0 info");
});

it("preserves the default CLI transcript without profile findings", async () => {
  const root = await realpath(env.dir);
  await buildParityCorpus(root);
  const result = await runCLI(["lint"], root, NO_CREDENTIALS);
  expectCLIExit(result, 0);
  const expected = JSON.parse(await readFile(new URL("./parity/__golden__/cli.lint.json", import.meta.url), "utf8"));
  expect({ code: result.code, stdout: stripAnsi(result.stdout).replaceAll(root, "<ROOT>") }).toEqual(expected);
  expect(result.stderr).toBe("");
});
