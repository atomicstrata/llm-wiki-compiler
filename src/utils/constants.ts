/**
 * Shared constants for the llmwiki knowledge compiler.
 * Centralized config values to avoid magic numbers scattered across the codebase.
 */

/** Maximum source file size in characters before truncation. */
export const MAX_SOURCE_CHARS = 100_000;

/**
 * Absolute body-size guardrail for COMPILE-GENERATED page writes (`origin:"compile"`).
 *
 * The mandatory trust floor's resource-limit caps a page body at
 * {@link MAX_SOURCE_CHARS} — a bound sized for a SINGLE ingest source. But compile
 * concept pages are MERGED across many sources, so the most-referenced (and thus
 * most important) concepts accumulate the most content. Holding them to the
 * single-source cap would SILENTLY DROP exactly the pages that matter most once a
 * legitimate merged page crosses 100k chars.
 *
 * This is a distinct, larger absolute guardrail — 5× {@link MAX_SOURCE_CHARS} —
 * because merged concept pages aggregate multiple sources, while still keeping a
 * real ceiling so a runaway/adversarial body is SKIPPED (H2) with a prominent
 * warning rather than written unbounded. It applies ONLY to compile-origin writes;
 * every other origin (staging/promote/review-approve) keeps {@link MAX_SOURCE_CHARS}.
 */
export const GENERATED_PAGE_MAX_CHARS = 5 * MAX_SOURCE_CHARS;

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

/** Default maximum concurrent LLM calls during compile (extraction + page generation). */
export const COMPILE_CONCURRENCY = 5;

/** Upper clamp for LLMWIKI_COMPILE_CONCURRENCY / --concurrency, to bound provider rate-limit pressure. */
export const COMPILE_CONCURRENCY_MAX = 50;

/** Env var: override the compile concurrency (positive integer, clamped to COMPILE_CONCURRENCY_MAX). */
export const ENV_COMPILE_CONCURRENCY = "LLMWIKI_COMPILE_CONCURRENCY";

/** API retry configuration. */
export const RETRY_COUNT = 3;
export const RETRY_BASE_MS = 1000;
export const RETRY_MULTIPLIER = 4;

/** Default provider when LLMWIKI_PROVIDER is not set. */
export const DEFAULT_PROVIDER = "anthropic";

/** Provider names accepted by LLMWIKI_PROVIDER, including aliases. */
export const SUPPORTED_PROVIDER_INPUTS = [
  "anthropic",
  "claude-agent",
  "openai",
  "ollama",
  "minimax",
  "copilot",
  "atlascloud",
  "atlas-cloud",
  "atlas",
] as const;

/** Normalize accepted LLMWIKI_PROVIDER aliases to provider implementation names. */
export function normalizeProviderName(providerName: string): string {
  if (providerName === "atlas-cloud" || providerName === "atlas") {
    return "atlascloud";
  }
  return providerName;
}

/** Default model per provider. */
export const PROVIDER_MODELS: Record<string, string> = {
  anthropic: "claude-sonnet-4-6",
  "claude-agent": "claude-sonnet-4-6",
  openai: "gpt-4o",
  ollama: "llama3.1",
  minimax: "MiniMax-M2.7",
  copilot: "gpt-4o",
  // Atlas Cloud's catalogue marks tool support per model in `supported_features`,
  // and `qwen/qwen3.5-flash` carries no such entry while 35 of its 136 models
  // advertise `["json_mode","structured_outputs","tools"]`. Compile's extraction
  // pass goes through `toolCall` with `tool_choice: "required"`, so a default
  // that cannot return tool calls fails on the first request rather than
  // degrading — the provider would look installed and not work. This is the
  // smallest catalogue model that does advertise tools, keeping the cheap-and-fast
  // intent of the original default.
  atlascloud: "qwen/qwen3.5-35b-a3b",
};

/** Default Ollama API base URL. */
export const OLLAMA_DEFAULT_HOST = "http://localhost:11434/v1";

/** GitHub Copilot API base URL (OpenAI-compatible, requires OAuth token). */
export const COPILOT_BASE_URL = "https://api.githubcopilot.com";

/** Atlas Cloud OpenAI-compatible API base URL. */
export const ATLASCLOUD_BASE_URL = "https://api.atlascloud.ai/v1";

/** Atlas Cloud API key env vars, checked in order. */
export const ATLASCLOUD_API_KEY_ENV_VARS = ["ATLASCLOUD_API_KEY", "ATLAS_CLOUD_API_KEY"] as const;

/** Atlas Cloud base URL env vars, checked in order. */
export const ATLASCLOUD_BASE_URL_ENV_VARS = ["ATLASCLOUD_BASE_URL", "ATLAS_CLOUD_BASE_URL"] as const;

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

/**
 * The reserved subtree workflow-run markdown PROJECTIONS must live under. A
 * `projectionFile` is confined here at profile LOAD so it can never target an
 * authored entity page; no entity `directory` may overlap this subtree either.
 */
export const WORKFLOW_PROJECTION_DIR = "wiki/outputs/workflows";
export const LLMWIKI_DIR = ".llmwiki";
export const PROFILE_FILE = ".llmwiki/profile.json";
export const STATE_FILE = ".llmwiki/state.json";
export const LOCK_FILE = ".llmwiki/lock";

/**
 * Resource cap on the lock leaf (`.llmwiki/lock`). The leaf holds ONLY a decimal
 * `process.pid` (a handful of bytes), so 64 bytes is far above any legitimate
 * content yet bounds the read. `.llmwiki` is local/sync-controllable, so a planted
 * symlinked or oversized leaf would otherwise let {@link isLockStale}'s read slurp
 * an unbounded symlink target into memory before parsing — a PID-parse oracle + a
 * local DoS. The hardened reader caps the read at this bound and treats an oversized
 * (or non-regular / symlinked) leaf as unreadable → stale.
 *
 * 256 bytes accommodates the small JSON owner record `{pid, startTime}` (the
 * PID-reuse-safe liveness identity) — a process start-time string plus a PID —
 * while still being far below any abusive size. A legacy bare-PID leaf is far smaller.
 */
export const MAX_LOCK_FILE_BYTES = 256;

/**
 * Resource cap on a single mutation target read into the intent journal's
 * pre-state. {@link recordPreState} copies a target's prior bytes into the
 * on-disk journal so a crash can revert it, and {@link persist} RE-serializes the
 * whole accumulated batch on EVERY subsequent `recordPreState` call. So a huge
 * in-root planted target is O(N²)-amplified into `.llmwiki/journal/` — an OOM /
 * disk-blowup DoS. This cap exists solely to bound that: a target above it is
 * reported `unavailable` by the no-follow reader and the mutation is REFUSED
 * (never silently coerced to `absent`, which would make revert DELETE it).
 *
 * 16 MiB is far above any legitimate target — a compile page body is capped at
 * {@link GENERATED_PAGE_MAX_CHARS} (~2 MB UTF-8 worst case) and an artifact body
 * at {@link MAX_WORKFLOW_SUBMIT_FILE_BYTES} (1 MiB) — so no real page/artifact
 * write is refused by it; it is a pure anti-blowup backstop.
 */
export const JOURNAL_PRESTATE_MAX_BYTES = 16 * 1024 * 1024; // 16 MiB
/**
 * Durable write-ahead list of qualified page-ids whose embeddings still need a
 * refresh. Recorded BEFORE an embeddings update is attempted and cleared only
 * AFTER it succeeds, so a swallowed/crashed refresh leaves a retry list that the
 * next non-review compile drains. Lives under `.llmwiki/` (never emitted into
 * `wiki/` output) so default goldens stay byte-identical. Mirrors {@link LOCK_FILE}.
 */
export const PENDING_EMBEDDINGS_FILE = ".llmwiki/pending-embeddings.json";

/**
 * Resource cap on the pending-embeddings marker file. `.llmwiki` is
 * local/sync-controllable (a synced checkout or a teammate can replace the
 * marker), and {@link loadPendingEmbeddings} runs on EVERY non-review compile,
 * slurping the whole file before `JSON.parse`. A multi-GB marker (or a `/dev/zero`
 * symlink target) would exhaust memory/latency before any validation runs, a local
 * DoS on each compile. 256 KiB is far above any legitimate id list (thousands of
 * ~40-char qualified ids fit comfortably) yet bounds the read. A bloated marker is
 * treated as corrupt — fail OPEN (return `[]`) so a bad marker never breaks compile.
 */
export const MAX_PENDING_EMBEDDINGS_BYTES = 256 * 1024; // 256 KiB

/**
 * Maximum number of pending page-ids honored from the marker. The marker is
 * attacker/sync-controllable, so a forged file could list an unbounded id set that
 * would fan out into the embeddings refresh. A few thousand distinct pages is well
 * beyond any realistic single-project wiki; entries past this cap are dropped.
 */
export const MAX_PENDING_EMBEDDING_IDS = 5000;

/**
 * Maximum number of FAILED embedding-refresh attempts a single pending page-id is
 * retried before it is QUARANTINED (dropped from the marker with a visible warning).
 *
 * Bounds poison-id retries and provider cost: a page-id that fails for a
 * NON-transient reason (a provider 400 that isn't request-too-large, an integrity
 * error, or one that is permanently ineligible) would otherwise stay pending
 * forever — re-attempted (and re-billed) on EVERY compile, and able to wedge the
 * whole all-or-nothing batch it shares. After this many failures the lifecycle
 * ages the id out so a perpetually-failing id can neither loop nor block healthy
 * co-pending ids. 5 leaves room to ride out a genuine transient outage.
 */
export const MAX_PENDING_EMBEDDING_ATTEMPTS = 5;

/**
 * Resource cap on a single workflow run record file under
 * `.llmwiki/workflows/runs/<runId>.json`. Run state is local/sync-controllable
 * (a synced checkout or a teammate can replace a run file), and the read path
 * slurps the whole file before `JSON.parse`. A multi-GB record (or a `/dev/zero`
 * symlink target) would exhaust memory/latency before any validation runs, a
 * local DoS. 256 KiB is far above any legitimate run record (stage logs and
 * inputs/outputs for a single run) yet bounds the read; an oversize record is
 * reported as `unavailable` rather than read. Mirrors
 * {@link MAX_PENDING_EMBEDDINGS_BYTES}.
 */
export const MAX_WORKFLOW_RUN_BYTES = 256 * 1024; // 256 KiB

/**
 * A generous per-run cap on the in-record event log. Appending past this fails
 * closed (an audit event is never silently dropped) rather than letting the
 * record grow unbounded. {@link MAX_WORKFLOW_RUN_BYTES} remains the hard byte
 * backstop; this is the friendlier, count-based guard hit first in practice.
 */
export const MAX_WORKFLOW_RUN_EVENTS = 1000;

/**
 * Cap on the serialized size of a run's caller-supplied `inputs` block, enforced
 * on `startWorkflow` BEFORE the record is built. `inputs` is the one run field a
 * caller fully controls, so an oversized payload could otherwise build a record
 * that writes fine yet trips {@link MAX_WORKFLOW_RUN_BYTES} on read forever
 * (unreadable). Bounding `inputs` well under the whole-record cap keeps room for
 * the run's own fields, so a within-cap `inputs` cannot push the record over the
 * read ceiling. 64 KiB is far above any realistic run-input payload.
 */
export const MAX_WORKFLOW_INPUTS_BYTES = 64 * 1024; // 64 KiB

/**
 * Cap on the RAW byte size of a file passed to `workflow submit`
 * (`--body-file`/`--evidence-file`/`--output-file`), enforced by `stat` BEFORE the
 * file is slurped into memory. Without it a 1 GB file would be `readFile`d whole
 * before any downstream check — a memory DoS. This is purely an anti-slurp bound;
 * the page BODY's own content limit is enforced downstream by the page-write
 * resource cap. 1 MiB comfortably covers a legitimate page body
 * ({@link GENERATED_PAGE_MAX_CHARS}) plus frontmatter and any evidence/output JSON.
 */
export const MAX_WORKFLOW_SUBMIT_FILE_BYTES = 1024 * 1024; // 1 MiB

/**
 * Maximum nesting depth permitted in a caller-supplied workflow `inputs` object,
 * enforced BEFORE the payload is canonicalized/serialized on every input surface
 * (CLI `--input-json`, MCP `inputs`). A deeply-nested object is cheap to express
 * yet drives `JSON.stringify`/canonicalize into deep recursion that can overflow
 * the stack — a crash-class DoS reachable before any byte cap is checked. 8 levels
 * is far beyond any realistic typed-input payload (whose schema is one level of
 * scalar/array fields) yet bounds the recursion. Excess nesting FAILS CLOSED.
 */
export const MAX_WORKFLOW_INPUT_DEPTH = 8;

/**
 * Maximum character length of a SINGLE string-valued workflow action input field
 * (a `string` or `entityRef`), enforced per-field by `validateActionInputs`. The
 * whole-object {@link MAX_WORKFLOW_INPUTS_BYTES} backstop bounds the aggregate, but
 * a per-field cap rejects one runaway string with a precise error and bounds the
 * cost of validating/echoing it. 64k chars is far above any realistic field value.
 */
export const MAX_WORKFLOW_INPUT_STRING_CHARS = 64 * 1024; // 64k chars

/**
 * Maximum number of items in a `string[]` workflow action input field, enforced
 * per-field by `validateActionInputs`. Without it a single array field accepts an
 * unbounded element count (each then size-checked against
 * {@link MAX_WORKFLOW_INPUT_STRING_CHARS}), materialized in full for non-`start`
 * ops that have no downstream byte cap. 1000 items is far above any realistic
 * typed list yet bounds the per-field surface. Excess items FAIL CLOSED.
 */
export const MAX_WORKFLOW_INPUT_ARRAY_ITEMS = 1000;

/**
 * Cap on the character length of a free-form actor LABEL recorded on a workflow
 * event (gate approve / stage submit). The label is caller-controlled and lands
 * verbatim on the audit event, so an unbounded label could bloat the record
 * toward {@link MAX_WORKFLOW_RUN_BYTES}. A username/agent-id fits comfortably.
 */
export const MAX_WORKFLOW_LABEL_CHARS = 256;

/**
 * Cap on the character length of the free-form `detail` reason recorded on a
 * `run-failed` event by `failWorkflow`. Caller-controlled and recorded verbatim,
 * so it is bounded for the same reason as {@link MAX_WORKFLOW_LABEL_CHARS}.
 */
export const MAX_WORKFLOW_DETAIL_CHARS = 2048;

/**
 * Bounded number of re-mint attempts when a freshly-minted run id collides with
 * an existing run on `startWorkflow`'s no-clobber create. With
 * {@link RUN_ID_RANDOM_BYTES} of entropy a single collision is already
 * astronomically unlikely; this bounds the retry loop so a pathological
 * environment cannot spin forever, surfacing a typed error instead.
 */
export const MAX_MINT_ATTEMPTS = 5;

/**
 * Global cap on the number of ACTIVE (non-terminal) workflow runs a project may
 * hold at once, enforced by `startWorkflow` BEFORE minting (H5). Without it a remote
 * MCP client (staged-write) could mint unbounded `runs/<id>.json` files —
 * disk/inode exhaustion plus a `status` that slows linearly. A terminal
 * (completed/cancelled/failed) run does NOT count toward this cap, so retiring runs
 * frees quota. 100 concurrent in-flight runs is far above any legitimate single-
 * project workload yet bounds the active-run surface.
 */
export const MAX_ACTIVE_WORKFLOW_RUNS = 100;

/**
 * Global cap on the TOTAL number of workflow run FILES (active + terminal) a project
 * may hold, enforced by `startWorkflow` BEFORE minting (H5). The active-run cap alone
 * is insufficient: an agent that loops start+cancel leaves unbounded TERMINAL run
 * files behind (disk/inode exhaustion) while staying under the active cap. Bounding
 * the total run-file count closes that. 1000 is far above any legitimate project's
 * accumulated run history yet bounds the on-disk surface; an operator who wants more
 * must prune retired runs. Strictly greater than {@link MAX_ACTIVE_WORKFLOW_RUNS}.
 */
export const MAX_TOTAL_WORKFLOW_RUNS = 1000;

/**
 * Resource cap on the local `.llmwiki/config.json` consulted for workflow-action
 * authority grants. The file is local/sync-controllable (a synced checkout or a
 * teammate can replace it) and the read path slurps it before `JSON.parse`, so a
 * `/dev/zero`-backed symlink target or a multi-GB file would exhaust memory before
 * any validation runs — a local DoS. 64 KiB is far above any legitimate config
 * (a handful of per-surface grants plus an enabled-gate list) yet bounds the read;
 * an oversize config FAILS CLOSED to `read-only`, never a write capability.
 */
export const MAX_LOCAL_CONFIG_BYTES = 64 * 1024; // 64 KiB

export const INDEX_FILE = "wiki/index.md";
export const MOC_FILE = "wiki/MOC.md";

/**
 * The typed relation graph directory and its append-only store. Lives under
 * `wiki/` alongside the compiled pages. A DEFAULT profile declares no relations
 * and never creates `wiki/graph/`, so its absence is the "no relations" state —
 * keeping default output and parity unchanged.
 */
export const WIKI_GRAPH_DIR = "wiki/graph";
export const RELATIONS_FILE = "wiki/graph/relations.jsonl";

/**
 * The append-only, hash-chained EVENT STORE and its sealed head anchor. The
 * store lives in the SAME confined `wiki/graph/` dir as the relation store; the
 * head anchor (the digest of the last event) lives under the private `.llmwiki/`
 * dir so truncation/rewrite of the log can be detected against a sealed value.
 * A DEFAULT profile performs no lifecycle/relation mutations, so it never writes
 * either file — its absence is the "no events" state, keeping parity unchanged.
 */
export const EVENTS_FILE = "wiki/graph/events.jsonl";
export const EVENTS_HEAD_FILE = ".llmwiki/events.head";

/**
 * Resource cap on the relation store file. The store is attacker/sync-controllable
 * (a teammate or a synced checkout can replace it), and the reader slurps the whole
 * file before any header/checksum validation. A multi-GB file or a giant single
 * line would exhaust memory before the integrity check runs, so the reader STATs
 * the file first and FAILS CLOSED above this bound — mirroring the page path's
 * {@link MAX_SOURCE_CHARS} resource cap, scaled up for a whole-graph aggregate.
 */
export const MAX_RELATION_STORE_BYTES = 64 * 1024 * 1024;

/**
 * Resource cap on a SINGLE relation record's serialized form on the write path.
 * Bounds attacker-controlled attribute/evidence size before append so one record
 * cannot grow unbounded (and so the per-store cap cannot be reached by one line).
 */
export const MAX_RELATION_RECORD_BYTES = MAX_SOURCE_CHARS;

/**
 * Resource cap on the event store file. Mirrors {@link MAX_RELATION_STORE_BYTES}:
 * the same read-side cap that {@link readConfinedGraphStore} enforces on
 * `events.jsonl` is now also enforced on the WRITE path so the log can never be
 * driven past the read ceiling into an unreadable-yet-appendable (bricked) state.
 *
 * NOTE: rotation/archival of an exhausted event log is a documented future item —
 * the append path fails closed with {@link EventStoreFullError} when this ceiling
 * is reached, and no automatic rotation is performed.
 */
export const MAX_EVENT_STORE_BYTES = MAX_RELATION_STORE_BYTES;

/**
 * Resource cap on a SINGLE event record's serialized form on the write path.
 * Bounds attacker/caller-controlled payload size before append so one record
 * cannot grow unbounded (and so the per-store cap cannot be reached by one line).
 * Mirrors {@link MAX_RELATION_RECORD_BYTES} for consistent behavior across stores.
 */
export const MAX_EVENT_RECORD_BYTES = MAX_RELATION_RECORD_BYTES;

/**
 * Resource cap on the sealed head-anchor file (`.llmwiki/events.head`). A valid
 * sealed digest is a 64-character SHA-256 hex string; 4 KiB is extremely generous.
 * An attacker/synced teammate can plant a multi-MB `.llmwiki/events.head` and the
 * read would previously slurp it fully before the string compare — this cap closes
 * that DoS gap. A bloated head is treated as corrupt (fail closed).
 */
export const MAX_EVENT_HEAD_BYTES = 4096;

/**
 * Resource cap on `.llmwiki/profile.json`. A profile is a small JSON document;
 * 1 MiB is extremely generous. Without this cap, a `/dev/zero`-backed or multi-GB
 * symlink target would be read fully before `JSON.parse`, a local DoS. A bloated
 * profile is treated as a load error (fail closed).
 */
export const MAX_PROFILE_BYTES = 1024 * 1024; // 1 MiB

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

/** Env var: when set to any non-empty value, enables verbose progress output. */
export const ENV_VERBOSE = "LLMWIKI_VERBOSE";

/**
 * Resource cap on the embedding store file. Mirrors {@link MAX_RELATION_STORE_BYTES}:
 * the same fstat-based cap that the reader enforces before the whole-file parse is
 * also enforced on the write path so the store can never grow past the read ceiling
 * into an unreadable-yet-writable (bricked) state.
 */
export const MAX_EMBEDDING_STORE_BYTES = 64 * 1024 * 1024; // 64 MiB

/**
 * Maximum number of entries (pages + chunks) allowed in a single embedding store.
 * Guards against unbounded store growth from adversarial or runaway input.
 */
export const MAX_EMBEDDING_ENTRIES = 100_000;

/**
 * Maximum character length for per-record string fields (slug, title, summary, chunk
 * text). An over-long field is rejected on write so one large record cannot drive
 * the store toward the byte cap or pollute search ranking.
 */
export const MAX_EMBEDDING_FIELD_CHARS = MAX_SOURCE_CHARS;
