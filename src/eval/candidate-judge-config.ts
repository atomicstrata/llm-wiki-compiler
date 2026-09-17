/**
 * Candidate verdict cache namespace for the configured judge. Only behavior
 * settings enter the digest, never API keys. Agent runtimes have opaque external
 * configuration, so their candidate results are deliberately per-run only.
 */
import { randomUUID } from "node:crypto";
import { getActiveProviderName, resolveActiveModelId } from "../utils/provider.js";
import { resolveAnthropicBaseURLFromEnv } from "../utils/claude-settings.js";
import { evaluationHash } from "./candidate-evidence.js";

/** Fingerprint known endpoint/request overrides without retaining their values. */
export function candidateJudgeConfig(): { namespace: string; model: string; persist: boolean } {
  const provider = getActiveProviderName();
  const model = resolveActiveModelId();
  const overrides = ["OPENAI_BASE_URL", "OLLAMA_HOST", "ATLASCLOUD_BASE_URL", "ATLAS_CLOUD_BASE_URL",
    "LLMWIKI_OPENAI_TOKEN_PARAM", "LLMWIKI_OPENAI_REASONING_EFFORT", "LLMWIKI_OPENAI_EXTRA_BODY"]
    .map(name => [name, process.env[name] ?? null]);
  const endpoint = provider === "anthropic" ? resolveAnthropicBaseURLFromEnv() : undefined;
  const opaqueConfig = provider.endsWith("-agent") ? randomUUID() : undefined;
  return { model, persist: !opaqueConfig,
    namespace: evaluationHash(JSON.stringify(["candidates-v1", provider, model, endpoint, overrides, opaqueConfig])) };
}
