/**
 * Shared constants for the llmwiki knowledge compiler.
 * Centralized config values to avoid magic numbers scattered across the codebase.
 */

/** Maximum source file size in characters before truncation. */
export const MAX_SOURCE_CHARS = 100_000;

/** Minimum source content length to ingest without a warning. */
export const MIN_SOURCE_CHARS = 50;

/**
 * Default character budget for the combined source content sent to the LLM
 * during page generation for a single concept (issue #39).
 *
 * Caps the per-prompt content at ~200,000 chars (~50k tokens). When two or
 * more sources contribute to the same concept and their combined raw size
 * exceeds this budget, each source's slice is proportionally truncated so
 * the prompt fits the model's context window. Without this cap, popular
 * concepts that appear in many overlapping documents reliably blow past
 * the LLM provider's context limit and the compile crashes.
 *
 * Override via the LLMWIKI_PROMPT_BUDGET_CHARS env var when running against
 * larger-context (raise) or smaller-context (lower) models.
 */
export const DEFAULT_PROMPT_BUDGET_CHARS = 200_000;

/** Env var that overrides DEFAULT_PROMPT_BUDGET_CHARS at runtime. */
export const PROMPT_BUDGET_ENV_VAR = "LLMWIKI_PROMPT_BUDGET_CHARS";

/** Number of most relevant wiki pages to load for query context. */
export const QUERY_PAGE_LIMIT = 5;

/** Maximum concurrent API calls during page generation. */
export const COMPILE_CONCURRENCY = 5;

/** API retry configuration. */
export const RETRY_COUNT = 3;
export const RETRY_BASE_MS = 1000;
export const RETRY_MULTIPLIER = 4;

/** Default provider when LLMWIKI_PROVIDER is not set. */
export const DEFAULT_PROVIDER = "anthropic";

/** Default model per provider. */
export const PROVIDER_MODELS: Record<string, string> = {
  anthropic: "claude-sonnet-4-6",
  "claude-agent": "claude-sonnet-4-6",
  openai: "gpt-4o",
  ollama: "llama3.1",
  minimax: "MiniMax-M2.7",
  copilot: "gpt-4o",
};

/** Default Ollama API base URL. */
export const OLLAMA_DEFAULT_HOST = "http://localhost:11434/v1";

/** GitHub Copilot API base URL (OpenAI-compatible, requires OAuth token). */
export const COPILOT_BASE_URL = "https://api.githubcopilot.com";

/**
 * Default request timeout for cloud OpenAI-compatible providers (10 minutes).
 * Matches the OpenAI SDK's own default; called out here so it's explicit.
 */
export const OPENAI_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Default request timeout for Ollama (30 minutes). Local models on modest
 * hardware can take well over the cloud-provider default for a single
 * compile-time completion. Configurable via LLMWIKI_REQUEST_TIMEOUT_MS or
 * OLLAMA_TIMEOUT_MS env vars.
 */
export const OLLAMA_DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/** Output paths relative to the project root for export artifacts. */
export const EXPORT_DIR = "dist/exports";

/** Directory names relative to the project root. */
export const SOURCES_DIR = "sources";
export const CONCEPTS_DIR = "wiki/concepts";
export const QUERIES_DIR = "wiki/queries";
export const LLMWIKI_DIR = ".llmwiki";
export const STATE_FILE = ".llmwiki/state.json";
export const LOCK_FILE = ".llmwiki/lock";
export const INDEX_FILE = "wiki/index.md";
export const MOC_FILE = "wiki/MOC.md";

/**
 * Append-only activity journal at the project root, per Karpathy's llm-wiki
 * gist: a chronological record of what happened and when (ingests, compiles,
 * queries, lint passes). Lives at the root rather than under wiki/ because it
 * spans project-level operations — ingest writes before any wiki/ exists.
 */
export const LOG_FILE = "log.md";

/** Max characters for a single log.md entry description before truncation. */
export const LOG_DESCRIPTION_MAX_CHARS = 200;

/**
 * Max number of page wikilinks listed in a single log.md entry detail line.
 * Beyond this the list is truncated with a "(+N more)" suffix so a large
 * compile doesn't write a wall of links into the journal.
 */
export const LOG_MAX_PAGE_LINKS = 20;
export const EMBEDDINGS_FILE = ".llmwiki/embeddings.json";
export const LAST_LINT_FILE = ".llmwiki/last-lint.json";

/** Supported image file extensions for vision-based ingest. */
export const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);

/** Supported transcript file extensions (content-sniff .txt separately). */
export const TRANSCRIPT_EXTENSIONS = new Set([".vtt", ".srt"]);

/** Max tokens for image-description completions. */
export const IMAGE_DESCRIBE_MAX_TOKENS = 2048;

/** Pending review candidates awaiting approval/rejection. */
export const CANDIDATES_DIR = ".llmwiki/candidates";

/** Rejected review candidates archived for audit (not deleted). */
export const CANDIDATES_ARCHIVE_DIR = ".llmwiki/candidates/archive";

/**
 * Per-source hashes already processed by `rules extract` (rule pipeline). Kept
 * separate from STATE_FILE so rule extraction and concept compilation advance
 * their change-detection cursors independently.
 */
export const RULE_STATE_FILE = ".llmwiki/rule-state.json";

/** Pending rule candidates (rule pipeline) awaiting approve/reject. */
export const RULE_CANDIDATES_DIR = ".llmwiki/rule-candidates";

/** Rejected rule candidates archived for audit (not deleted). */
export const RULE_CANDIDATES_ARCHIVE_DIR = ".llmwiki/rule-candidates/archive";

/** Number of most similar pages to return from embedding-based pre-filter. */
export const EMBEDDING_TOP_K = 15;

/** Number of chunk candidates to retain after the semantic-similarity step. */
export const CHUNK_TOP_K = 30;

/** Number of chunk candidates to keep after reranking. */
export const CHUNK_RERANK_KEEP = 12;

/** Target chunk size in characters; chunks try to land near this length. */
export const CHUNK_TARGET_CHARS = 800;

/** Hard upper bound on a single chunk's character length. */
export const CHUNK_MAX_CHARS = 1_400;

/** Minimum standalone chunk size; smaller trailing fragments are merged back. */
export const CHUNK_MIN_CHARS = 200;

/** Provenance metadata thresholds used by lint rules. */
export const LOW_CONFIDENCE_THRESHOLD = 0.5;
export const MAX_INFERRED_PARAGRAPHS_WITHOUT_CITATIONS = 2;

/** Embedding model to use per provider. */
export const EMBEDDING_MODELS: Record<string, string> = {
  anthropic: "voyage-3-lite",
  "claude-agent": "voyage-3-lite",
  openai: "text-embedding-3-small",
  ollama: "nomic-embed-text",
};

/** Per-provider default batch size for embedding requests (count-based). */
export const EMBED_BATCH_SIZES: Record<string, number> = {
  openai: 256,
  ollama: 64,
  anthropic: 128,
  "claude-agent": 128,
};

/** Batch size for providers not in EMBED_BATCH_SIZES. */
export const EMBED_BATCH_SIZE_FALLBACK = 64;

/** Upper clamp for LLMWIKI_EMBED_BATCH_SIZE, per provider (documented max inputs). */
export const EMBED_BATCH_CAPS: Record<string, number> = {
  openai: 2048,
  ollama: 512, // no documented cap; internal ceiling to bound request size/memory
  anthropic: 1000,
  "claude-agent": 1000,
};

/** Clamp ceiling for providers not in EMBED_BATCH_CAPS. */
export const EMBED_BATCH_CAP_FALLBACK = 512;

/** Env var: override the embedding batch size (positive integer, clamped to cap). */
export const ENV_EMBED_BATCH_SIZE = "LLMWIKI_EMBED_BATCH_SIZE";

/** Env var: when set, a failed embedding refresh exits non-zero (for CI). */
export const ENV_EMBED_STRICT = "LLMWIKI_EMBED_STRICT";
