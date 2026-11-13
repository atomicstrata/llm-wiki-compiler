/**
 * CLI integration tests for the `ingest-session` command and its
 * adapters. Each test exercises the full CLI subprocess via the shared
 * `runCLI` harness from `test/fixtures/run-cli.ts`, so the assertions
 * cover what an end user would actually observe.
 *
 * Coverage:
 *   - `ingest-session --help`
 *   - happy paths for Claude (.jsonl), Codex (.json), Cursor (.json)
 *   - malformed JSONL exits non-zero with actionable error
 *   - unknown extension / wrong shape exits non-zero
 *   - missing path exits non-zero
 *   - bulk-import on a directory: mixed good+bad succeeds, all-bad fails
 *   - duplicate session titles do not silently overwrite (#36 protection)
 *   - empty-slug title fails loudly (#35 protection)
 *   - empty-turn export fails loudly (codex review hardening)
 */

import { describe, it, expect } from "bun:test";
import path from "path";
import { mkdir, readdir, readFile, writeFile, copyFile } from "fs/promises";
import {
  runCLI,
  expectCLIExit,
  expectCLIFailure,
  type CLIResult,
} from "./fixtures/run-cli.js";
import { useIngestWorkspaces } from "./fixtures/ingest-workspace.js";

const FIXTURES = path.resolve("test/fixtures/sessions");
const CLAUDE_FIXTURE = path.join(FIXTURES, "claude-session.jsonl");
const CODEX_FIXTURE = path.join(FIXTURES, "codex-session.json");
const CURSOR_FIXTURE = path.join(FIXTURES, "cursor-session.json");
const MALFORMED_FIXTURE = path.join(FIXTURES, "malformed.jsonl");
const EMPTY_TURNS_FIXTURE = path.join(FIXTURES, "claude-empty-session.jsonl");

// Reuse the shared workspace lifecycle from the existing ingest tests so
// the tempDirs + afterEach boilerplate stays in one place.
const workspaces = useIngestWorkspaces("session");

/** Make a temp workspace ready for `ingest-session`. */
async function makeWorkspace(): Promise<string> {
  return workspaces.makeEmptyWorkspace();
}

/** Read sources/ tolerating ENOENT when the CLI failed before creating it. */
async function readSources(cwd: string): Promise<string[]> {
  return readdir(path.join(cwd, "sources")).catch(() => [] as string[]);
}

/**
 * Common assertion shape for tests that expect the CLI to fail with a
 * specific stderr pattern AND verify no markdown was written into
 * sources/. Hoisted so the empty-turns and empty-slug tests share it
 * (fallow's CI mode flagged the pattern as a clone group otherwise).
 */
async function expectIngestSessionFailureWithoutWrite(
  result: CLIResult,
  stderrPattern: RegExp,
  cwd: string,
): Promise<void> {
  expectCLIFailure(result);
  expect(result.stderr.toLowerCase()).toMatch(stderrPattern);
  const files = await readSources(cwd);
  expect(files).not.toContain(".md");
}

/**
 * Assert that `sources/` holds exactly one .md file whose frontmatter
 * names the expected adapter and includes the standard fields.
 */
async function assertSingleSessionIngested(cwd: string, adapterName: string): Promise<void> {
  const files = await readdir(path.join(cwd, "sources"));
  expect(files.length).toBe(1);
  const content = await readFile(path.join(cwd, "sources", files[0]), "utf-8");
  expect(content).toContain(`adapter: ${adapterName}`);
  expect(content).toContain("ingestedAt:");
  expect(content).toContain("source:");
}

describe("ingest-session CLI integration", () => {
  it("ingest-session --help shows the command description", async () => {
    const cwd = await makeWorkspace();
    const result = await runCLI(["ingest-session", "--help"], cwd);
    expectCLIExit(result, 0);
    expect(result.stdout).toContain("ingest-session");
    expect(result.stdout).toContain("session");
  });

  it("ingest-session with claude fixture writes markdown to sources/", async () => {
    const cwd = await makeWorkspace();
    const result = await runCLI(["ingest-session", CLAUDE_FIXTURE], cwd);
    expectCLIExit(result, 0);
    expect(result.stdout).toContain("claude");
    await assertSingleSessionIngested(cwd, "claude");
  });

  it("ingest-session with codex fixture writes markdown to sources/", async () => {
    const cwd = await makeWorkspace();
    const result = await runCLI(["ingest-session", CODEX_FIXTURE], cwd);
    expectCLIExit(result, 0);
    expect(result.stdout).toContain("codex");
    await assertSingleSessionIngested(cwd, "codex");
  });

  it("ingest-session with cursor fixture writes markdown to sources/", async () => {
    const cwd = await makeWorkspace();
    const result = await runCLI(["ingest-session", CURSOR_FIXTURE], cwd);
    expectCLIExit(result, 0);
    expect(result.stdout).toContain("cursor");
    await assertSingleSessionIngested(cwd, "cursor");
  });

  it("ingest-session with malformed JSONL exits non-zero with actionable error", async () => {
    const cwd = await makeWorkspace();
    const result = await runCLI(["ingest-session", MALFORMED_FIXTURE], cwd);
    expectCLIFailure(result);
    expect(result.stderr.toLowerCase()).toMatch(/malformed|line \d+|invalid/);
  });

  it("ingest-session with unknown format exits non-zero with no-adapter message", async () => {
    const cwd = await makeWorkspace();
    const unknownFile = path.join(cwd, "unknown.txt");
    await writeFile(unknownFile, "hello world", "utf-8");
    const result = await runCLI(["ingest-session", unknownFile], cwd);
    expectCLIFailure(result);
    expect(result.stderr.toLowerCase()).toMatch(/no session adapter|no adapter/);
  });

  it("ingest-session with missing path exits non-zero with file-not-found error", async () => {
    const cwd = await makeWorkspace();
    const missingPath = path.join(cwd, "does-not-exist.jsonl");
    const result = await runCLI(["ingest-session", missingPath], cwd);
    expectCLIFailure(result);
    expect(result.stderr.toLowerCase()).toMatch(/not found|no such file/);
  });
});

describe("ingest-session — adapter validation hardening", () => {
  it("session with no user/assistant turns fails loudly even when shape detection passes", async () => {
    const cwd = await makeWorkspace();
    const result = await runCLI(["ingest-session", EMPTY_TURNS_FIXTURE], cwd);
    await expectIngestSessionFailureWithoutWrite(
      result,
      /no usable turns|no user or assistant/,
      cwd,
    );
  });
});

describe("ingest-session — bulk directory import", () => {
  it("mixed good and bad files: good ones import, bad ones warn, exit 0", async () => {
    const cwd = await makeWorkspace();
    const dir = path.join(cwd, "sessions");
    await mkdir(dir, { recursive: true });
    await copyFile(CLAUDE_FIXTURE, path.join(dir, "claude.jsonl"));
    await copyFile(CODEX_FIXTURE, path.join(dir, "codex.json"));
    await copyFile(MALFORMED_FIXTURE, path.join(dir, "malformed.jsonl"));

    const result = await runCLI(["ingest-session", dir], cwd);
    expectCLIExit(result, 0);
    expect(result.stdout).toMatch(/Imported 2 session/);
    expect(result.stdout + result.stderr).toMatch(/skipped|Skipped/i);

    const files = await readdir(path.join(cwd, "sources"));
    expect(files.length).toBe(2);
  });

  it("directory with only malformed/unrecognised files exits non-zero", async () => {
    const cwd = await makeWorkspace();
    const dir = path.join(cwd, "sessions");
    await mkdir(dir, { recursive: true });
    await copyFile(MALFORMED_FIXTURE, path.join(dir, "malformed.jsonl"));
    await writeFile(path.join(dir, "noise.txt"), "not a session", "utf-8");

    const result = await runCLI(["ingest-session", dir], cwd);
    expectCLIFailure(result);
    expect(result.stderr.toLowerCase()).toMatch(/no sessions imported/);
  });
});

describe("ingest-session — filename safety (#35/#36 inheritance)", () => {
  it("two sessions with the same title from different files do not silently overwrite", async () => {
    const cwd = await makeWorkspace();
    // Build two distinct claude sessions whose first user turn produces the
    // same title — same slug, different sources. The second ingest must
    // disambiguate via the hash suffix shared with normal ingest (#36).
    const fileA = path.join(cwd, "session-a.jsonl");
    const fileB = path.join(cwd, "session-b.jsonl");
    const sharedFirstTurn =
      '{"type":"user","message":{"role":"user","content":"How do I write tests?"},"timestamp":"2024-01-15T10:00:00.000Z"}\n';
    await writeFile(
      fileA,
      sharedFirstTurn +
        '{"type":"assistant","message":{"role":"assistant","content":"Use vitest."},"timestamp":"2024-01-15T10:00:01.000Z"}\n',
      "utf-8",
    );
    await writeFile(
      fileB,
      sharedFirstTurn +
        '{"type":"assistant","message":{"role":"assistant","content":"Try jest."},"timestamp":"2024-01-15T10:00:02.000Z"}\n',
      "utf-8",
    );

    expectCLIExit(await runCLI(["ingest-session", fileA], cwd), 0);
    expectCLIExit(await runCLI(["ingest-session", fileB], cwd), 0);

    const files = (await readdir(path.join(cwd, "sources"))).sort();
    // Two distinct files survive — first keeps the bare slug, second gets
    // the 8-hex hash suffix.
    expect(files.length).toBe(2);
    expect(files.some((f) => /-[0-9a-f]{8}\.md$/.test(f))).toBe(true);
  });

  it("session whose title slugifies to empty fails loudly without writing a dotfile", async () => {
    const cwd = await makeWorkspace();
    const file = path.join(cwd, "emoji-only.jsonl");
    // Title derives from the first user turn content. Use pure-emoji content
    // so slugify returns "" and the empty-slug guard from #35 fires.
    await writeFile(
      file,
      '{"type":"user","message":{"role":"user","content":"🎉🎊🚀"},"timestamp":"2024-01-15T10:00:00.000Z"}\n' +
        '{"type":"assistant","message":{"role":"assistant","content":"Got it."},"timestamp":"2024-01-15T10:00:01.000Z"}\n',
      "utf-8",
    );

    const result = await runCLI(["ingest-session", file], cwd);
    await expectIngestSessionFailureWithoutWrite(
      result,
      /could not derive a filename/,
      cwd,
    );
  });
});
