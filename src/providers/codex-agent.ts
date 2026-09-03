/**
 * OpenAI Codex CLI-backed LLM provider.
 *
 * Every request launches a fresh `codex exec` process in an empty throwaway
 * directory. The child is ephemeral, read-only sandboxed, non-interactive, and
 * receives only a small environment allowlist needed to locate Codex and its
 * locally managed login. llmwiki never opens Codex credential files or forwards
 * API-key environment variables.
 */

import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Ajv from "ajv";
import type { LLMMessage, LLMProvider, LLMTool } from "../utils/provider.js";
import { registerCodexProcess, signalCodexTree } from "./codex-agent-lifecycle.js";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_TERMINATE_GRACE_MS = 1_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const OUTPUT_FILE = "last-message.txt";
const SCHEMA_FILE = "output-schema.json";
const MINIMUM_CODEX_VERSION = "0.152.1";
const ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "CODEX_HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "SYSTEMROOT",
  "COMSPEC",
  "PATHEXT",
] as const;
const ajv = new Ajv({ allErrors: true, strict: false });

/** Testable resource bounds; production uses the secure defaults above. */
export interface CodexAgentProviderOptions {
  timeoutMs?: number;
  terminateGraceMs?: number;
  maxOutputBytes?: number;
}

/** Provider failure that the shared retry loop must not repeat. */
class CodexAgentError extends Error {
  readonly nonRetryable = true;

  constructor(message: string) {
    super(message);
    this.name = "CodexAgentError";
  }
}

/** Report the required local dependency without exposing lookup internals. */
function missingCodexError(): CodexAgentError {
  return new CodexAgentError(
    "Codex CLI is not installed or is unavailable on PATH. Install the OpenAI Codex CLI, run `codex login`, and retry.",
  );
}

interface ProcessResult {
  code: number;
  stderr: string;
}

type TerminationReason = "timeout" | "output-limit";

interface ProcessState {
  stderr: string;
  stderrBytes: number;
  reason?: TerminationReason;
  timeout: NodeJS.Timeout;
  forceTimer?: NodeJS.Timeout;
}

/** Render system and conversation roles into one stdin-only Codex request. */
function buildPrompt(system: string, messages: LLMMessage[], structured = false): string {
  const conversation = messages
    .map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.content}`)
    .join("\n\n");
  const outputRule = structured
    ? "Return only one JSON value matching the supplied output schema."
    : "Return only the requested final content, without commentary or a Markdown fence.";
  return [
    "Fulfill this single llmwiki language-model request without inspecting files or using tools.",
    outputRule,
    "",
    "System instructions:",
    system,
    "",
    "Conversation:",
    conversation,
  ].join("\n");
}

/** Construct the complete, deliberately small child environment. */
function childEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NO_COLOR: "1" };
  for (const name of ENV_ALLOWLIST) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  if (env.PATH && process.platform !== "win32") env.PATH = interpreterSafePath(env.PATH);
  return env;
}

/** Keep env-based Node shebangs away from wrappers that synthesize variables. */
function interpreterSafePath(searchPath: string): string {
  const runtimeDirectory = path.dirname(process.execPath);
  const directories = searchPath.split(path.delimiter)
    .filter((directory) => directory && directory !== runtimeDirectory);
  return [runtimeDirectory, ...directories].join(path.delimiter);
}

/** Select Codex before changing interpreter lookup, preserving PATH precedence. */
function resolveCodexExecutable(searchPath: string | undefined): string {
  if (process.platform === "win32") return "codex";
  if (!searchPath) throw missingCodexError();
  for (const directory of searchPath.split(path.delimiter)) {
    if (!directory || !path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, "codex");
    try {
      accessSync(candidate, fsConstants.X_OK);
      if (!statSync(candidate).isFile()) continue;
      return candidate;
    } catch {
      // Continue through eligible entries in the original PATH order.
    }
  }
  throw missingCodexError();
}

/** Retain child diagnostics while enforcing their byte ceiling. */
function captureStderr(state: ProcessState, chunk: Buffer, limit: number): boolean {
  state.stderrBytes += chunk.byteLength;
  if (state.stderrBytes > limit) return false;
  state.stderr += chunk.toString("utf8");
  return true;
}

/** Spawn one bounded Codex child, escalating SIGTERM to SIGKILL when needed. */
function finishProcess(
  code: number | null,
  state: ProcessState,
  options: Required<CodexAgentProviderOptions>,
  resolve: (result: ProcessResult) => void,
  reject: (error: Error) => void,
): void {
  clearTimeout(state.timeout);
  if (state.forceTimer) clearTimeout(state.forceTimer);
  if (state.reason === "timeout") {
    reject(new CodexAgentError(`Codex CLI timed out after ${options.timeoutMs}ms.`));
  } else if (state.reason === "output-limit") {
    reject(new CodexAgentError(`Codex CLI exceeded the ${options.maxOutputBytes}-byte output limit.`));
  } else {
    resolve({ code: code ?? 1, stderr: state.stderr });
  }
}

/** Spawn one bounded Codex child, escalating SIGTERM to SIGKILL when needed. */
function runCodex(
  args: string[],
  cwd: string,
  prompt: string,
  options: Required<CodexAgentProviderOptions>,
  retainCustody: (release: () => void) => void,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const executable = resolveCodexExecutable(process.env.PATH);
    const child = spawn(executable, args, {
      cwd,
      detached: true,
      env: childEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const state: ProcessState = {
      stderr: "",
      stderrBytes: 0,
      timeout: setTimeout(() => terminate("timeout"), options.timeoutMs),
    };
    retainCustody(registerCodexProcess(child, cwd, options.terminateGraceMs));
    function terminate(reason: TerminationReason): void {
      if (state.reason) return;
      state.reason = reason;
      signalCodexTree(child, "SIGTERM");
      state.forceTimer = setTimeout(
        () => signalCodexTree(child, "SIGKILL"),
        options.terminateGraceMs,
      );
    }
    const capture = (chunk: Buffer): void => {
      if (!captureStderr(state, chunk, options.maxOutputBytes)) terminate("output-limit");
    };
    child.stdout.resume();
    child.stderr.on("data", capture);
    child.once("error", (error: NodeJS.ErrnoException) => reject(spawnError(error)));
    child.once("close", (code) => {
      finishProcess(code, state, options, resolve, reject);
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(prompt);
  });
}

/** Translate spawn failures without ever echoing unsanitized process detail. */
function spawnError(error: NodeJS.ErrnoException): CodexAgentError {
  if (error.code === "ENOENT") return missingCodexError();
  return new CodexAgentError(
    `Codex CLI could not start (${error.code ?? "unknown process error"}). ` +
      "Check the local Codex installation and retry.",
  );
}

/** Read at most `limit + 1` bytes so a hostile output file cannot race a stat. */
async function readBoundedFile(filePath: string, limit: number): Promise<string> {
  const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile()) {
      throw new CodexAgentError("Codex CLI last-message output was not a regular file.");
    }
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > limit) {
      throw new CodexAgentError(`Codex CLI last message exceeded the ${limit}-byte output limit.`);
    }
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

/** Build fixed safety flags plus optional model/schema arguments. */
function codexArgs(cwd: string, outputPath: string, model?: string, schemaPath?: string): string[] {
  return [
    "exec",
    "--ephemeral",
    "--sandbox", "read-only",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "--ignore-rules",
    "--color", "never",
    "--cd", cwd,
    "--output-last-message", outputPath,
    ...(schemaPath ? ["--output-schema", schemaPath] : []),
    ...(model ? ["--model", model] : []),
    "-",
  ];
}

/** Turn a non-zero Codex exit into an actionable error without echoing child output. */
function exitError(result: ProcessResult): CodexAgentError {
  const authFailed = /auth|credential|log(?:ged)?[- ]?in/i.test(result.stderr);
  const incompatible = /(?:unknown|unexpected|unrecognized|invalid)\s+(?:argument|option)/i
    .test(result.stderr);
  if (incompatible) {
    return new CodexAgentError(
      `Installed Codex CLI is incompatible with codex-agent. Upgrade to Codex CLI ${MINIMUM_CODEX_VERSION} or newer. ` +
        "Child output was withheld to protect secrets.",
    );
  }
  if (authFailed) {
    return new CodexAgentError(
      "Codex CLI authentication failed: it is not authenticated or its login was rejected. " +
        "Run `codex login` and retry. " +
        "Child output was withheld to protect secrets.",
    );
  }
  return new CodexAgentError(
    `Codex CLI failed with exit code ${result.code}. Check the local Codex installation and retry. ` +
      "Child output was withheld to protect secrets.",
  );
}

/** Codex CLI-backed provider using the CLI's locally managed ChatGPT login. */
export class CodexAgentProvider implements LLMProvider {
  private readonly model?: string;
  private readonly options: Required<CodexAgentProviderOptions>;

  constructor(model?: string, options: CodexAgentProviderOptions = {}) {
    this.model = model?.trim() || undefined;
    this.options = {
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      terminateGraceMs: options.terminateGraceMs ?? DEFAULT_TERMINATE_GRACE_MS,
      maxOutputBytes: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    };
  }

  /** Complete one request. `maxTokens` is unsupported by Codex CLI and intentionally not forwarded. */
  async complete(system: string, messages: LLMMessage[], _maxTokens: number): Promise<string> {
    return this.invoke(buildPrompt(system, messages));
  }

  /** Codex buffers its final message; expose it as one callback chunk after completion. */
  async stream(
    system: string,
    messages: LLMMessage[],
    _maxTokens: number,
    onToken?: (text: string) => void,
  ): Promise<string> {
    const text = await this.invoke(buildPrompt(system, messages));
    onToken?.(text);
    return text;
  }

  /** Request one schema-constrained JSON result and validate it again before returning it. */
  async toolCall(
    system: string,
    messages: LLMMessage[],
    tools: LLMTool[],
    _maxTokens: number,
  ): Promise<string> {
    if (tools.length !== 1) {
      throw new CodexAgentError(`Codex CLI requires exactly one structured tool schema; received ${tools.length}.`);
    }
    const schema = tools[0].input_schema;
    const raw = await this.invoke(buildPrompt(system, messages, true), schema);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new CodexAgentError("Codex CLI returned invalid JSON for a structured request.");
    }
    const validate = ajv.compile(schema);
    if (!validate(parsed)) {
      throw new CodexAgentError(`Codex CLI response failed schema validation: ${ajv.errorsText(validate.errors)}`);
    }
    return JSON.stringify(parsed);
  }

  /** Codex CLI exposes no embeddings API; an explicit existing backend is required. */
  async embed(_text: string): Promise<number[]> {
    throw new CodexAgentError(
      "The codex-agent provider cannot serve embeddings. Set LLMWIKI_EMBEDDING_PROVIDER to an existing embedding backend.",
    );
  }

  /** Execute one request with private artifacts that are removed on every path. */
  private async invoke(prompt: string, schema?: Record<string, unknown>): Promise<string> {
    const cwd = await mkdtemp(path.join(tmpdir(), "llmwiki-codex-agent-"));
    const outputPath = path.join(cwd, OUTPUT_FILE);
    const schemaPath = schema ? path.join(cwd, SCHEMA_FILE) : undefined;
    let releaseCustody = (): void => undefined;
    try {
      if (schemaPath) await writeFile(schemaPath, JSON.stringify(schema), { mode: 0o600 });
      const result = await runCodex(
        codexArgs(cwd, outputPath, this.model, schemaPath),
        cwd,
        prompt,
        this.options,
        (release) => { releaseCustody = release; },
      );
      if (result.code !== 0) throw exitError(result);
      try {
        return await readBoundedFile(outputPath, this.options.maxOutputBytes);
      } catch (error) {
        if (error instanceof CodexAgentError) throw error;
        throw new CodexAgentError(
          "Codex CLI completed without a readable final message. " +
            "Its diagnostics were withheld to protect secrets; retry after checking the local Codex installation.",
        );
      }
    } finally {
      try {
        await rm(cwd, { recursive: true, force: true });
      } finally {
        releaseCustody();
      }
    }
  }
}
