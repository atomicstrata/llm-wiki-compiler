/**
 * Real-entrypoint checks for Codex provider selection before dotenv loading.
 *
 * A preload records actual `.env` reads, proving explicit Codex selection does
 * not merely discard credentials after the project file has already been read.
 */

import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { useAimockLifecycle } from "./fixtures/aimock-helper.js";
import { installFakeCodex } from "./fixtures/fake-codex.js";
import { expectCLIFailure, expectCLIExit, runCLI } from "./fixtures/run-cli.js";

const aimock = useAimockLifecycle("codex-agent-environment");
const tracker = path.resolve("test/fixtures/track-dotenv-read.mjs");

/** Environment that records dotenv reads and reaches the Codex boundary. */
function trackedEnv(logPath: string): NodeJS.ProcessEnv {
  return {
    NODE_OPTIONS: `--import=${tracker}`,
    LLMWIKI_TEST_DOTENV_READ_LOG: logPath,
    LLMWIKI_EMBEDDING_PROVIDER: "ollama",
  };
}

describe("codex-agent environment-file isolation", () => {
  it.each([
    { label: "provider flag", args: ["compile", "--provider", "codex-agent"], provider: "openai" },
    { label: "provider equals flag", args: ["compile", "--provider=codex-agent"], provider: "openai" },
    { label: "provider environment", args: ["compile"], provider: "codex-agent" },
  ])("does not read project .env for explicit $label selection", async ({ args, provider }) => {
    const cwd = await aimock.makeWorkspace("# Source\n\nDo not read project credentials.\n");
    const logPath = path.join(cwd, "dotenv-reads.log");
    await writeFile(path.join(cwd, ".env"), "OPENAI_API_KEY=sk-project-secret\n", "utf8");
    const result = await runCLI(args, cwd, {
      ...trackedEnv(logPath),
      LLMWIKI_PROVIDER: provider,
      PATH: path.join(cwd, "missing-bin"),
    });
    expectCLIFailure(result);
    await expect(access(logPath)).rejects.toThrow();
  });

  it("retains project .env loading when codex-agent is not explicitly selected", async () => {
    const cwd = await aimock.makeWorkspace("# Source\n");
    const logPath = path.join(cwd, "dotenv-reads.log");
    await writeFile(path.join(cwd, ".env"), "LLMWIKI_VERBOSE=1\n", "utf8");
    const result = await runCLI(["--version"], cwd, {
      ...trackedEnv(logPath),
      LLMWIKI_PROVIDER: "",
    });
    expectCLIExit(result, 0);
    expect(await readFile(logPath, "utf8")).toContain(path.join(cwd, ".env"));
  });

  it("retains DOTENV_CONFIG_PATH when codex-agent is not explicitly selected", async () => {
    const cwd = await aimock.makeWorkspace("# Source\n");
    const logPath = path.join(cwd, "dotenv-reads.log");
    const configuredPath = path.join(cwd, "operator.env");
    await writeFile(configuredPath, "LLMWIKI_VERBOSE=1\n", "utf8");
    const result = await runCLI(["--version"], cwd, {
      ...trackedEnv(logPath),
      DOTENV_CONFIG_PATH: configuredPath,
      LLMWIKI_TEST_DOTENV_TARGET: configuredPath,
      LLMWIKI_PROVIDER: "",
    });
    expectCLIExit(result, 0);
    expect(await readFile(logPath, "utf8")).toContain(configuredPath);
  });
});
