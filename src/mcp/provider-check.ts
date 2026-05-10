/**
 * Per-tool provider validation for the MCP server.
 *
 * The MCP server starts without any API key check so read-only tools
 * (read_page, lint_wiki, wiki_status) and the ingest tool always work.
 * Tools that need an LLM call (compile, query, search) invoke this guard
 * to surface a clean error if credentials are missing.
 */

import { DEFAULT_PROVIDER } from "../utils/constants.js";
import { resolveAnthropicAuthFromEnv } from "../utils/claude-settings.js";

/** Map of provider name to the env var that satisfies it. Null = no key needed. */
const PROVIDER_KEY_VARS: Record<string, string | null> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  ollama: null,
  minimax: "MINIMAX_API_KEY",
  copilot: "GITHUB_TOKEN",
};

/**
 * Throw if the active LLM provider is missing credentials.
 * Anthropic accepts either ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN
 * (resolved through the Claude Code settings fallback chain).
 */
export function ensureProviderAvailable(): void {
  const provider = process.env.LLMWIKI_PROVIDER ?? DEFAULT_PROVIDER;

  if (provider === "anthropic") {
    const auth = resolveAnthropicAuthFromEnv();
    if (!auth.apiKey && !auth.authToken) {
      throw new Error(
        'Anthropic credentials are required for the "anthropic" provider. ' +
          "Set ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN.",
      );
    }
    return;
  }

  const keyVar = PROVIDER_KEY_VARS[provider];
  if (keyVar === undefined) {
    throw new Error(
      `Unknown provider "${provider}". Supported: ${Object.keys(PROVIDER_KEY_VARS).join(", ")}`,
    );
  }

  if (keyVar && !process.env[keyVar]) {
    throw new Error(
      `${keyVar} environment variable is required for the "${provider}" provider.`,
    );
  }
}
