/**
 * Shared Commander support for one-run LLM provider overrides.
 *
 * Environment selection remains the durable configuration mechanism. The CLI
 * flag only sets the current process before the provider guard and factory run.
 */

import type { Command } from "commander";

const DESCRIPTION =
  "Override LLMWIKI_PROVIDER for this run only (e.g. anthropic, codex-agent, openai, ollama)";

/** Options shape contributed by {@link addProviderOption}. */
export interface ProviderOption {
  provider?: string;
}

/** Add the standard provider override to an LLM-backed command. */
export function addProviderOption(command: Command): Command {
  return command.option("--provider <name>", DESCRIPTION);
}

/** Apply a non-empty provider override before guarding or constructing it. */
export function applyProviderOption(options: ProviderOption): void {
  const provider = options.provider?.trim();
  if (provider) process.env.LLMWIKI_PROVIDER = provider;
}
