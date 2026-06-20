import { describe, it, expect } from "vitest";
import path from "path";
import { mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { exec, CLI } from "./fixtures/cli-runner.js";

async function cleanupDirectory(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
}

async function runCompileWithoutSources(
  suffix: string,
  envOverrides: NodeJS.ProcessEnv,
): Promise<string> {
  const cwd = path.join(tmpdir(), `llmwiki-test-${suffix}-${Date.now()}`);
  await mkdir(path.join(cwd, "sources"), { recursive: true });
  try {
    const { stdout } = await exec("node", [CLI, "compile"], {
      cwd,
      env: { ...process.env, ...envOverrides },
    });
    return stdout;
  } finally {
    await cleanupDirectory(cwd);
  }
}

async function createCompileWorkspace(
  suffix: string,
  claudeSettingsContent?: string,
): Promise<{ cwd: string; settingsPath?: string }> {
  const cwd = path.join(tmpdir(), `llmwiki-test-${suffix}-${Date.now()}`);
  await mkdir(path.join(cwd, "sources"), { recursive: true });

  if (!claudeSettingsContent) {
    return { cwd };
  }

  const claudeDir = path.join(cwd, ".claude");
  const settingsPath = path.join(claudeDir, "settings.json");
  await mkdir(claudeDir, { recursive: true });
  await writeFile(settingsPath, claudeSettingsContent, "utf8");
  return { cwd, settingsPath };
}

describe("CLI smoke tests", () => {
  it("prints help and exits 0", async () => {
    const { stdout } = await exec("node", [CLI, "--help"]);
    expect(stdout).toContain("llmwiki");
    expect(stdout).toContain("ingest");
    expect(stdout).toContain("compile");
    expect(stdout).toContain("query");
  }, 30_000);

  it("prints version", async () => {
    const { stdout } = await exec("node", [CLI, "--version"]);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  }, 30_000);

  it("advertises --concurrency on every command that drives a compile", async () => {
    for (const command of ["compile", "refresh", "watch"]) {
      const { stdout } = await exec("node", [CLI, command, "--help"]);
      expect(stdout).toContain("--concurrency");
    }
  }, 30_000);

  it("compile fails without Anthropic credentials", async () => {
    try {
      await exec("node", [CLI, "compile"], {
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: "",
          ANTHROPIC_AUTH_TOKEN: "",
          ANTHROPIC_BASE_URL: "http://localhost:11434",
        },
      });
      expect.fail("should have thrown");
    } catch (err: unknown) {
      const error = err as { stderr?: string; code?: number };
      // Should exit with non-zero or print an error
      expect(error.code).not.toBe(0);
    }
  });

  it("compile without sources works with ANTHROPIC_AUTH_TOKEN", async () => {
    const stdout = await runCompileWithoutSources("compile-token", {
      ANTHROPIC_AUTH_TOKEN: "dummy-token",
      ANTHROPIC_API_KEY: "",
    });
    expect(stdout).not.toContain("ANTHROPIC_API_KEY");
  }, 30_000);

  it("compile without sources works with Claude settings auth-token fallback", async () => {
    const workspace = await createCompileWorkspace(
      "compile-claude-settings",
      JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "fallback-token", ANTHROPIC_MODEL: "Kimi-2.5" } }),
    );

    try {
      const { stdout } = await exec("node", [CLI, "compile"], {
        cwd: workspace.cwd,
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: "",
          ANTHROPIC_AUTH_TOKEN: "",
          LLMWIKI_CLAUDE_SETTINGS_PATH: workspace.settingsPath,
        },
      });
      expect(stdout).not.toContain("Anthropic credentials are required");
    } finally {
      await cleanupDirectory(workspace.cwd);
    }
  }, 30_000);

  it("compile reports malformed Claude settings with formatted CLI error", async () => {
    const workspace = await createCompileWorkspace(
      "compile-malformed-claude-settings",
      "{ malformed-json",
    );

    try {
      await exec("node", [CLI, "compile"], {
        cwd: workspace.cwd,
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: "",
          ANTHROPIC_AUTH_TOKEN: "",
          LLMWIKI_CLAUDE_SETTINGS_PATH: workspace.settingsPath,
        },
      });
      expect.fail("should have thrown");
    } catch (err: unknown) {
      const error = err as { stderr?: string; code?: number };
      expect(error.code).not.toBe(0);
      expect(error.stderr ?? "").toContain("Error:");
      expect(error.stderr ?? "").toContain("Failed to parse Claude settings");
    } finally {
      await cleanupDirectory(workspace.cwd);
    }
  }, 30_000);

  it("ingest shows next-step hint", async () => {
    const cwd = path.join(tmpdir(), `llmwiki-test-ingest-${Date.now()}`);
    await mkdir(cwd, { recursive: true });
    const fixture = path.resolve("test/fixtures/sample-source.md");
    try {
      const { stdout } = await exec("node", [CLI, "ingest", fixture], { cwd });
      expect(stdout).toContain("Next: llmwiki compile");
    } finally {
      await cleanupDirectory(cwd);
    }
  }, 30_000);

  it("compile without sources does not show query hint", async () => {
    const stdout = await runCompileWithoutSources("compile", { ANTHROPIC_API_KEY: "dummy" });
    expect(stdout).not.toContain("Next: llmwiki query");
  }, 30_000);
});
