/**
 * @file src/utils/embedding-provider.ts
 * @description Resolves which backend serves EMBEDDINGS, independently of the
 * chat provider (issue #154).
 *
 * `getProvider()` returns one object doing both jobs, which forces a project
 * using Claude Agent for generation to also use Voyage for vectors. Setting
 * LLMWIKI_EMBEDDING_PROVIDER splits them — e.g. Claude Agent for text and a
 * local vLLM instance over its OpenAI-compatible endpoint for embeddings.
 *
 * With the variable unset this module is a pass-through to `getProvider()`:
 * same object, same credentials handling, no store rebuild. Every rule below
 * applies ONLY to the explicit opt-in path, which is what keeps the default
 * path byte-for-byte unchanged.
 *
 * Misconfiguration is reported by {@link findEmbeddingProviderProblem}, which
 * `ensureProviderAvailable` (the provider guard) calls at every entry point
 * BEFORE any work starts. That matters: this module is otherwise only reached
 * from inside the embedding call itself, where a throw either aborts `query`
 * or is swallowed mid-compile — after a paid LLM pass, and repeatedly enough to
 * quarantine the affected pages. Validation belongs at the door, not there.
 */

import type { LLMProvider } from "./provider.js";
import { buildProvider, getActiveProviderName, getProvider } from "./provider.js";

/**
 * Providers that can actually serve embeddings. `minimax`, `copilot`, and
 * `orcarouter` override `embed()` to throw because their APIs expose no
 * embeddings endpoint, so naming one here would only defer a guaranteed failure
 * to compile time. Matches the EMBEDDING_MODELS / EMBED_BATCH_SIZES keys in
 * constants.ts.
 */
const EMBEDDING_CAPABLE_PROVIDERS: ReadonlySet<string> = new Set([
  "anthropic",
  "claude-agent",
  "openai",
  "ollama",
]);

/**
 * Env vars that satisfy each embedding provider's credential, and the variable
 * that marks its endpoint as self-hosted.
 *
 * Deliberately NOT `PROVIDER_KEY_VARS` from provider-guard.ts: that maps
 * anthropic to ANTHROPIC_API_KEY, which is the CHAT key. Anthropic and
 * claude-agent embeddings go to Voyage and need VOYAGE_API_KEY.
 *
 * `keyVars` is ordered most- to least-specific; any one being set satisfies the
 * check. `endpointVar` names the override that points at a self-hosted server —
 * a local vLLM instance ignores authentication, so requiring a key there would
 * break the very configuration this feature exists to support. `ollama` has no
 * key at all: its OpenAI-compatible endpoint never requires one.
 */
const EMBEDDING_CREDENTIALS: Record<string, { keyVars: readonly string[]; endpointVar: string | null }> = {
  anthropic: { keyVars: ["VOYAGE_API_KEY"], endpointVar: null },
  "claude-agent": { keyVars: ["VOYAGE_API_KEY"], endpointVar: null },
  openai: { keyVars: ["OPENAI_EMBEDDINGS_API_KEY", "OPENAI_API_KEY"], endpointVar: "OPENAI_EMBEDDINGS_BASE_URL" },
  ollama: { keyVars: [], endpointVar: null },
};

/**
 * The BACKEND each provider name actually embeds against — which is what a
 * stored vector's identity depends on, not the name the operator typed.
 *
 * `anthropic` and `claude-agent` both delegate to Voyage and produce
 * interchangeable vectors, so moving between them must NOT invalidate a store:
 * keying the fingerprint on the provider name alone would charge a full
 * re-embed of the wiki for a change that altered nothing.
 */
const EMBEDDING_BACKENDS: Record<string, string> = {
  anthropic: "voyage",
  "claude-agent": "voyage",
  openai: "openai",
  ollama: "ollama",
};

/**
 * Endpoint overrides per provider, most- to least-specific. These are part of
 * the embedding store's identity: two servers answering to the same model NAME
 * do not produce interchangeable vectors, so the endpoint has to travel with the
 * fingerprint — see `resolveEmbeddingFingerprint` in embeddings-store.ts.
 */
const EMBEDDING_ENDPOINT_VARS: Record<string, readonly string[]> = {
  anthropic: [], // Voyage — fixed endpoint, no override
  "claude-agent": [],
  openai: ["OPENAI_EMBEDDINGS_BASE_URL", "OPENAI_BASE_URL"],
  ollama: ["OLLAMA_EMBEDDINGS_HOST", "OLLAMA_HOST"],
};

/**
 * A misconfiguration of the embedding provider, in the shape the provider guard
 * needs to raise its typed error. `kind` distinguishes an unusable NAME from a
 * usable name with no CREDENTIAL, mirroring UnknownProviderError vs
 * ProviderUnavailableError.
 */
export interface EmbeddingProviderProblem {
  kind: "unknown" | "unavailable";
  provider: string;
  /** Env vars that would satisfy the check (empty for an unusable name). */
  missing: string[];
  /** Every name LLMWIKI_EMBEDDING_PROVIDER accepts. */
  supported: string[];
  message: string;
}

/** Read an env var, treating empty/whitespace as unset. */
function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

/**
 * Look up `key` on a plain object literal WITHOUT walking the prototype chain.
 * `EMBEDDING_*` are keyed by a name that can come straight from the environment,
 * and a bare index would resolve `constructor`/`toString` to a function typed as
 * the value type — which then travels into the store's model field, where
 * JSON.stringify drops it and leaves a store with no model at all.
 */
function ownValue<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/** The raw LLMWIKI_EMBEDDING_PROVIDER value, unvalidated. */
function explicitEmbeddingProviderName(): string | undefined {
  return readEnv("LLMWIKI_EMBEDDING_PROVIDER");
}

/** True when the operator explicitly named an embedding provider. */
export function isEmbeddingProviderExplicit(): boolean {
  return explicitEmbeddingProviderName() !== undefined;
}

/**
 * The provider name serving embeddings: the explicit override when set,
 * otherwise the active chat provider — which is what makes the default path
 * indistinguishable from today's behaviour.
 *
 * VALIDATES the explicit name, because callers use the result to index
 * per-provider tables. `getActiveProviderName` validates its own value the same
 * way; skipping it here let a typo fall through to the anthropic default and be
 * reported as "the index was built with a different model" — a confident,
 * wrong diagnosis of what is really a misspelled variable.
 */
export function getActiveEmbeddingProviderName(): string {
  const explicit = explicitEmbeddingProviderName();
  if (explicit === undefined) return getActiveProviderName();
  const problem = capabilityProblem(explicit);
  if (problem) throw new Error(problem.message);
  return explicit;
}

/** The backend `providerName` embeds against — see {@link EMBEDDING_BACKENDS}. */
export function resolveEmbeddingBackend(providerName: string): string {
  return ownValue(EMBEDDING_BACKENDS, providerName) ?? providerName;
}

/** The endpoint serving embeddings for `providerName`, or "" for a fixed one. */
export function resolveEmbeddingEndpoint(providerName: string): string {
  for (const name of ownValue(EMBEDDING_ENDPOINT_VARS, providerName) ?? []) {
    const value = readEnv(name);
    if (value) return value;
  }
  return "";
}

/**
 * True when the embedding configuration is steered away from what the chat
 * provider alone would imply — an explicit LLMWIKI_EMBEDDING_PROVIDER, or an
 * endpoint override for the effective provider.
 *
 * This is the condition under which a store's MODEL NAME stops being usable
 * evidence of how its vectors were produced, which is what
 * `storeMatchesActiveEmbedding` needs to know about a store that predates
 * fingerprints — see its docstring for why that distinction has to exist.
 */
export function hasEmbeddingConfigurationOverride(): boolean {
  if (isEmbeddingProviderExplicit()) return true;
  return resolveEmbeddingEndpoint(getActiveEmbeddingProviderName()) !== "";
}

/** Describe an embedding-incapable provider name, or null when it can serve. */
function capabilityProblem(name: string): EmbeddingProviderProblem | null {
  if (EMBEDDING_CAPABLE_PROVIDERS.has(name)) return null;
  const supported = [...EMBEDDING_CAPABLE_PROVIDERS];
  return {
    kind: "unknown",
    provider: name,
    missing: [],
    supported,
    message:
      `LLMWIKI_EMBEDDING_PROVIDER="${name}" cannot serve embeddings.\n` +
      `  Supported: ${supported.join(", ")}`,
  };
}

/**
 * Describe a missing credential for an embedding-capable provider, or null.
 *
 * Skipped when the provider's endpoint override is set: that names a self-hosted
 * server which ignores auth. Applies only to the explicit path — on the default
 * path a missing key still degrades to lexical ranking, as documented.
 */
function credentialProblem(name: string): EmbeddingProviderProblem | null {
  const credential = ownValue(EMBEDDING_CREDENTIALS, name);
  if (!credential || credential.keyVars.length === 0) return null;
  if (credential.endpointVar && readEnv(credential.endpointVar)) return null;
  if (credential.keyVars.some((keyVar) => readEnv(keyVar))) return null;
  const [preferred, ...rest] = credential.keyVars;
  const alternatives = rest.length > 0 ? ` (or ${rest.join(", ")})` : "";
  return {
    kind: "unavailable",
    provider: name,
    missing: [...credential.keyVars],
    supported: [...EMBEDDING_CAPABLE_PROVIDERS],
    message:
      `${preferred}${alternatives} is required for LLMWIKI_EMBEDDING_PROVIDER="${name}".\n` +
      `  Set it with: export ${preferred}=<your-key>` +
      (credential.endpointVar
        ? `\n  Or set ${credential.endpointVar} if you are using a self-hosted endpoint that needs no key.`
        : ""),
  };
}

/**
 * The embedding provider's configuration problem, or null when it is usable.
 *
 * Always null when LLMWIKI_EMBEDDING_PROVIDER is unset: the default path keeps
 * its soft handling of a missing embedding key (degrade to lexical ranking), and
 * promoting that to a hard failure would break every project relying on it.
 */
export function findEmbeddingProviderProblem(): EmbeddingProviderProblem | null {
  const name = explicitEmbeddingProviderName();
  if (name === undefined) return null;
  return capabilityProblem(name) ?? credentialProblem(name);
}

/**
 * The provider serving embeddings. Returns `getProvider()` unchanged when
 * LLMWIKI_EMBEDDING_PROVIDER is unset, so the default path keeps today's
 * behaviour exactly, including its soft handling of a missing embedding key.
 *
 * Still validates rather than trusting the guard to have run: this is reachable
 * from the SDK and from tests without going through a CLI entry point.
 */
export function getEmbeddingProvider(): LLMProvider {
  if (!isEmbeddingProviderExplicit()) return getProvider();
  const problem = findEmbeddingProviderProblem();
  if (problem) throw new Error(problem.message);
  // buildProvider also resolves a chat model (LLMWIKI_MODEL) onto the returned
  // provider, but that field goes unused here — only embed()/embedBatch() are
  // ever called on the provider this function returns.
  return buildProvider(getActiveEmbeddingProviderName());
}
