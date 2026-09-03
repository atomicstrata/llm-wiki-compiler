/**
 * Real-entry-point regressions for `LLMWIKI_PROVIDER=codex-agent` and
 * `llmwiki compile --provider codex-agent`.
 *
 * Codex is mocked only at the executable boundary. The test otherwise drives
 * the built CLI, complete compiler, page writer, and explicit Ollama-compatible
 * embedding path.
 */

import { spawnSync } from "node:child_process";
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAimockLifecycle } from "./fixtures/aimock-helper.js";
import { installFakeCodex, type FakeCodex } from "./fixtures/fake-codex.js";
import { CLI, expectCLIFailure, expectCLIExit, runCLI } from "./fixtures/run-cli.js";

const aimock = useAimockLifecycle("codex-agent-cli");
const fakes: FakeCodex[] = [];
const tempRoots: string[] = [];
const EMBEDDING_PRELOAD = path.resolve("test/fixtures/mock-embeddings.mjs");

/** Copy Node with any adjacent runtime libraries needed after relocation. */
async function copyNodeRuntime(runtime: string): Promise<string> {
  const copiedNode = path.join(runtime, "node");
  await copyFile(process.execPath, copiedNode);
  await chmod(copiedNode, 0o755);
  if (process.platform !== "darwin") return copiedNode;
  const linked = spawnSync("/usr/bin/otool", ["-L", process.execPath], { encoding: "utf8" });
  const libraries = [...linked.stdout.matchAll(/\t@rpath\/([^ ]+)/g)].map((match) => match[1]);
  for (const library of libraries) {
    const source = path.resolve(path.dirname(process.execPath), "../lib", library);
    const destination = path.resolve(runtime, "../lib", library);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }
  return copiedNode;
}

/** Install the process-boundary fake and register it for cleanup. */
async function fakeCodex(options: Parameters<typeof installFakeCodex>[0] = {}): Promise<FakeCodex> {
  const fake = await installFakeCodex(options);
  fakes.push(fake);
  return fake;
}

/** Environment for Codex chat plus an explicit keyless embedding backend. */
function codexEnv(fake: FakeCodex): NodeJS.ProcessEnv {
  return {
    PATH: `${fake.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    NODE_OPTIONS: `--import=${EMBEDDING_PRELOAD}`,
    LLMWIKI_PROVIDER: "codex-agent",
    LLMWIKI_EMBEDDING_PROVIDER: "ollama",
    OLLAMA_HOST: "http://127.0.0.1:1/v1",
    OLLAMA_EMBEDDINGS_HOST: "http://127.0.0.1:1/v1",
    OPENAI_API_KEY: "sk-parent-trap-must-not-reach-codex",
  };
}

/** Valid extraction result used by the real compile pipeline. */
function extractedConcept(): unknown {
  return {
    concepts: [{
      concept: "Codex Agent Concept",
      summary: "Produced through the process-boundary Codex fake.",
      is_new: true,
      tags: ["codex"],
      confidence: 0.9,
    }],
  };
}

afterEach(async () => {
  for (const fake of fakes.splice(0)) await fake.cleanup();
  for (const root of tempRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("codex-agent through the real llmwiki CLI", () => {
  it.each([
    { label: "compile", args: ["compile"] },
    { label: "refresh", args: ["refresh"] },
    { label: "query", args: ["query"] },
    { label: "watch", args: ["watch"] },
    { label: "eval", args: ["eval"] },
    { label: "quickstart", args: ["quickstart"] },
    { label: "rules extract", args: ["rules", "extract"] },
  ])("offers the standard provider flag on llmwiki $label", async ({ args }) => {
    const cwd = await aimock.makeWorkspace("# Provider option surface\n");
    const result = await runCLI([...args, "--help"], cwd);
    expectCLIExit(result, 0);
    expect(result.stdout).toContain("--provider <name>");
  });

  it.each([
    { label: "environment", args: ["compile"], baseProvider: "codex-agent" },
    { label: "provider flag", args: ["compile", "--provider", "codex-agent"], baseProvider: "openai" },
  ])("runs the full compile pipeline via $label selection", async ({ args, baseProvider }) => {
    const cwd = await aimock.makeWorkspace("# Codex source\n\nA durable source about Codex agent compilation.\n");
    const fake = await fakeCodex({
      toolOutput: extractedConcept(),
      textOutput: "# Codex Agent Concept\n\nCompiled by the Codex CLI provider.",
    });
    const env = { ...codexEnv(fake), LLMWIKI_PROVIDER: baseProvider };

    const result = await runCLI(args, cwd, env);

    expectCLIExit(result, 0);
    const pages = await readdir(path.join(cwd, "wiki", "concepts"));
    expect(pages).toHaveLength(1);
    expect(await readFile(path.join(cwd, "wiki", "concepts", pages[0]), "utf8"))
      .toContain("Compiled by the Codex CLI provider");
    const calls = await fake.calls();
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.some((call) => call.args.includes("--output-schema"))).toBe(true);
    expect(calls.some((call) => !call.args.includes("--output-schema"))).toBe(true);
    for (const call of calls) {
      expect(call.env.OPENAI_API_KEY).toBeUndefined();
      expect(call.env.NODE_OPTIONS).toBeUndefined();
      await expect(access(call.cwd)).rejects.toThrow();
    }
  }, 30_000);

  it("fails actionably without silently falling back when codex is absent", async () => {
    const cwd = await aimock.makeWorkspace("# Source\n\nCodex must be installed.\n");
    const pathWithoutCodex = await mkdtemp(path.join(tmpdir(), "llmwiki-no-codex-"));
    tempRoots.push(pathWithoutCodex);
    const result = await runCLI(["compile"], cwd, {
      PATH: pathWithoutCodex,
      LLMWIKI_PROVIDER: "codex-agent",
      LLMWIKI_EMBEDDING_PROVIDER: "ollama",
    });
    expectCLIFailure(result);
    expect(result.stderr).toMatch(/Codex CLI.*install|install.*Codex CLI/i);
    expect(result.stderr).not.toContain("ANTHROPIC_API_KEY");
  });

  it.runIf(process.platform !== "win32")(
    "never executes a Codex binary beside Node when the caller PATH excludes it",
    async () => {
      const cwd = await aimock.makeWorkspace("# Source\n\nCodex is excluded from PATH.\n");
      const root = await mkdtemp(path.join(tmpdir(), "llmwiki-excluded-codex-"));
      tempRoots.push(root);
      const runtime = path.join(root, "runtime");
      const emptyPath = path.join(root, "empty-path");
      await Promise.all([mkdir(runtime), mkdir(emptyPath)]);
      const copiedNode = await copyNodeRuntime(runtime);
      const marker = path.join(root, "sibling-ran");
      await writeFile(path.join(runtime, "codex"), `#!/bin/sh\nprintf ran > '${marker}'\nexit 9\n`, { mode: 0o755 });
      const result = spawnSync(copiedNode, [CLI, "compile", "--provider", "codex-agent"], {
        cwd,
        env: { PATH: emptyPath, LLMWIKI_EMBEDDING_PROVIDER: "ollama" },
        encoding: "utf8",
      });
      expect(result.status).not.toBe(0);
      await expect(access(marker)).rejects.toThrow();
      expect(result.stderr).toMatch(/Codex CLI.*not installed|install.*Codex CLI/i);
    },
  );

  it.each([
    {
      label: "an incompatible secure flag",
      exitCode: 2,
      diagnostic: "error: unexpected argument '--ignore-user-config'; token=secret-value",
      expected: /Codex CLI.*0\.152\.1.*newer|incompatible Codex CLI/i,
      secret: /ignore-user-config|secret-value/,
    },
    {
      label: "an authentication failure",
      exitCode: 7,
      diagnostic: "login rejected: Bearer subscription.secret OPENAI_API_KEY=sk-do-not-print",
      expected: /Codex CLI.*authenticated|authenticated.*Codex CLI/i,
      secret: /subscription\.secret|sk-do-not-print/,
    },
  ])("reports $label without exposing child output", async (failure) => {
    const cwd = await aimock.makeWorkspace("# Source\n\nCodex must fail safely.\n");
    const fake = await fakeCodex({ exitCode: failure.exitCode, stderr: failure.diagnostic });
    const result = await runCLI(["compile"], cwd, codexEnv(fake));
    expectCLIFailure(result);
    expect(result.stderr).toMatch(failure.expected);
    expect(result.stderr).not.toMatch(failure.secret);
    expect(await fake.calls()).toHaveLength(1);
  });

  it("fails before invoking Codex when no embedding provider is explicit", async () => {
    const cwd = await aimock.makeWorkspace("# Source\n\nEmbeddings must be explicit.\n");
    const fake = await fakeCodex();
    const result = await runCLI(["compile"], cwd, {
      PATH: `${fake.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      LLMWIKI_PROVIDER: "codex-agent",
      LLMWIKI_EMBEDDING_PROVIDER: "",
      OPENAI_API_KEY: "sk-must-not-be-used",
    });
    expectCLIFailure(result);
    expect(result.stderr).toMatch(/codex-agent[\s\S]*LLMWIKI_EMBEDDING_PROVIDER/i);
    expect(await fake.calls()).toEqual([]);
  });
});
