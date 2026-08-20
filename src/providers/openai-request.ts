/**
 * Request-shape adaptation for OpenAI-compatible chat completions.
 *
 * The Chat Completions body is not uniform across models any more. Reasoning
 * models (the o-series and the GPT-5 family) reject `max_tokens` outright and
 * require `max_completion_tokens`; the OpenAI SDK's own types have carried
 * `max_tokens` as deprecated since 6.x. Several of those models also reject a
 * request that carries function tools without `reasoning_effort`.
 *
 * Both facts are properties of the model, not of llmwiki, so this module keeps
 * them in one place rather than spreading conditionals across the three call
 * sites in the provider. Model-id prefixes cover models served directly by
 * OpenAI; the env overrides exist because an OpenAI-compatible gateway can
 * expose any of them under an id this module has never seen.
 *
 * Defaults reproduce the previous request byte-for-byte for every model that
 * does not match a prefix.
 */

import type OpenAI from "openai";

/** Env override for the token-limit parameter, when prefix detection cannot see it. */
const TOKEN_PARAM_ENV = "LLMWIKI_OPENAI_TOKEN_PARAM";

/** Env slot carrying `reasoning_effort` for models that demand one. */
const REASONING_EFFORT_ENV = "LLMWIKI_OPENAI_REASONING_EFFORT";

/** The two spellings of the token limit, oldest first. */
const TOKEN_PARAMS = ["max_tokens", "max_completion_tokens"] as const;

type TokenParam = (typeof TOKEN_PARAMS)[number];

/**
 * Model-id prefixes served by OpenAI that reject `max_tokens`.
 *
 * Matched case-insensitively against the start of the id. Gateways that
 * re-badge these models are covered by TOKEN_PARAM_ENV instead — guessing from
 * an arbitrary vendor id would misfire in both directions.
 */
const MAX_COMPLETION_TOKEN_PREFIXES = ["o1", "o3", "o4", "gpt-5"];

/**
 * Accepted `reasoning_effort` values, mirroring the SDK's `ReasoningEffort`.
 * Duplicated as a runtime set because the SDK exports it as a type only, and
 * an unchecked env value would surface as an opaque 400 from the API.
 */
const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;

/** Raised when an env override carries a value the API would reject. */
export class OpenAIRequestConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenAIRequestConfigError";
  }
}

/**
 * The token-limit field for `model`, as a spreadable fragment of the request
 * body. The env override wins over prefix detection so a gateway id can be
 * corrected without a release.
 */
export function tokenLimitParams(
  model: string,
  maxTokens: number,
): Pick<OpenAI.ChatCompletionCreateParams, "max_tokens" | "max_completion_tokens"> {
  return resolveTokenParam(model) === "max_completion_tokens"
    ? { max_completion_tokens: maxTokens }
    : { max_tokens: maxTokens };
}

/**
 * The `reasoning_effort` fragment, or nothing when unconfigured — so a request
 * for a model that has no opinion on reasoning is unchanged.
 */
export function reasoningParams(): Pick<OpenAI.ChatCompletionCreateParams, "reasoning_effort"> | object {
  const raw = process.env[REASONING_EFFORT_ENV]?.trim().toLowerCase();
  if (!raw) return {};
  if (!(REASONING_EFFORTS as readonly string[]).includes(raw)) {
    throw new OpenAIRequestConfigError(
      `${REASONING_EFFORT_ENV} must be one of ${REASONING_EFFORTS.join(", ")} (got "${raw}")`,
    );
  }
  return { reasoning_effort: raw as OpenAI.ReasoningEffort };
}

/** Resolve the token parameter from the env override, else from the model id. */
function resolveTokenParam(model: string): TokenParam {
  const override = process.env[TOKEN_PARAM_ENV]?.trim();
  if (override) return readTokenParamOverride(override);
  const id = model.toLowerCase();
  return MAX_COMPLETION_TOKEN_PREFIXES.some(prefix => id.startsWith(prefix))
    ? "max_completion_tokens"
    : "max_tokens";
}

/** Validate the env override, naming both spellings so a typo is obvious. */
function readTokenParamOverride(value: string): TokenParam {
  if ((TOKEN_PARAMS as readonly string[]).includes(value)) return value as TokenParam;
  throw new OpenAIRequestConfigError(
    `${TOKEN_PARAM_ENV} must be one of ${TOKEN_PARAMS.join(", ")} (got "${value}")`,
  );
}
