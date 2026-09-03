/**
 * Process-boundary fake for Codex CLI provider tests.
 *
 * Installs an executable named exactly `codex` in a temporary PATH directory.
 * The executable records argv, cwd, stdin, schema, and its complete environment
 * before returning configured last-message output. This keeps tests faithful to
 * the real spawn boundary without adding a production-only binary override.
 */

import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** Behavior configured into one fake Codex executable. */
export interface FakeCodexOptions {
  toolOutput?: unknown;
  rawToolOutput?: string;
  textOutput?: string;
  stderr?: string;
  stdoutBytes?: number;
  jsonStdoutBytes?: number;
  exitCode?: number;
  hang?: boolean;
  ignoreTerm?: boolean;
  forkDescendant?: boolean;
  omitOutput?: boolean;
}

/** One invocation captured by the fake executable. */
export interface CapturedCodexCall {
  args: string[];
  cwd: string;
  env: Record<string, string>;
  pid: number;
  prompt: string;
  schema: unknown | null;
}

/** Installed fake plus helpers for reading its journal and cleaning it up. */
export interface FakeCodex {
  binDir: string;
  capturePath: string;
  readyPath: string;
  signalPath: string;
  calls(): Promise<CapturedCodexCall[]>;
  ready(): Promise<void>;
  waitForSignal(signal: NodeJS.Signals): Promise<void>;
  cleanup(): Promise<void>;
}

/** Read changing fixture state without treating a missing journal as an error. */
async function fileContains(filePath: string, expected: string): Promise<boolean> {
  try {
    return (await readFile(filePath, "utf8")).includes(expected);
  } catch {
    return false;
  }
}

/** Resolve once a child-owned journal records expected state, without clock assumptions. */
async function waitForFileContent(filePath: string, expected: string): Promise<void> {
  while (!(await fileContains(filePath, expected))) {
    // Each asynchronous read yields to the child process that owns the journal.
  }
}

/** Serialize a value for embedding in the generated CommonJS fixture. */
function literal(value: unknown): string {
  return JSON.stringify(value);
}

/** JavaScript expression yielding the fake's structured final-message bytes. */
function structuredOutputExpression(options: FakeCodexOptions): string {
  if (options.rawToolOutput !== undefined) return literal(options.rawToolOutput);
  return `JSON.stringify(${literal(options.toolOutput ?? { value: "ok" })})`;
}

/** Build the fixture script body from immutable test configuration. */
function fixtureSource(
  capturePath: string,
  readyPath: string,
  signalPath: string,
  options: FakeCodexOptions,
): string {
  const structuredOutput = structuredOutputExpression(options);
  return `#!/usr/bin/env node
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const args = process.argv.slice(2);
const after = (flag) => { const i = args.indexOf(flag); return i < 0 ? null : args[i + 1]; };
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  const schemaPath = after("--output-schema");
  const outputPath = after("--output-last-message");
  const schema = schemaPath ? JSON.parse(fs.readFileSync(schemaPath, "utf8")) : null;
  fs.appendFileSync(${literal(capturePath)}, JSON.stringify({
    args, cwd: process.cwd(), env: process.env, pid: process.pid, prompt, schema,
  }) + "\\n");
  if (${literal(options.hang === true)}) {
    const markReady = () => fs.writeFileSync(${literal(readyPath)}, "ready\\n");
    process.on("SIGTERM", () => {
      fs.appendFileSync(${literal(signalPath)}, "SIGTERM\\n");
      if (!${literal(options.ignoreTerm === true)}) process.exit(143);
    });
    if (${literal(options.forkDescendant === true)}) {
      const descendant = spawn(process.execPath, ["-e", ${literal(
        'process.on("SIGTERM", () => {}); process.send("ready"); setInterval(() => {}, 1000);',
      )}], { stdio: ["inherit", "inherit", "inherit", "ipc"] });
      descendant.once("message", markReady);
    } else {
      markReady();
    }
    setInterval(() => {}, 1000);
    return;
  }
  fs.writeFileSync(${literal(readyPath)}, "ready\\n");
  if (${literal(options.stderr ?? "")}) process.stderr.write(${literal(options.stderr ?? "")});
  const value = schemaPath
    ? ${structuredOutput}
    : ${literal(options.textOutput ?? "Codex response")};
  const stdoutBytes = ${literal(options.stdoutBytes ?? 0)}
    + (args.includes("--json") ? ${literal(options.jsonStdoutBytes ?? 0)} : 0);
  if (stdoutBytes > 0) process.stdout.write("x".repeat(stdoutBytes));
  if (outputPath && !${literal(options.omitOutput === true)}) {
    fs.writeFileSync(outputPath, value, { mode: 0o600 });
  }
  if (stdoutBytes === 0 && args.includes("--json")) {
    process.stdout.write('{"type":"turn.completed"}\\n');
  } else if (stdoutBytes === 0) {
    process.stdout.write(value);
  }
  process.exit(${literal(options.exitCode ?? 0)});
});
`;
}

/** Install a configured fake `codex` binary in an isolated directory. */
export async function installFakeCodex(options: FakeCodexOptions = {}): Promise<FakeCodex> {
  const root = await mkdtemp(path.join(tmpdir(), "llmwiki-fake-codex-"));
  const binDir = path.join(root, "bin");
  const capturePath = path.join(root, "calls.jsonl");
  const readyPath = path.join(root, "ready");
  const signalPath = path.join(root, "signals.log");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(binDir));
  const binaryPath = path.join(binDir, "codex");
  await writeFile(binaryPath, fixtureSource(capturePath, readyPath, signalPath, options), "utf8");
  await chmod(binaryPath, 0o755);
  return {
    binDir,
    capturePath,
    readyPath,
    signalPath,
    async calls() {
      try {
        const content = await readFile(capturePath, "utf8");
        return content.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      } catch {
        return [];
      }
    },
    ready: () => waitForFileContent(readyPath, "ready\n"),
    waitForSignal: (signal) => waitForFileContent(signalPath, `${signal}\n`),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
