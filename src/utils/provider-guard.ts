/**
 * Single provider-credential guard shared by every entry point that
 * needs an LLM call (CLI compile/query/watch, MCP tools, the upcoming
 * `quickstart` command).
 *
 * The guard throws on failure instead of calling `process.exit(1)`,
 * which lets every caller decide how to surface the failure:
 *
 *  - CLI verbs catch the throw and print the message + exit 1.
 *  - MCP tools let the throw propagate as a tool error.
 *  - `quickstart` catches the throw and translates it into the
 *    `compile.error = { code: "provider_unavailable", ... }` shape
 *    documented in the next-quickstart implementation plan.
 *
 * Error messages mirror the rich CLI form (with `Set it with: export X=...`
 * hints) so the user always sees actionable guidance no matter which
 * surface fired the guard.
 */

import { DEFAULT_PROVIDER } from "./constants.js";
import { resolveAnthropicAuthFromEnv } from "./claude-settings.js";
import { findEmbeddingProviderProblem } from "./embedding-provider.js";

/** Thrown when the active provider has no usable credentials. */
export class ProviderUnavailableError extends Error {
  readonly code = "provider_unavailable" as const;
  constructor(readonly provider: string, readonly missing: string[], message: string) {
    super(message);
    this.name = "ProviderUnavailableError";
  }
}

/** Thrown when LLMWIKI_PROVIDER names an unsupported provider. */
export class UnknownProviderError extends Error {
  readonly code = "unknown_provider" as const;
  constructor(readonly provider: string, readonly supported: string[], message: string) {
    super(message);
    this.name = "UnknownProviderError";
  }
}

/** Map of provider name to the env var that satisfies it. Null = no key needed. */
const PROVIDER_KEY_VARS: Record<string, string | null> = {
  anthropic: "ANTHROPIC_API_KEY",
  "claude-agent": null,
  openai: "OPENAI_API_KEY",
  ollama: null,
  minimax: "MINIMAX_API_KEY",
  orcarouter: "ORCAROUTER_API_KEY",
  copilot: "GITHUB_TOKEN",
};

/**
 * Throw if LLMWIKI_EMBEDDING_PROVIDER names a backend that cannot serve
 * embeddings, or one whose credential is missing (issue #154).
 *
 * No-op when the variable is unset — the default path keeps degrading to lexical
 * ranking on a missing embedding key, as documented.
 *
 * Runs HERE, at the door, rather than where the embedding provider is built.
 * That call site sits inside retrieval and inside the compile write pass, and a
 * throw there behaves differently on each surface: `query` exits 1, context
 * retrieval degrades, and compile swallows it, bumps the pending-embeddings
 * attempt counter, and quarantines the pages after five tries. One misspelled
 * variable is not worth three behaviours and silent data attrition.
 */
function ensureEmbeddingProviderAvailable(): void {
  const problem = findEmbeddingProviderProblem();
  if (!problem) return;
  if (problem.kind === "unknown") {
    throw new UnknownProviderError(problem.provider, problem.supported, problem.message);
  }
  throw new ProviderUnavailableError(problem.provider, problem.missing, problem.message);
}

/**
 * Throw if the active LLM provider is missing credentials, or if the embedding
 * provider override is unusable.
 * Anthropic accepts either ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN
 * (resolved through the Claude Code settings fallback chain).
 */
export function ensureProviderAvailable(): void {
  ensureEmbeddingProviderAvailable();
  const provider = process.env.LLMWIKI_PROVIDER ?? DEFAULT_PROVIDER;

  if (provider === "anthropic") {
    const auth = resolveAnthropicAuthFromEnv();
    if (!auth.apiKey && !auth.authToken) {
      throw new ProviderUnavailableError(
        "anthropic",
        ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
        `Anthropic credentials are required for the "anthropic" provider.\n` +
          `  Set one of: export ANTHROPIC_API_KEY=<your-key> OR export ANTHROPIC_AUTH_TOKEN=<your-token>`,
      );
    }
    return;
  }

  const keyVar = PROVIDER_KEY_VARS[provider];
  if (keyVar === undefined) {
    const supported = Object.keys(PROVIDER_KEY_VARS);
    throw new UnknownProviderError(
      provider,
      supported,
      `Unknown provider "${provider}".\n` + `  Supported: ${supported.join(", ")}`,
    );
  }

  if (keyVar && !process.env[keyVar]) {
    throw new ProviderUnavailableError(
      provider,
      [keyVar],
      `${keyVar} environment variable is required for the "${provider}" provider.\n` +
        `  Set it with: export ${keyVar}=<your-key>`,
    );
  }
}
