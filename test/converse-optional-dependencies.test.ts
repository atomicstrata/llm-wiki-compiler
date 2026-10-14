/**
 * Guard the optional Converse installation boundary in source and built output.
 * Missing protocol packages must not prevent CLI/SDK startup, and selecting
 * Converse must give installation guidance without entering the retry loop.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";

const exec = promisify(execFile);
const packages = ["@aws-sdk/client-bedrock-runtime", "@smithy/node-http-handler"];

afterEach(() => {
  vi.doUnmock("@aws-sdk/client-bedrock-runtime");
  vi.doUnmock("@smithy/node-http-handler");
  vi.unstubAllEnvs();
  vi.resetModules();
});

it("starts the built CLI and SDKs without loading optional Converse packages", async () => {
  const script = `
    import { registerHooks } from "node:module";
    registerHooks({ resolve(specifier, context, nextResolve) {
      if (${JSON.stringify(packages)}.includes(specifier)) {
        throw new Error("Unexpected Converse dependency load: " + specifier);
      }
      return nextResolve(specifier, context);
    } });
    await import("./dist/index.js");
    await import("@atomicstrata/llmwiki-core");
    process.argv = [process.execPath, "dist/cli.js", "--help"];
    await import("./dist/cli.js");
  `;
  const result = await exec(process.execPath, ["--input-type=module", "--eval", script], {
    env: { ...process.env, LLMWIKI_PROVIDER: "offline" },
  });
  expect(result.stdout).toContain("Usage:");
  expect(result.stderr).not.toContain("Unexpected Converse dependency load");
});

it.each(packages)("reports missing %s only when Converse is used", async (missing) => {
  vi.resetModules();
  const unavailable = vi.fn(() => { throw new Error("Cannot find package"); });
  vi.doMock(missing, unavailable);
  const { callClaude } = await import("../src/utils/llm.js");
  expect(unavailable).not.toHaveBeenCalled();
  vi.stubEnv("LLMWIKI_PROVIDER", "converse");
  vi.stubEnv("LLMWIKI_MODEL", "test-model");
  vi.stubEnv("LLMWIKI_CONVERSE_BASE_URL", "http://127.0.0.1:1");
  vi.stubEnv("LLMWIKI_CONVERSE_API_KEY", "test-secret");
  for (const mode of [{}, { stream: true }, { tools: [{ name: "extract", description: "Extract", input_schema: {} }] }]) {
    unavailable.mockClear();
    await expect(callClaude({ system: "Test", messages: [], ...mode })).rejects.toMatchObject({
      message: expect.stringContaining("npm install @aws-sdk/client-bedrock-runtime @smithy/node-http-handler"),
      nonRetryable: true,
    });
    expect(unavailable).toHaveBeenCalledTimes(1);
  }
});
