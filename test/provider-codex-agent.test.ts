/**
 * Behavioral contract for the Codex CLI-backed LLM provider.
 *
 * The fake lives at the literal `codex` PATH boundary, making argv, environment,
 * throwaway-directory cleanup, schema validation, resource caps, and process
 * termination observable without mocking Node's child_process implementation.
 */

import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAgentProvider } from "../src/providers/codex-agent.js";
import type { LLMTool } from "../src/utils/provider.js";
import { installFakeCodex, type FakeCodex } from "./fixtures/fake-codex.js";

const originalEnv = { ...process.env };
const fakes: FakeCodex[] = [];
const tempRoots: string[] = [];
const TOOL: LLMTool = {
  name: "return_value",
  description: "Return one string value",
  input_schema: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  },
};

/** Install a fake and steer literal PATH lookup to it. */
async function useFake(options: Parameters<typeof installFakeCodex>[0] = {}): Promise<FakeCodex> {
  const fake = await installFakeCodex(options);
  fakes.push(fake);
  process.env.PATH = `${fake.binDir}${path.delimiter}${originalEnv.PATH ?? ""}`;
  return fake;
}

/** Install a PATH node wrapper that proves launcher-added variables cannot cross the boundary. */
async function installInjectingNodeWrapper(): Promise<string> {
  const root = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "llmwiki-node-wrapper-"));
  tempRoots.push(root);
  const executable = process.execPath.replaceAll("'", "'\\''");
  const wrapper = path.join(root, "node");
  await writeFile(
    wrapper,
    `#!/bin/sh\nexport LLMWIKI_LAUNCHER_INJECTED=1\nexec '${executable}' "$@"\n`,
  );
  await chmod(wrapper, 0o755);
  return root;
}

/** Assert one completion failure and the cleanup of its captured invocation cwd. */
async function expectCleanFailure(
  fake: FakeCodex,
  options: ConstructorParameters<typeof CodexAgentProvider>[1],
  message: RegExp,
): Promise<void> {
  const provider = new CodexAgentProvider(undefined, options);
  await expect(provider.complete("system", [{ role: "user", content: "x" }], 1))
    .rejects.toThrow(message);
  const [call] = await fake.calls();
  await expect(access(call.cwd)).rejects.toThrow();
}

/** Complete one request with the deliberately small output cap used by boundary witnesses. */
async function expectCappedCompletion(expected: string): Promise<void> {
  const provider = new CodexAgentProvider(undefined, {
    timeoutMs: 2_000,
    maxOutputBytes: 1_024,
  });
  await expect(provider.complete("system", [{ role: "user", content: "x" }], 1))
    .resolves.toBe(expected);
}

/** Release timeout stages only after the fake can observe the complete signal sequence. */
async function expectBoundedTimeout(fake: FakeCodex): Promise<void> {
  const provider = new CodexAgentProvider(undefined, {
    timeoutMs: 400,
    terminateGraceMs: 100,
  });
  vi.useFakeTimers();
  try {
    const outcome = provider.complete("system", [{ role: "user", content: "x" }], 1)
      .then((value) => ({ value }), (error: Error) => ({ error }));
    await fake.ready();
    await vi.advanceTimersByTimeAsync(400);
    await fake.waitForSignal("SIGTERM");
    await vi.advanceTimersByTimeAsync(100);
    const result = await outcome;
    expect(result).toEqual({
      error: expect.objectContaining({ message: expect.stringMatching(/timed out/i) }),
    });
    expect(await readFile(fake.signalPath, "utf8")).toBe("SIGTERM\n");
    const [call] = await fake.calls();
    await expect(access(call.cwd)).rejects.toThrow();
  } finally {
    vi.useRealTimers();
  }
}

afterEach(async () => {
  vi.useRealTimers();
  process.env = { ...originalEnv };
  await Promise.all(fakes.splice(0).map((fake) => fake.cleanup()));
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("CodexAgentProvider process boundary", () => {
  it("runs an ephemeral, read-only, non-interactive exec in a cleaned throwaway cwd", async () => {
    const fake = await useFake({ textOutput: "compiled page" });
    process.env.OPENAI_API_KEY = "sk-parent-must-not-leak";
    process.env.ANTHROPIC_API_KEY = "parent-anthropic-secret";
    process.env.UNRELATED_PARENT_VALUE = "not-allowed";
    const provider = new CodexAgentProvider("gpt-test", { timeoutMs: 2_000 });

    await expect(provider.complete("system", [{ role: "user", content: "source" }], 17))
      .resolves.toBe("compiled page");
    const [call] = await fake.calls();
    expect(call.args).toEqual(expect.arrayContaining([
      "exec", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check",
      "--ignore-user-config", "--ignore-rules", "--color", "never",
      "--model", "gpt-test", "-",
    ]));
    expect(call.args).not.toContain("--json");
    expect(call.args).not.toContain("--ask-for-approval");
    const cdArg = call.args[call.args.indexOf("--cd") + 1].replace(/^\/private(?=\/var\/)/, "");
    expect(cdArg).toBe(call.cwd.replace(/^\/private(?=\/var\/)/, ""));
    expect(call.prompt).toContain("system");
    expect(call.prompt).toContain("source");
    expect(call.env.OPENAI_API_KEY).toBeUndefined();
    expect(call.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(call.env.UNRELATED_PARENT_VALUE).toBeUndefined();
    expect(Object.keys(call.env).sort()).toEqual(
      expect.arrayContaining(["HOME", "NO_COLOR", "PATH"]),
    );
    const allowed = new Set([
      "PATH", "HOME", "USERPROFILE", "CODEX_HOME", "TMPDIR", "TMP", "TEMP",
      "LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR", "SYSTEMROOT", "COMSPEC",
      "PATHEXT", "NO_COLOR",
      // macOS injects this after spawn even when it is absent from the supplied env object.
      "__CF_USER_TEXT_ENCODING",
    ]);
    expect(Object.keys(call.env).filter((name) => !allowed.has(name))).toEqual([]);
    await expect(access(call.cwd)).rejects.toThrow();
  });

  it.runIf(process.platform !== "win32")(
    "bypasses PATH interpreter wrappers that would expand the child environment",
    async () => {
      const fake = await useFake();
      const wrapperDirectory = await installInjectingNodeWrapper();
      process.env.PATH = [fake.binDir, wrapperDirectory, originalEnv.PATH ?? ""]
        .join(path.delimiter);
      await new CodexAgentProvider(undefined, { timeoutMs: 2_000 })
        .complete("system", [{ role: "user", content: "hello" }], 1);
      const [call] = await fake.calls();
      expect(call.env.LLMWIKI_LAUNCHER_INJECTED).toBeUndefined();
    },
  );

  it("passes no model flag when the operator leaves model selection to Codex", async () => {
    const fake = await useFake();
    await new CodexAgentProvider(undefined, { timeoutMs: 2_000 })
      .complete("system", [{ role: "user", content: "hello" }], 4096);
    expect((await fake.calls())[0].args).not.toContain("--model");
  });

  it("delivers Codex's buffered stream result as one final callback chunk", async () => {
    await useFake({ textOutput: "streamed page" });
    const chunks: string[] = [];
    const provider = new CodexAgentProvider(undefined, { timeoutMs: 2_000 });
    await expect(provider.stream(
      "system",
      [{ role: "user", content: "hello" }],
      4_096,
      (chunk) => chunks.push(chunk),
    )).resolves.toBe("streamed page");
    expect(chunks).toEqual(["streamed page"]);
  });

  it("rejects malformed JSON before a structured response can be consumed", async () => {
    await useFake({ rawToolOutput: "not-json" });
    const provider = new CodexAgentProvider(undefined, { timeoutMs: 2_000 });
    await expect(provider.toolCall("system", [{ role: "user", content: "x" }], [TOOL], 99))
      .rejects.toThrow(/invalid JSON/i);
  });

  it("validates structured last-message JSON against the requested schema", async () => {
    const fake = await useFake({ toolOutput: { value: 7 } });
    const provider = new CodexAgentProvider(undefined, { timeoutMs: 2_000 });
    await expect(provider.toolCall("system", [{ role: "user", content: "x" }], [TOOL], 99))
      .rejects.toThrow(/schema validation/i);
    const [call] = await fake.calls();
    await expect(access(call.cwd)).rejects.toThrow();
  });

  it("returns schema-valid structured output and cleans schema artifacts", async () => {
    const fake = await useFake({ toolOutput: { value: "safe" } });
    const provider = new CodexAgentProvider(undefined, { timeoutMs: 2_000 });
    await expect(provider.toolCall("system", [{ role: "user", content: "x" }], [TOOL], 99))
      .resolves.toBe('{"value":"safe"}');
    const [call] = await fake.calls();
    expect(call.schema).toEqual(TOOL.input_schema);
    expect(call.args).toContain("--output-schema");
    await expect(access(call.cwd)).rejects.toThrow();
  });

  it("rejects structured requests that do not provide exactly one schema", async () => {
    const provider = new CodexAgentProvider(undefined, { timeoutMs: 2_000 });
    await expect(provider.toolCall("system", [], [], 99)).rejects.toThrow(/exactly one/);
    await expect(provider.toolCall("system", [], [TOOL, TOOL], 99)).rejects.toThrow(/exactly one/);
  });

  it("drains unconsumed stdout without charging it to the diagnostic cap", async () => {
    const fake = await useFake({ stdoutBytes: 8_192 });
    const provider = new CodexAgentProvider(undefined, {
      timeoutMs: 2_000,
      maxOutputBytes: 1_024,
      terminateGraceMs: 50,
    });

    await expect(provider.complete("system", [{ role: "user", content: "x" }], 1))
      .resolves.toBe("Codex response");
    const [call] = await fake.calls();
    await expect(access(call.cwd)).rejects.toThrow();
  });

  it("does not charge an unread JSON event stream against final-message delivery", async () => {
    const answer = "x".repeat(768);
    const fake = await useFake({ textOutput: answer, jsonStdoutBytes: 2_048 });

    await expectCappedCompletion(answer);
    expect((await fake.calls())[0].args).not.toContain("--json");
  });

  it("does not double-charge final stdout duplicated into the last-message file", async () => {
    const answer = "x".repeat(768);
    await useFake({ textOutput: answer, stderr: "d".repeat(400) });

    await expectCappedCompletion(answer);
  });

  it("keeps stderr inside the subprocess output cap", async () => {
    const fake = await useFake({ stderr: "x".repeat(8_192) });
    await expectCleanFailure(fake, {
      timeoutMs: 2_000,
      maxOutputBytes: 1_024,
      terminateGraceMs: 50,
    }, /output limit/i);
  });

  it("caps the final-message artifact and cleans its throwaway directory", async () => {
    const fake = await useFake({ textOutput: "x".repeat(2_048) });
    await expectCleanFailure(fake, {
      timeoutMs: 2_000,
      maxOutputBytes: 1_024,
    }, /last message.*output limit/i);
  });

  it("cleans its throwaway directory when Codex omits the final message", async () => {
    const fake = await useFake({ omitOutput: true });
    await expectCleanFailure(fake, { timeoutMs: 2_000 }, /without a readable final message/i);
  });

  it("cleans its throwaway directory when the codex binary is absent", async () => {
    const root = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "llmwiki-codex-missing-"));
    tempRoots.push(root);
    const emptyBin = path.join(root, "bin");
    await mkdir(emptyBin);
    process.env.TMPDIR = root;
    process.env.PATH = emptyBin;
    await expect(new CodexAgentProvider(undefined, { timeoutMs: 2_000 })
      .complete("system", [{ role: "user", content: "x" }], 1))
      .rejects.toThrow(/Codex CLI.*not installed/i);
    expect((await readdir(root)).filter((name) => name.startsWith("llmwiki-codex-agent-")))
      .toEqual([]);
  });

  it("scrubs secret-shaped subprocess output from actionable failures", async () => {
    await useFake({
      exitCode: 7,
      stderr:
        'authentication failed: Bearer abc.secret, OPENAI_API_KEY=sk-live-secret, ' +
        'GITHUB_TOKEN="ghp-another-secret", password=hunter2',
    });
    const provider = new CodexAgentProvider(undefined, { timeoutMs: 2_000 });
    const failure = provider.complete("system", [{ role: "user", content: "x" }], 1);
    await expect(failure).rejects.toThrow(/Codex CLI.*authentication failed/i);
    await expect(failure).rejects.not.toThrow(/abc\.secret|sk-live-secret|ghp-another-secret|hunter2/);
  });

  it("bounds lifetime with graceful SIGTERM followed by forced termination", async () => {
    const fake = await useFake({ hang: true, ignoreTerm: true });
    await expectBoundedTimeout(fake);
  });

  it("bounds timeout lifetime when Codex leaves a descendant holding its pipes", async () => {
    const fake = await useFake({ hang: true, ignoreTerm: true, forkDescendant: true });
    await expectBoundedTimeout(fake);
  });
});
