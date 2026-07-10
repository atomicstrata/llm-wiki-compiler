/**
 * Claude settings fallback helpers.
 *
 * Provides a narrow, read-only integration with `~/.claude/settings.json`.
 * We only read the `env` object and only extract Anthropic-related values that
 * llmwiki can safely consume. Explicit process env values remain higher priority.
 *
 * The settings-file-READER half now lives in `./claude-settings-reader.ts`; this
 * module keeps the config-RESOLVER half (apiKey / authToken / baseURL precedence)
 * and re-exports {@link readClaudeSettingsEnv} so the public API is unchanged.
 */

import { normalize, readClaudeSettingsEnv, tryReadClaudeSettingsEnv } from "./claude-settings-reader.js";

export { readClaudeSettingsEnv } from "./claude-settings-reader.js";

interface AnthropicAuthConfig {
  apiKey?: string;
  authToken?: string;
}

function validateAnthropicBaseURL(value: string): string {
  const normalized = value.trim();
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("Must use http:// or https:// protocol.");
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Must be a valid http(s) URL.";
    throw new Error(`Invalid ANTHROPIC_BASE_URL: "${normalized}". ${message}`);
  }
  return normalized;
}

export function resolveAnthropicAuthFromEnv(env: NodeJS.ProcessEnv = process.env): AnthropicAuthConfig {
  const explicitApiKey = normalize(env.ANTHROPIC_API_KEY);
  if (explicitApiKey) return { apiKey: explicitApiKey };

  const explicitAuthToken = normalize(env.ANTHROPIC_AUTH_TOKEN);
  if (explicitAuthToken) return { authToken: explicitAuthToken };

  const fallback = readClaudeSettingsEnv(env);
  if (fallback?.ANTHROPIC_API_KEY) return { apiKey: fallback.ANTHROPIC_API_KEY };
  if (fallback?.ANTHROPIC_AUTH_TOKEN) return { authToken: fallback.ANTHROPIC_AUTH_TOKEN };
  return {};
}

export function resolveAnthropicModelFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicitModel = env.LLMWIKI_MODEL;
  if (explicitModel !== undefined) return explicitModel;
  return tryReadClaudeSettingsEnv(env)?.ANTHROPIC_MODEL;
}

export function resolveAnthropicBaseURLFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicitBaseURL = normalize(env.ANTHROPIC_BASE_URL);
  if (explicitBaseURL) return validateAnthropicBaseURL(explicitBaseURL);

  const fallbackBaseURL = tryReadClaudeSettingsEnv(env)?.ANTHROPIC_BASE_URL;
  if (!fallbackBaseURL) return undefined;
  return validateAnthropicBaseURL(fallbackBaseURL);
}
