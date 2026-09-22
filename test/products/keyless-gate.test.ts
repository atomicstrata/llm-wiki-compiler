/**
 * @file test/products/keyless-gate.test.ts
 * @description The keyless gate's DEMONSTRATING PAIR (P5c §6 / D87 hardened):
 * the credential-escape routes `scripts/test-keyless.sh` closes are witnessed
 * at the mechanism it guards — a planted token-bearing Claude settings file
 * IS read when its override variable points at it, and is NOT read under the
 * script's environment (override unset, HOME fresh and empty). A gate whose
 * guard was never seen to block anything is a gate on trust.
 */

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readClaudeSettingsEnv } from "../../src/utils/claude-settings-reader.js";

describe("the keyless gate's settings escape is real, and the script's env closes it", () => {
  it("a planted settings file IS read via the override — and NOT read once the override is unset with a fresh HOME", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "keyless-gate-"));
    const planted = path.join(dir, "settings.json");
    await writeFile(planted, JSON.stringify({ env: { ANTHROPIC_API_KEY: "planted-key" } }), "utf8");
    // ESCAPE DEMONSTRATED: with the override set, the planted key leaks in.
    const leaked = readClaudeSettingsEnv({ LLMWIKI_CLAUDE_SETTINGS_PATH: planted } as NodeJS.ProcessEnv);
    expect(leaked?.ANTHROPIC_API_KEY).toBe("planted-key");
    // GUARD DEMONSTRATED: the script's environment — no override, a fresh
    // empty HOME — reaches no settings file at all. `os.homedir()` honors
    // process.env.HOME on POSIX, so the env is MUTATED (and restored): a
    // hand-built env object never reaches the reader's homedir fallback.
    const freshHome = await mkdtemp(path.join(tmpdir(), "keyless-home-"));
    const priorHome = process.env.HOME;
    try {
      process.env.HOME = freshHome;
      const blocked = readClaudeSettingsEnv({ HOME: freshHome } as NodeJS.ProcessEnv);
      expect(blocked).toBeUndefined();
    } finally {
      process.env.HOME = priorHome;
    }
  });

  it("the SCRIPT behaves: it refuses beside a .env, and its child sees none of the nine routes", async () => {
    const { mkdir, chmod } = await import("node:fs/promises");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    const scriptPath = path.join(process.cwd(), "scripts", "test-keyless.sh");
    const stage = await mkdtemp(path.join(tmpdir(), "keyless-behave-"));
    // A stub npm on PATH records the child environment instead of testing.
    await mkdir(path.join(stage, "bin"), { recursive: true });
    const envDump = path.join(stage, "child-env.txt");
    await writeFile(path.join(stage, "bin", "npm"), `#!/usr/bin/env bash\nenv > ${JSON.stringify(envDump)}\n`, "utf8");
    await chmod(path.join(stage, "bin", "npm"), 0o755);
    const hostileEnv = {
      ...process.env, PATH: `${path.join(stage, "bin")}:${process.env.PATH}`,
      ANTHROPIC_API_KEY: "k", CLAUDE_API_KEY: "k", ANTHROPIC_AUTH_TOKEN: "k",
      OPENAI_API_KEY: "k", MINIMAX_API_KEY: "k", GITHUB_TOKEN: "k",
      LLMWIKI_PROVIDER: "openai", LLMWIKI_CLAUDE_SETTINGS_PATH: "/nope", LLMWIKI_PROVIDER_INVOCATION_MODULE: "/nope",
    };
    // BESIDE a .env the gate REFUSES outright (exit 2) — behavior, not text.
    await writeFile(path.join(stage, ".env"), "ANTHROPIC_API_KEY=leak\n", "utf8");
    const refused = await run("bash", [scriptPath], { cwd: stage, env: hostileEnv }).then(
      () => null, (error: { code?: number }) => error);
    expect(refused?.code).toBe(2);
    // Without the .env the child runs — and sees NONE of the nine routes.
    await (await import("node:fs/promises")).rm(path.join(stage, ".env"));
    await run("bash", [scriptPath], { cwd: stage, env: hostileEnv });
    const childEnv = await readFile(envDump, "utf8");
    for (const route of ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY", "ANTHROPIC_AUTH_TOKEN",
      "OPENAI_API_KEY", "MINIMAX_API_KEY", "GITHUB_TOKEN",
      "LLMWIKI_PROVIDER=", "LLMWIKI_CLAUDE_SETTINGS_PATH", "LLMWIKI_PROVIDER_INVOCATION_MODULE"]) {
      expect(childEnv, route).not.toContain(route);
    }
    expect(childEnv).toContain("HOME=");
    expect(childEnv).not.toContain(`HOME=${process.env.HOME}\n`);
  });

  it("the SCRIPT closes every escape route it claims: the unsets and the fresh HOME are in its text", async () => {
    // The reader pair above witnesses the MECHANISM; this pins the SCRIPT to
    // it — deleting any unset from scripts/test-keyless.sh goes red here.
    const script = await readFile(path.join(process.cwd(), "scripts", "test-keyless.sh"), "utf8");
    for (const route of [
      "ANTHROPIC_API_KEY", "CLAUDE_API_KEY", "ANTHROPIC_AUTH_TOKEN",
      "OPENAI_API_KEY", "MINIMAX_API_KEY", "GITHUB_TOKEN",
      "LLMWIKI_PROVIDER", "LLMWIKI_CLAUDE_SETTINGS_PATH", "LLMWIKI_PROVIDER_INVOCATION_MODULE",
    ]) {
      expect(script, route).toContain(`-u ${route}`);
    }
    expect(script).toContain('HOME="$FRESH_HOME"');
    // A repo .env would let CLI subprocesses reload credentials; the gate
    // must refuse beside one rather than pretend determinism.
    expect(script).toContain("-f .env");
  });
});
