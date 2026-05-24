/**
 * Subprocess integration tests for `llmwiki quickstart`.
 *
 * Exercises the compiled CLI binary end-to-end through `runCLI` so the
 * documented JSON contract, exit codes, and side-effects are pinned at
 * the same surface real users (and agents) see. Stubs the LLM with the
 * shared aimock helper so no real provider calls are made.
 *
 * Critical invariants pinned here:
 *   - `--json` implies `--no-open` and emits the versioned envelope.
 *   - `--review` never starts the viewer and recommends `review list`.
 *   - returned compiler errors land on `compile.errors`; provider/throw
 *     failures land on `compile.error` and are mutually exclusive.
 *   - `compile.pendingCandidates` is sourced from `countCandidates`.
 *   - missing source exits non-zero without writing into sources/.
 *   - `--provider` overrides LLMWIKI_PROVIDER for the run only.
 *   - `--lang` forwards through to the compile prompt.
 */

import { describe, it, expect } from "vitest";
import { readdir, access, mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import {
  mockClaudeEnv,
  useAimockLifecycle,
  type MockClaudeHandle,
} from "./fixtures/aimock-helper.js";
import { runCLI, expectCLIExit, expectCLIFailure, type CLIResult } from "./fixtures/run-cli.js";

const aimock = useAimockLifecycle("quickstart");

/**
 * Stub the canned compile responses (extraction tool call + page body).
 * One shared concept is enough to drive a single happy-path compile.
 */
function stubCompile(handle: MockClaudeHandle): void {
  handle.mock.onToolCall("extract_concepts", {
    toolCalls: [
      {
        name: "extract_concepts",
        arguments: {
          concepts: [
            {
              concept: "Quickstart Concept",
              summary: "Concept produced by aimock for quickstart tests.",
              is_new: true,
              tags: ["quickstart-test"],
              confidence: 0.9,
            },
          ],
        },
      },
    ],
  });
  handle.mock.onMessage(/.*/, { content: "Body produced for the quickstart test." });
}

/** Inputs that every aimock-backed test in this file repeats. */
interface AimockSetup {
  handle: MockClaudeHandle;
  cwd: string;
  fixturePath: string;
}

/**
 * Boot aimock, stub the canned compile responses, create a temp project
 * workspace, and drop a fixture markdown file outside `sources/` so the
 * quickstart subprocess copies it in.
 */
async function bootQuickstart(fixtureBody: string): Promise<AimockSetup> {
  const handle = await aimock.start();
  stubCompile(handle);
  const cwd = await aimock.makeWorkspace("# placeholder\n", "placeholder.md");
  const fixturePath = path.join(cwd, "fixture-source.md");
  await writeFile(fixturePath, fixtureBody, "utf-8");
  return { handle, cwd, fixturePath };
}

/**
 * Run quickstart in `--json --no-open` mode on top of an aimock-backed
 * project, returning the CLI result + parsed envelope. Centralises the
 * "spawn + parse" idiom so the per-test bodies stay readable.
 */
async function runJsonHappy(extraArgs: string[] = []): Promise<{
  result: CLIResult;
  envelope: Record<string, unknown>;
  cwd: string;
}> {
  const { handle, cwd, fixturePath } = await bootQuickstart(
    "# Source\n\nA short source for the quickstart test.\n",
  );
  const result = await runCLI(
    ["quickstart", fixturePath, ...extraArgs, "--json", "--no-open"],
    cwd,
    mockClaudeEnv(handle),
  );
  expectCLIExit(result, 0);
  const envelope = JSON.parse(result.stdout) as Record<string, unknown>;
  return { result, envelope, cwd };
}

describe("`llmwiki quickstart --json --no-open` — happy path envelope", () => {
  it("returns version 1 with stable top-level fields", async () => {
    const { envelope } = await runJsonHappy();
    expect(envelope.version).toBe(1);
    expect(Object.keys(envelope)).toEqual([
      "version",
      "source",
      "ingest",
      "compile",
      "viewer",
      "next",
    ]);
  });

  it("populates ingest.ok=true and ingest.path under sources/", async () => {
    const { envelope } = await runJsonHappy();
    const ingest = envelope.ingest as Record<string, unknown>;
    expect(ingest.ok).toBe(true);
    expect(typeof ingest.path).toBe("string");
    expect((ingest.path as string).startsWith("sources/")).toBe(true);
    expect(ingest.error).toBeNull();
    expect(ingest.sourceType).toBe("file");
  });

  it("sets compile.ok=true with errors=[] and error=null on a clean compile", async () => {
    const { envelope } = await runJsonHappy();
    const compile = envelope.compile as Record<string, unknown>;
    expect(compile.ok).toBe(true);
    expect(compile.errors).toEqual([]);
    expect(compile.error).toBeNull();
    expect(compile.compiled).toBeGreaterThanOrEqual(1);
  });

  it("always reports viewer.opened=false, viewer.url=null in Slice 2 envelope", async () => {
    const { envelope } = await runJsonHappy();
    expect(envelope.viewer).toEqual({ opened: false, url: null });
  });

  it("emits no ANSI escapes in --json output", async () => {
    const { result } = await runJsonHappy();
    // eslint-disable-next-line no-control-regex
    expect(result.stdout).not.toMatch(/\x1b\[/);
  });

  it("writes the compiled concept page into wiki/concepts/", async () => {
    const { cwd } = await runJsonHappy();
    const conceptFiles = await readdir(path.join(cwd, "wiki", "concepts"));
    expect(conceptFiles.length).toBeGreaterThanOrEqual(1);
  });
});

describe("`llmwiki quickstart --review --no-open`", () => {
  it("recommends `llmwiki review list` and never reports a viewer URL", async () => {
    const { envelope } = await runJsonHappy(["--review"]);
    const compile = envelope.compile as Record<string, unknown>;
    expect(compile.ok).toBe(true);
    const next = envelope.next as Record<string, unknown>;
    expect(next.command).toBe("llmwiki review list");
    const executable = next.executable as Record<string, unknown>;
    expect(executable.args).toEqual(["review", "list"]);
    expect(envelope.viewer).toEqual({ opened: false, url: null });
  });

  it("reports compile.pendingCandidates from countCandidates(), not from CompileResult", async () => {
    const { envelope } = await runJsonHappy(["--review"]);
    const compile = envelope.compile as Record<string, unknown>;
    // The stubbed extraction emits one concept → exactly one candidate.
    expect(compile.pendingCandidates).toBe(1);
  });
});

describe("`llmwiki quickstart --review` — viewer never auto-starts", () => {
  it("does not start the viewer even when --no-open is absent", async () => {
    const { handle, cwd, fixturePath } = await bootQuickstart(
      "# Src\n\nReview-only test.\n",
    );
    // No --no-open and no --json. Review must still skip the viewer.
    const result = await runCLI(
      ["quickstart", fixturePath, "--review"],
      cwd,
      mockClaudeEnv(handle),
    );
    expectCLIExit(result, 0);
    // Human output: should mention the review queue and never the viewer URL pattern.
    expect(result.stdout).not.toMatch(/Viewer ready at http/);
    expect(result.stdout).toContain("llmwiki review list");
  });
});

describe("`llmwiki quickstart --json` (without --no-open)", () => {
  it("implies --no-open: emits JSON, sets viewer.opened=false, exits cleanly", async () => {
    const { handle, cwd, fixturePath } = await bootQuickstart(
      "# Src\n\nJSON-implies-noopen test.\n",
    );
    const result = await runCLI(
      ["quickstart", fixturePath, "--json"],
      cwd,
      mockClaudeEnv(handle),
    );
    expectCLIExit(result, 0);
    const envelope = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(envelope.viewer).toEqual({ opened: false, url: null });
  });
});

describe("`llmwiki quickstart <missing>`", () => {
  it("exits non-zero without writing into sources/", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "quickstart-missing-"));
    try {
      const result = await runCLI(["quickstart", "/path/that/does/not/exist.md"], cwd);
      expectCLIFailure(result);
      // sources/ must not have been created by quickstart on the failure path.
      await expect(access(path.join(cwd, "sources"))).rejects.toThrow();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("emits parseable --json envelope and never inspects existing candidates", async () => {
    // Seed a pending candidate up-front so we'd notice if quickstart leaks
    // project-state inspection into the ingest-failure path. The plan says
    // ingest failures must exit 1 without project inspection or mutation.
    const cwd = await mkdtemp(path.join(tmpdir(), "quickstart-missing-json-"));
    try {
      await mkdir(path.join(cwd, ".llmwiki", "candidates"), { recursive: true });
      await writeFile(
        path.join(cwd, ".llmwiki", "candidates", "preexisting-aabbccdd.json"),
        JSON.stringify({
          id: "preexisting-aabbccdd",
          title: "Preexisting",
          slug: "preexisting",
          summary: "Should not surface on ingest-failure path.",
          sources: ["x.md"],
          body: "stub",
          generatedAt: new Date().toISOString(),
        }),
        "utf-8",
      );
      const result = await runCLI(
        ["quickstart", "/path/that/does/not/exist.md", "--json"],
        cwd,
      );
      expectCLIFailure(result);
      const envelope = JSON.parse(result.stdout) as Record<string, unknown>;
      const ingest = envelope.ingest as Record<string, unknown>;
      expect(ingest.ok).toBe(false);
      expect(ingest.path).toBeNull();
      const compile = envelope.compile as Record<string, unknown>;
      // Pre-existing candidate must NOT have been counted: ingest failure
      // must not inspect project state at all.
      expect(compile.pendingCandidates).toBe(0);
      expect(compile.ok).toBe(false);
      expect(compile.errors).toBeNull();
      expect(compile.error).toBeNull();
      // sources/ still not created by quickstart on the failure path.
      await expect(access(path.join(cwd, "sources"))).rejects.toThrow();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("`llmwiki quickstart --json` — compile returns errors (lock contention)", () => {
  it("preserves CompileResult.errors verbatim and reports compile.ok=false", async () => {
    const { handle, cwd, fixturePath } = await bootQuickstart(
      "# Src\n\nLock-contention test.\n",
    );
    // Seed a live .llmwiki/lock holding the test process PID so the
    // compile pipeline's acquireLock fails and returns a CompileResult
    // with a populated `errors` array (the documented returned-error
    // path that buildCompileEnvelopeFromResult handles).
    await mkdir(path.join(cwd, ".llmwiki"), { recursive: true });
    await writeFile(path.join(cwd, ".llmwiki", "lock"), String(process.pid), "utf-8");

    const result = await runCLI(
      ["quickstart", fixturePath, "--json", "--no-open"],
      cwd,
      mockClaudeEnv(handle),
    );
    expectCLIExit(result, 0);
    const envelope = JSON.parse(result.stdout) as Record<string, unknown>;
    const compile = envelope.compile as Record<string, unknown>;
    expect(compile.ok).toBe(false);
    expect(compile.error).toBeNull();
    const errors = compile.errors as unknown[];
    expect(Array.isArray(errors)).toBe(true);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(typeof errors[0]).toBe("string");
    expect(errors[0] as string).toContain("lock");
    // No ANSI escapes in the verbatim error string.
    // eslint-disable-next-line no-control-regex
    expect(errors[0] as string).not.toMatch(/\x1b\[/);
    // Returned counters preserved verbatim (lock contention zeroes them).
    expect(compile.compiled).toBe(0);
    expect(compile.skipped).toBe(0);
    expect(compile.deleted).toBe(0);
    // Resumable: next action steers the user back to `llmwiki compile`.
    const next = envelope.next as Record<string, unknown>;
    expect(next.command).toBe("llmwiki compile");
  });
});

describe("`llmwiki quickstart --json` — compile provider failure after ingest", () => {
  it("preserves the ingested source and emits compile.error.code=provider_unavailable", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "quickstart-noprov-"));
    const fixturePath = path.join(cwd, "src.md");
    await writeFile(fixturePath, "# Src\n\nProvider-failure test.\n", "utf-8");
    try {
      const result = await runCLI(
        ["quickstart", fixturePath, "--json", "--no-open"],
        cwd,
        // Anthropic with no creds and a non-existent Claude settings file
        // so the resolver does not pick up the host's real key.
        {
          LLMWIKI_PROVIDER: "anthropic",
          ANTHROPIC_API_KEY: "",
          ANTHROPIC_AUTH_TOKEN: "",
          LLMWIKI_CLAUDE_SETTINGS_PATH: "/path/does/not/exist.json",
        },
      );
      expectCLIExit(result, 0);
      const envelope = JSON.parse(result.stdout) as Record<string, unknown>;
      const ingest = envelope.ingest as Record<string, unknown>;
      expect(ingest.ok).toBe(true);
      const compile = envelope.compile as Record<string, unknown>;
      expect(compile.ok).toBe(false);
      expect(compile.errors).toBeNull();
      const compileError = compile.error as Record<string, unknown>;
      expect(compileError.code).toBe("provider_unavailable");
      expect(compileError.recoverable).toBe(true);
      // Source must still be on disk so the user can retry compile.
      const sourcesEntries = await readdir(path.join(cwd, "sources"));
      expect(sourcesEntries.length).toBeGreaterThanOrEqual(1);
      // Next action recommends llmwiki compile so the user can resume.
      const next = envelope.next as Record<string, unknown>;
      expect(next.command).toBe("llmwiki compile");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("`llmwiki quickstart --provider`", () => {
  it("overrides LLMWIKI_PROVIDER for the run only (no config persisted)", async () => {
    const { handle, cwd, fixturePath } = await bootQuickstart(
      "# Src\n\nProvider override test.\n",
    );
    const result = await runCLI(
      ["quickstart", fixturePath, "--provider", "anthropic", "--json", "--no-open"],
      cwd,
      {
        ...mockClaudeEnv(handle),
        // Pretend the host has a different provider set; --provider wins.
        LLMWIKI_PROVIDER: "openai",
      },
    );
    expectCLIExit(result, 0);
    const envelope = JSON.parse(result.stdout) as Record<string, unknown>;
    const compile = envelope.compile as Record<string, unknown>;
    expect(compile.ok).toBe(true);
    // No durable config file is written; assert nothing landed on disk.
    await expect(access(path.join(cwd, ".llmwiki", "provider.json"))).rejects.toThrow();
  });
});

describe("`llmwiki quickstart --lang`", () => {
  it("forwards the directive into the compile system prompt", async () => {
    const { handle, cwd, fixturePath } = await bootQuickstart(
      "# Src\n\nLang forwarding test.\n",
    );
    const result = await runCLI(
      ["quickstart", fixturePath, "--lang", "Spanish", "--json", "--no-open"],
      cwd,
      mockClaudeEnv(handle),
    );
    expectCLIExit(result, 0);
    const seenPrompts = handle.mock.getRequests() as Array<{ body?: unknown }>;
    const allSystem = seenPrompts.flatMap((req) => {
      const body = req.body as { messages?: unknown } | undefined;
      if (!Array.isArray(body?.messages)) return [];
      return (body.messages as Array<{ role?: unknown; content?: unknown }>)
        .filter((m) => m.role === "system" && typeof m.content === "string")
        .map((m) => m.content as string);
    });
    expect(allSystem.some((p) => p.includes("Write the output in Spanish."))).toBe(true);
  });
});
