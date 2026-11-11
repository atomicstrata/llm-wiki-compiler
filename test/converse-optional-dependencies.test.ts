/**
 * Guard the optional Converse installation boundary in source and built output.
 * Missing protocol packages must not prevent CLI/SDK startup, and selecting
 * Converse must give installation guidance without entering the retry loop.
 *
 * Each case runs in a child `bun` whose loader plugin makes the named
 * packages fail to load — a genuinely missing install, rather than a mocked
 * module, so the production import path is what fails.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "bun:test";

const exec = promisify(execFile);
const packages = ["@aws-sdk/client-bedrock-runtime", "@smithy/node-http-handler"];
const LLM_MODULE = new URL("../src/utils/llm.js", import.meta.url).pathname;

/** Script prelude that counts and refuses every load of the `denied` packages. */
function denyLoading(denied: string[]): string {
  return `
    globalThis.deniedLoads = [];
    const denied = new Set(${JSON.stringify(denied)});
    Bun.plugin({ name: "deny-converse", setup(build) {
      build.onLoad({ filter: /node_modules\\/@(aws-sdk|smithy)\\// }, (args) => {
        const name = [...denied].find((pkg) => args.path.includes("/node_modules/" + pkg + "/"));
        if (!name) return undefined;
        globalThis.deniedLoads.push(name);
        throw new Error("Cannot find package " + name);
      });
    } });
  `;
}

it("starts the built CLI and SDKs without loading optional Converse packages", async () => {
  const script = `${denyLoading(packages)}
    await import("./dist/index.js");
    await import("@atomicstrata/llmwiki-core");
    // The CLI loads a command's code only when it runs, so load every command.
    for (const chunk of require("node:fs").readdirSync("dist/cli-chunks")) {
      if (chunk.endsWith(".js")) await import("./dist/cli-chunks/" + chunk);
    }
    process.argv = [process.execPath, "dist/cli.js", "--help"];
    await import("./dist/cli.js");
    if (globalThis.deniedLoads.length) throw new Error("Unexpected Converse dependency load");
  `;
  const result = await exec(process.execPath, ["--eval", script], {
    env: { ...process.env, LLMWIKI_PROVIDER: "offline" },
  });
  expect(result.stdout).toContain("Usage:");
});

it.each(packages)("reports missing %s only when Converse is used", async (missing) => {
  const script = `${denyLoading([missing])}
    const { callClaude } = await import(${JSON.stringify(LLM_MODULE)});
    const loadsAtImport = globalThis.deniedLoads.length;
    const modes = [{}, { stream: true }, { tools: [{ name: "extract", description: "Extract", input_schema: {} }] }];
    const results = [];
    for (const mode of modes) {
      globalThis.deniedLoads = [];
      const error = await callClaude({ system: "Test", messages: [], ...mode }).then(() => null, (e) => e);
      results.push({ message: error?.message, nonRetryable: error?.nonRetryable, loads: globalThis.deniedLoads.length });
    }
    console.log(JSON.stringify({ loadsAtImport, results }));
  `;
  const { stdout } = await exec(process.execPath, ["--eval", script], {
    env: {
      ...process.env,
      LLMWIKI_PROVIDER: "converse",
      LLMWIKI_MODEL: "test-model",
      LLMWIKI_CONVERSE_BASE_URL: "http://127.0.0.1:1",
      LLMWIKI_CONVERSE_API_KEY: "test-secret",
    },
  });
  const report = JSON.parse(stdout.trim().split("\n").at(-1)!);
  expect(report.loadsAtImport).toBe(0);
  for (const result of report.results) {
    expect(result.message).toContain("bun add @aws-sdk/client-bedrock-runtime @smithy/node-http-handler");
    expect(result.nonRetryable).toBe(true);
    expect(result.loads).toBe(1);
  }
});
