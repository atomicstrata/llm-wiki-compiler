/**
 * aimock helper for subprocess CLI tests.
 *
 * Spins up a `@copilotkit/aimock` LLMock server on an ephemeral port and
 * returns the URL plus the env overrides needed to point our Anthropic
 * provider at it. CLI subprocesses started via `runCLI(args, cwd, env)`
 * with the returned env will have their `AnthropicProvider` talk to the
 * mock instead of the real API.
 *
 * This unlocks subprocess-level CLI tests for `compile`, `query`, and any
 * other code path that needs the LLM — without the recurring "no canned
 * provider" gap that codex has flagged on multiple branches.
 *
 * @example
 * ```
 * const handle = await startMockClaude();
 * try {
 *   handle.mock.onToolCall("extract_concepts", { toolCalls: [{ name, arguments }] });
 *   handle.mock.onMessage(/.* /, { content: "page body" });
 *   const result = await runCLI(["compile"], cwd, mockClaudeEnv(handle));
 *   expectCLIExit(result, 0);
 * } finally {
 *   await stopMockClaude(handle);
 * }
 * ```
 */

import { LLMock } from "@copilotkit/aimock";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import path from "path";
import { tmpdir } from "os";
import { afterEach } from "vitest";

/** Handle returned from {@link startMockClaude}. */
export interface MockClaudeHandle {
  /** Base URL the mock is listening on (e.g. "http://127.0.0.1:54321"). */
  url: string;
  /** Underlying LLMock instance — call .onMessage / .onToolCall to register canned responses. */
  mock: LLMock;
}

/**
 * Start a mock Anthropic-compatible server on an ephemeral port.
 * Caller is responsible for calling {@link stopMockClaude} when done.
 */
export async function startMockClaude(): Promise<MockClaudeHandle> {
  const mock = new LLMock({ port: 0, logLevel: "silent" });
  await mock.start();
  return { url: mock.url, mock };
}

/** Tear down a mock Claude instance. Safe to call in finally blocks. */
export async function stopMockClaude(handle: MockClaudeHandle): Promise<void> {
  await handle.mock.stop();
}

/**
 * Env overrides to inject into `runCLI` so the CLI subprocess routes
 * Anthropic API calls to the mock. The mock-key value is arbitrary —
 * the CLI's credential check only verifies the env var is non-empty.
 *
 * Note: Anthropic embeddings go to Voyage (a different host) which is
 * NOT intercepted by this helper. Use {@link mockOpenAIEnv} for tests
 * that need both completions and embeddings stubbed under one base URL.
 */
export function mockClaudeEnv(handle: MockClaudeHandle): NodeJS.ProcessEnv {
  return {
    ANTHROPIC_BASE_URL: handle.url,
    ANTHROPIC_API_KEY: "mock-key-for-aimock",
    // Pin provider explicitly so a dev environment with LLMWIKI_PROVIDER=ollama
    // doesn't bypass the Anthropic mock.
    LLMWIKI_PROVIDER: "anthropic",
  };
}

/**
 * Env overrides for OpenAI-mode subprocess tests. Use this when the test
 * needs both chat and embedding calls intercepted (the OpenAI provider
 * routes both through OPENAI_BASE_URL, unlike the Anthropic provider
 * which uses Voyage for embeddings).
 *
 * @param handle - aimock handle from {@link startMockClaude}.
 * @param model - Optional model name override (defaults to "gpt-4o").
 */
export function mockOpenAIEnv(
  handle: MockClaudeHandle,
  model = "gpt-4o",
): NodeJS.ProcessEnv {
  return {
    OPENAI_BASE_URL: `${handle.url}/v1`,
    OPENAI_API_KEY: "mock-key-for-aimock",
    LLMWIKI_PROVIDER: "openai",
    LLMWIKI_MODEL: model,
    LLMWIKI_EMBEDDING_MODEL: "text-embedding-3-small",
  };
}

/**
 * Walk aimock's recorded requests and return the system-prompt content
 * from the first request whose user-message content satisfies the
 * predicate. Returns null when no matching request is found.
 *
 * Centralised because every aimock-backed CLI test that wants to assert
 * "the LLM saw <X> in the system prompt" has to slice the same way:
 * aimock normalises Anthropic's top-level `system` field into a
 * `{role: "system", content: ...}` message in `body.messages`, so the
 * walker has to inspect both system and user messages per request and
 * disambiguate by user-message content.
 */
export function findSystemPromptByUserMessage(
  handle: MockClaudeHandle,
  predicate: (userMessage: string) => boolean,
): string | null {
  const requests = handle.mock.getRequests() as Array<{ body?: unknown }>;
  for (const req of requests) {
    const body = req.body as { messages?: unknown } | undefined;
    if (!Array.isArray(body?.messages)) continue;
    let systemPrompt = "";
    let userPrompt = "";
    for (const msg of body.messages as Array<{ role?: unknown; content?: unknown }>) {
      if (msg.role === "system" && typeof msg.content === "string") systemPrompt = msg.content;
      if (msg.role === "user" && typeof msg.content === "string") userPrompt = msg.content;
    }
    if (predicate(userPrompt)) return systemPrompt;
  }
  return null;
}

/** Live state managed by {@link useAimockLifecycle}. */
export interface AimockLifecycle {
  /** Currently-running mock, or null between tests. Set by `start()`. */
  handle: MockClaudeHandle | null;
  /** Start a fresh mock and store the handle in `lifecycle.handle`. */
  start: () => Promise<MockClaudeHandle>;
  /** Create a temp project workspace with sources/ + one source file. */
  makeWorkspace: (sourceContent: string, sourceName?: string) => Promise<string>;
}

/**
 * Vitest composable that wires up afterEach cleanup for an aimock-backed
 * subprocess test: stops the mock if one was started, then removes any
 * temp workspaces created by `makeWorkspace`. Avoids per-file boilerplate
 * for the common pattern.
 *
 * @example
 * ```
 * const aimock = useAimockLifecycle("my-test");
 * it("...", async () => {
 *   const handle = await aimock.start();
 *   handle.mock.onMessage(/.* /, { content: "..." });
 *   const cwd = await aimock.makeWorkspace("# source\n");
 *   const result = await runCLI(["compile"], cwd, mockOpenAIEnv(handle));
 *   ...
 * });
 * ```
 */
export function useAimockLifecycle(workspacePrefix: string): AimockLifecycle {
  const tempDirs: string[] = [];
  const lifecycle: AimockLifecycle = {
    handle: null,
    async start(): Promise<MockClaudeHandle> {
      lifecycle.handle = await startMockClaude();
      return lifecycle.handle;
    },
    async makeWorkspace(sourceContent: string, sourceName = "intro.md"): Promise<string> {
      const cwd = await mkdtemp(path.join(tmpdir(), `llmwiki-${workspacePrefix}-`));
      tempDirs.push(cwd);
      await mkdir(path.join(cwd, "sources"), { recursive: true });
      await writeFile(path.join(cwd, "sources", sourceName), sourceContent, "utf-8");
      return cwd;
    },
  };

  afterEach(async () => {
    if (lifecycle.handle) {
      await stopMockClaude(lifecycle.handle);
      lifecycle.handle = null;
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  });

  return lifecycle;
}

/**
 * Stub the two model calls a compile makes — concept extraction and the page
 * body — so a CLI compile completes without a real provider.
 *
 * Lives here rather than in each test because more than one suite needs a
 * compile to simply SUCCEED while it asserts on something else (which sources
 * were recompiled, what state recorded). A suite that cares about the concepts
 * themselves should stub its own.
 *
 * @param handle - The running aimock handle to program.
 * @param concept - Concept title, so two suites' fixtures stay distinguishable.
 */
export function stubCannedCompile(handle: MockClaudeHandle, concept = "Canned Concept"): void {
  handle.mock.onToolCall("extract_concepts", {
    toolCalls: [
      {
        name: "extract_concepts",
        arguments: {
          concepts: [
            {
              concept,
              summary: `Concept emitted by aimock for ${concept}.`,
              is_new: true,
              tags: ["canned"],
              confidence: 0.9,
            },
          ],
        },
      },
    ],
  });
  handle.mock.onMessage(/.*/, { content: `Page body produced for ${concept}.` });
}
