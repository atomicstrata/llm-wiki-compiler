/**
 * Operator-supplied extensions for OpenAI-compatible chat request bodies.
 * Keeps vendor dialects out of model-name detection while protecting the fields
 * the compiler owns. Extensions are shallow, endpoint-specific, and opt-in.
 */
import { OpenAIRequestConfigError } from "./openai-request.js";

const EXTRA_BODY_ENV = "LLMWIKI_OPENAI_EXTRA_BODY";
const OWNED_FIELDS = new Set([
  "model", "messages", "tools", "tool_choice", "stream",
  "max_tokens", "max_completion_tokens", "reasoning_effort",
]);

/** Validate locally; never retry a typo or print the potentially sensitive JSON. */
export function extraBodyParams(): Record<string, unknown> {
  const raw = process.env[EXTRA_BODY_ENV]?.trim();
  if (!raw) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch {
    throw new OpenAIRequestConfigError(`${EXTRA_BODY_ENV} must be a JSON object.`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new OpenAIRequestConfigError(`${EXTRA_BODY_ENV} must be a JSON object.`);
  }
  if (Object.keys(parsed).some((key) => OWNED_FIELDS.has(key))) {
    throw new OpenAIRequestConfigError(`${EXTRA_BODY_ENV} cannot override compiler-owned fields: ${[...OWNED_FIELDS].join(", ")}.`);
  }
  return parsed as Record<string, unknown>;
}
