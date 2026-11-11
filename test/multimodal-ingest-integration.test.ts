/**
 * CLI-level integration tests for the multimodal ingest command.
 *
 * These tests exercise the full CLI code path — spawning `bun dist/cli.js
 * ingest <file>` — for each supported source type, verifying that routing,
 * frontmatter, and content extraction all work together end-to-end.
 *
 * Fixture files live under `test/fixtures/multimodal/` and are real files that
 * contributors can inspect. Tests load them via readFile() rather than inlining
 * content as string constants.
 *
 * Scope:
 *  - `ingest --help` shows help and exits 0
 *  - VTT transcript: written with sourceType transcript, timestamps preserved
 *  - SRT transcript: written with sourceType transcript, timestamps preserved
 *  - Plain-text transcript with speaker tags: routes to transcript adapter
 *  - Plain-text prose without transcript signals: routes to file adapter
 *  - Plain-text with section headers but no repeats: routes to file adapter
 *  - PDF: written with sourceType pdf, text extracted
 *  - Image without credentials: exits non-zero with actionable error message
 *  - Extension routing verified end-to-end for .vtt, .srt, and .pdf
 *  - Empty file: fails or produces skeleton, does not crash
 *  - Non-existent path: exits non-zero with actionable error
 *  - Bulk ingest: 3 fixtures in the same workspace produce 3 distinct files
 *  - Plain-prose .txt: explicitly asserts sourceType file in frontmatter
 *  - .txt with timestamps but no speaker tags: routes to transcript
 *
 * Tests that require real vision API calls (actual image description) are
 * intentionally absent — they would cost quota and are non-deterministic.
 * The credential-failure path for image ingest IS tested here as an
 * offline-safe proxy for source-type routing correctness.
 *
 * All fixture files are written to a tmp directory and cleaned up after each test.
 */

import { describe, it, expect, afterEach } from "bun:test";
import path from "path";
import { mkdtemp, rm, readdir, readFile, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { runCLI, expectCLIExit, expectCLIFailure, formatCLIFailure } from "./fixtures/run-cli.js";

/** Number of distinct fixture files ingested in the bulk-ingest test. */
const BULK_INGEST_COUNT = 3;

/** Absolute path to the shared multimodal fixture directory. */
const FIXTURE_DIR = path.resolve("test/fixtures/multimodal");

/** Isolated workspace with its own sources/ directory. */
interface Workspace {
  cwd: string;
  fixturePath: string;
}

const tempDirs: string[] = [];

/**
 * Create a temp workspace directory and copy a named file into it.
 * The fixture content is read from the multimodal fixture directory.
 * @param fixtureName - Filename inside test/fixtures/multimodal/.
 * @returns Workspace with cwd and absolute fixturePath.
 */
async function makeWorkspaceFromFixture(fixtureName: string): Promise<Workspace> {
  const cwd = await mkdtemp(path.join(tmpdir(), "llmwiki-ingest-integration-"));
  tempDirs.push(cwd);
  const source = path.join(FIXTURE_DIR, fixtureName);
  const content = await readFile(source);
  const fixturePath = path.join(cwd, fixtureName);
  await writeFile(fixturePath, content);
  return { cwd, fixturePath };
}

/**
 * Create a temp workspace with an arbitrary inline content file.
 * Use for edge-case content that does not warrant a fixture file.
 * @param fixtureName - Filename to use inside the workspace.
 * @param content - File content as string or Buffer.
 * @returns Workspace with cwd and absolute fixturePath.
 */
async function makeWorkspaceWithContent(
  fixtureName: string,
  content: string | Buffer,
): Promise<Workspace> {
  const cwd = await mkdtemp(path.join(tmpdir(), "llmwiki-ingest-integration-"));
  tempDirs.push(cwd);
  const fixturePath = path.join(cwd, fixtureName);
  await writeFile(fixturePath, content);
  return { cwd, fixturePath };
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

/** Read the first .md file found in sources/ within cwd. */
async function readIngestedMarkdown(cwd: string): Promise<string> {
  const sourcesDir = path.join(cwd, "sources");
  const files = await readdir(sourcesDir);
  const mdFile = files.find((f) => f.endsWith(".md"));
  if (!mdFile) throw new Error(`No .md file in ${sourcesDir}; found: ${files.join(", ")}`);
  return readFile(path.join(sourcesDir, mdFile), "utf-8");
}

/** Run ingest on a workspace and return the CLI result plus written markdown. */
async function runIngest(
  workspace: Workspace,
): Promise<{ result: import("./fixtures/run-cli.js").CLIResult; markdown: string }> {
  const result = await runCLI(["ingest", workspace.fixturePath], workspace.cwd);
  expectCLIExit(result, 0);
  const markdown = await readIngestedMarkdown(workspace.cwd);
  return { result, markdown };
}

/**
 * Assert that a transcript fixture writes markdown with the transcript sourceType
 * and preserves the expected timestamp format and speaker content.
 * @param fixtureName - Filename in the multimodal fixture directory.
 * @param timestampMarker - A timestamp string expected in the output markdown.
 * @param speakerLine - A speaker line expected in the output markdown.
 */
async function assertTranscriptFixture(
  fixtureName: string,
  timestampMarker: string,
  speakerLine: string,
): Promise<void> {
  const workspace = await makeWorkspaceFromFixture(fixtureName);
  const { result, markdown } = await runIngest(workspace);
  expect(result.stdout, formatCLIFailure(result)).toContain("Next: llmwiki compile");
  expect(markdown, formatCLIFailure(result)).toContain("sourceType: transcript");
  expect(markdown, formatCLIFailure(result)).toContain(timestampMarker);
  expect(markdown, formatCLIFailure(result)).toContain(speakerLine);
}

/**
 * Assert that a fixture's extension routes it to the given sourceType (not "file")
 * via the full CLI subprocess.
 * @param fixtureName - Filename in the multimodal fixture directory.
 * @param expectedSourceType - The frontmatter sourceType value expected.
 */
async function assertExtensionRoutesTo(
  fixtureName: string,
  expectedSourceType: string,
): Promise<void> {
  const workspace = await makeWorkspaceFromFixture(fixtureName);
  const result = await runCLI(["ingest", workspace.fixturePath], workspace.cwd);
  expectCLIExit(result, 0);
  const markdown = await readIngestedMarkdown(workspace.cwd);
  expect(markdown, formatCLIFailure(result)).toContain(`sourceType: ${expectedSourceType}`);
  expect(markdown, formatCLIFailure(result)).not.toContain("sourceType: file");
}

describe("multimodal ingest CLI integration", () => {
  // dist/cli.js is built once by `bun run test` before the suite starts.

  it("ingest --help shows help and exits 0", async () => {
    const result = await runCLI(["ingest", "--help"], process.cwd());
    expectCLIExit(result, 0);
    expect(result.stdout, formatCLIFailure(result)).toContain("ingest");
    expect(result.stdout, formatCLIFailure(result)).toContain("source");
  }, 15_000);

  it("ingest a .vtt transcript writes markdown with sourceType transcript", async () => {
    await assertTranscriptFixture(
      "sample-meeting.vtt",
      "00:00:01.000 --> 00:00:04.500",
      "Alice: Good morning everyone.",
    );
  }, 15_000);

  it("ingest a .srt transcript writes markdown with sourceType transcript", async () => {
    await assertTranscriptFixture(
      "sample-subtitles.srt",
      "00:00:01,000 --> 00:00:04,000",
      "Alice: Welcome to the tutorial series.",
    );
  }, 15_000);

  it("ingest a plain-text .txt transcript with speaker tags routes to transcript adapter", async () => {
    const workspace = await makeWorkspaceFromFixture("sample-dialogue.txt");
    const { markdown } = await runIngest(workspace);
    expect(markdown).toContain("sourceType: transcript");
    expect(markdown).toContain("Alice: Hey, did you get a chance to review the pull request?");
    expect(markdown).toContain("Bob: Yes, I left some comments.");
  }, 15_000);

  it("ingest a plain-prose .txt with no transcript signals routes to file adapter", async () => {
    const workspace = await makeWorkspaceFromFixture("sample-notes.txt");
    const { markdown } = await runIngest(workspace);
    expect(markdown).toContain("sourceType: file");
  }, 15_000);

  it("ingest a .txt with distinct section headers but no repeats routes to file adapter", async () => {
    const workspace = await makeWorkspaceFromFixture("sample-headers.txt");
    const { markdown } = await runIngest(workspace);
    expect(markdown).toContain("sourceType: file");
  }, 15_000);

  it("ingest a .pdf writes markdown with sourceType pdf and extracted text", async () => {
    const workspace = await makeWorkspaceFromFixture("sample.pdf");
    const { result, markdown } = await runIngest(workspace);
    expect(result.stdout, formatCLIFailure(result)).toContain("Next: llmwiki compile");
    expect(markdown).toContain("sourceType: pdf");
    expect(markdown).toContain("Hello PDF World");
  }, 15_000);

  it("ingest a .png without provider credentials fails with actionable error", async () => {
    const workspace = await makeWorkspaceFromFixture("sample-1x1.png");
    const result = await runCLI(["ingest", workspace.fixturePath], workspace.cwd, {
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_AUTH_TOKEN: "",
      LLMWIKI_PROVIDER: "ollama",
    });

    expectCLIFailure(result);
    const combined = result.stderr + result.stdout;
    expect(combined, formatCLIFailure(result)).toMatch(/anthropic/i);
    expect(combined, formatCLIFailure(result)).toMatch(/provider|vision/i);
  }, 15_000);

  it("source-type detection routes .vtt by extension through the full CLI", async () => {
    await assertExtensionRoutesTo("sample-meeting.vtt", "transcript");
  }, 15_000);

  it("source-type detection routes .srt by extension through the full CLI", async () => {
    await assertExtensionRoutesTo("sample-subtitles.srt", "transcript");
  }, 15_000);

  it("source-type detection routes .pdf by extension through the full CLI", async () => {
    await assertExtensionRoutesTo("sample.pdf", "pdf");
  }, 15_000);
});

describe("multimodal ingest — sourceType frontmatter per fixture", () => {
  // One focused test per fixture file: verifies only the frontmatter sourceType,
  // without the broader content and stdout assertions from the first describe block.
  it("sample-meeting.vtt has sourceType transcript in frontmatter", async () => {
    const workspace = await makeWorkspaceFromFixture("sample-meeting.vtt");
    const { markdown } = await runIngest(workspace);
    expect(markdown).toContain("sourceType: transcript");
  }, 15_000);

  it("sample-subtitles.srt has sourceType transcript in frontmatter", async () => {
    const workspace = await makeWorkspaceFromFixture("sample-subtitles.srt");
    const { markdown } = await runIngest(workspace);
    expect(markdown).toContain("sourceType: transcript");
  }, 15_000);

  it("sample-dialogue.txt has sourceType transcript in frontmatter", async () => {
    const workspace = await makeWorkspaceFromFixture("sample-dialogue.txt");
    const { markdown } = await runIngest(workspace);
    expect(markdown).toContain("sourceType: transcript");
  }, 15_000);

  it("sample.pdf has sourceType pdf in frontmatter", async () => {
    const workspace = await makeWorkspaceFromFixture("sample.pdf");
    const { markdown } = await runIngest(workspace);
    expect(markdown).toContain("sourceType: pdf");
  }, 15_000);
});

describe("multimodal ingest — edge cases", () => {
  it("ingest an empty .txt file does not crash and produces a skeleton with sourceType file", async () => {
    // An empty .txt routes to the file adapter. The file adapter wraps content
    // in a code block (8 chars), which is short but non-zero, so the CLI exits 0
    // and emits a "content seems very short" warning rather than crashing.
    const workspace = await makeWorkspaceWithContent("empty.txt", "");
    const result = await runCLI(["ingest", workspace.fixturePath], workspace.cwd);
    // Must not crash (exit code is 0 or non-zero, but ENOENT/signal are not acceptable)
    expect(result.killed, formatCLIFailure(result)).toBe(false);
    expect(result.signal, formatCLIFailure(result)).toBeNull();
    // If it succeeds, the frontmatter should record sourceType file
    if (result.code === 0) {
      const markdown = await readIngestedMarkdown(workspace.cwd);
      expect(markdown).toContain("sourceType: file");
    } else {
      const combined = result.stderr + result.stdout;
      expect(combined, formatCLIFailure(result)).toMatch(/content|readable|extract/i);
    }
  }, 15_000);

  it("ingest a non-existent path exits non-zero with an actionable error", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "llmwiki-ingest-integration-"));
    tempDirs.push(cwd);
    const result = await runCLI(["ingest", "/tmp/does-not-exist-llmwiki.vtt"], cwd);
    expectCLIFailure(result);
    const combined = result.stderr + result.stdout;
    expect(combined, formatCLIFailure(result)).toMatch(/no such file|not found|ENOENT/i);
  }, 15_000);

  it("ingest a .txt with only one summary header routes to file (not transcript)", async () => {
    const workspace = await makeWorkspaceWithContent(
      "single-header.txt",
      "Summary: This is an ordinary project note with no back-and-forth dialogue.\n",
    );
    const { markdown } = await runIngest(workspace);
    expect(markdown).toContain("sourceType: file");
  }, 15_000);

  it("ingest a .txt with timestamps but no speaker tags routes to transcript", async () => {
    const timedContent = [
      "00:01 First observation from the field.",
      "00:02 Second observation, things are looking good.",
      "00:03 Third observation, wrapping up the session.",
    ].join("\n") + "\n";
    const workspace = await makeWorkspaceWithContent("timed-log.txt", timedContent);
    const { markdown } = await runIngest(workspace);
    expect(markdown).toContain("sourceType: transcript");
  }, 15_000);
});

describe("multimodal ingest — bulk ingest", () => {
  it(`ingests ${BULK_INGEST_COUNT} different fixtures into the same workspace producing distinct files`, async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "llmwiki-ingest-bulk-"));
    tempDirs.push(cwd);

    const fixtures = ["sample-meeting.vtt", "sample-notes.txt", "sample-subtitles.srt"];
    for (const fixtureName of fixtures) {
      const source = path.join(FIXTURE_DIR, fixtureName);
      const content = await readFile(source);
      const destPath = path.join(cwd, fixtureName);
      await writeFile(destPath, content);
      const result = await runCLI(["ingest", destPath], cwd);
      expectCLIExit(result, 0);
    }

    const sourcesDir = path.join(cwd, "sources");
    const mdFiles = (await readdir(sourcesDir)).filter((f) => f.endsWith(".md"));
    expect(mdFiles.length).toBe(BULK_INGEST_COUNT);

    const uniqueNames = new Set(mdFiles);
    expect(uniqueNames.size).toBe(BULK_INGEST_COUNT);
  }, 30_000);
});
