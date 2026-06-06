# llmwiki

Compile raw sources into an interlinked markdown wiki.

Inspired by Karpathy's [LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) pattern: instead of re-discovering knowledge at query time, compile it once into a persistent, browsable artifact that compounds over time.

![llmwiki demo](docs/images/demo.gif)

## What you get

- **Compiled wiki, not chunks.** A two-phase LLM pipeline turns raw sources into typed pages (`concept`, `entity`, `comparison`, `overview`) with paragraph- and claim-level citations back to source line ranges.
- **Hybrid retrieval.** Semantic chunk embeddings (incremental, content-hash-aware) narrow hundreds of pages to a small top-K; BM25 reranking and wikilink-graph expansion build the final evidence pack.
- **Local web viewer.** `llmwiki view` opens a read-only browser UI with sidebar navigation, search, a force-directed graph, and provenance/citation chips per page.
- **Eval harness.** `llmwiki eval` measures health score (0–100), citation coverage and precision, optional LLM-as-judge support scoring, regression deltas, and CI-gateable thresholds.
- **MCP server.** `llmwiki serve` exposes the full pipeline to Claude Desktop, Cursor, Claude Code, and any MCP-compatible agent — including `get_context_pack` for budgeted, citation-aware evidence packs.
- **Bridge to runtime memory.** `llmwiki export --target json --project-id <id>` produces a typed envelope that [`@atomicmemory/llmwiki`](https://github.com/atomicstrata/atomicmemory/tree/main/packages/llmwiki) imports as one verbatim Atomic Memory record per page, preserving all advisory metadata.
- **Provider-portable.** Anthropic, Claude Agent SDK (local Claude Code login, no API key), OpenAI-compatible (incl. local llama.cpp / vLLM), Ollama, GitHub Copilot.

## Who this is for

- **AI researchers and engineers** building durable knowledge from papers, docs, and notes
- **Technical writers** compiling scattered sources into a structured, interlinked reference
- **Open-source maintainers** turning READMEs, ADRs, and design docs into a navigable knowledge base
- **Anyone with too many bookmarks** who wants a wiki instead of a graveyard of tabs

## Quick start

```bash
npm install -g llm-wiki-compiler
export ANTHROPIC_API_KEY=sk-...
# Or use ANTHROPIC_AUTH_TOKEN if your Anthropic-compatible gateway expects it.
# Or use a different provider:
# export LLMWIKI_PROVIDER=openai
# export OPENAI_API_KEY=sk-...

llmwiki quickstart ./notes.md
llmwiki query "what is X?"
llmwiki view --open
```

`llmwiki quickstart ./notes.md` ingests one supported source, compiles the wiki, and opens the local viewer when pages are ready. Use `--no-open` to stop after compile, `--review` to queue candidates instead of writing pages, or `--json` for an agent-friendly envelope. If you're inside an existing project and unsure what to do next, run `llmwiki next`.


<br>

---

<br>


<details>
<summary><span style="font-size: 1.4em;"><strong>Configuration — click to expand</strong></span></summary>


llmwiki configures providers via environment variables. The default provider is Anthropic.

Configuration precedence for Anthropic values:

1. Shell env / local `.env`
2. Claude Code settings fallback (`~/.claude/settings.json` → `env` block)
3. Built-in provider defaults (where applicable)

- `LLMWIKI_PROVIDER`: The provider to use (e.g., anthropic, openai).
- `LLMWIKI_MODEL`: The model name to override the provider default.

### Anthropic (Default)

- `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`: Required. Either one can satisfy Anthropic authentication.
- `ANTHROPIC_BASE_URL`: Optional. Custom endpoint for proxies. Valid HTTP(S) URLs are accepted, including Claude-style path endpoints such as `https://api.kimi.com/coding/`.

Example using an Anthropic or cc-switch custom proxy:

```bash
export LLMWIKI_PROVIDER=anthropic
export ANTHROPIC_API_KEY=sk-...
export ANTHROPIC_BASE_URL=https://proxy.example.com
```

If those values are not set in shell env or `.env`, llmwiki will try Anthropic-compatible values from `~/.claude/settings.json` (`env` block) for:

- `ANTHROPIC_API_KEY`
- `ANTHROPIC_AUTH_TOKEN`
- `ANTHROPIC_BASE_URL`
- `ANTHROPIC_MODEL`

Example with zero exports (Claude Code already configured):

```bash
llmwiki compile
```

### Claude Agent SDK (local Claude Code login)

The `claude-agent` provider routes calls through the
[Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript)
instead of the raw Messages API. It authenticates with your **local Claude Code
login** (OAuth/subscription), so **no `ANTHROPIC_API_KEY` is required** — if you
can run `claude` in your terminal, this provider works.

> **Terms of use.** This provider drives your Claude Code / Agent SDK session
> programmatically to compile wikis. That is not automatically appropriate for
> every account type, plan, or environment. Before using it, review Anthropic's
> current [Claude Code](https://www.anthropic.com/legal/consumer-terms) and
> [Agent SDK](https://docs.anthropic.com/en/api/agent-sdk/overview) terms and
> usage policies, and make sure your intended use complies with them.

```bash
export LLMWIKI_PROVIDER=claude-agent
export LLMWIKI_MODEL=claude-sonnet-4-6  # optional; this is the default
llmwiki compile
```

Notes:

- Generation (`compile`) and structured extraction work off the local login with
  no extra credentials.
- Semantic search (`llmwiki query`) still needs embeddings, which Claude does not
  provide. Set `VOYAGE_API_KEY` to enable them (same as the `anthropic`
  provider); otherwise `query` falls back to lexical ranking.
- To see what the SDK is doing, set `LLMWIKI_DEBUG=1` for a concise one-line trace
  per SDK message (`[claude-agent] system:init`, `… assistant`, `… result:success`)
  plus any `claude` subprocess errors. Use `LLMWIKI_DEBUG=verbose` to additionally
  enable the SDK's full verbose logging.

  ```bash
  LLMWIKI_DEBUG=1 LLMWIKI_PROVIDER=claude-agent llmwiki compile
  ```

### OpenAI-Compatible Local Servers

Use the OpenAI provider for local OpenAI-compatible servers such as
`llama-server`. `OPENAI_BASE_URL` is used for chat/tool calls, and
`OPENAI_EMBEDDINGS_BASE_URL` is optional. Set it only when embeddings are
served from a different endpoint; when unset, embeddings use the same client
and base URL as chat. Include `/v1` in custom URLs.

Split endpoint example:

```bash
export LLMWIKI_PROVIDER=openai
export LLMWIKI_MODEL=qwen3.6-35b
export LLMWIKI_EMBEDDING_MODEL=text-embedding-model
export OPENAI_API_KEY=sk-local
export OPENAI_BASE_URL=http://host_url:port/v1
export OPENAI_EMBEDDINGS_BASE_URL=http://host_url:port/v1
```

`OPENAI_API_KEY` is still required by the CLI and OpenAI SDK. For local
servers that do not check authentication, any dummy value is sufficient.

### Ollama

Ollama uses its OpenAI-compatible endpoint. Set `OLLAMA_HOST` for chat and
optionally set `OLLAMA_EMBEDDINGS_HOST` only when embeddings are served from a
different endpoint. When unset, embeddings use `OLLAMA_HOST`. Include `/v1` in
custom URLs.

```bash
export LLMWIKI_PROVIDER=ollama
export LLMWIKI_MODEL=llama3.1
export LLMWIKI_EMBEDDING_MODEL=nomic-embed-text
export OLLAMA_HOST=http://ollama_host:11434/v1
export OLLAMA_EMBEDDINGS_HOST=http://ollama_host:11435/v1
```

### GitHub Copilot

Uses the GitHub Copilot API (`https://api.githubcopilot.com`), an
OpenAI-compatible endpoint available to Copilot subscribers. Requires a GitHub
OAuth token with the `copilot` scope — **classic PATs are not supported**.

First, ensure your `gh` CLI token has the required scope:

```bash
gh auth refresh --scopes copilot
```

Then run:

```bash
export LLMWIKI_PROVIDER=copilot
export GITHUB_TOKEN=$(gh auth token)  # OAuth token required; PATs will not work
export LLMWIKI_MODEL=gpt-4o           # optional; gpt-4o is the default
```

Available models (names use dots, not dashes): `gpt-4o`, `gpt-4o-mini`,
`claude-sonnet-4.5`, `claude-sonnet-4.6`, `claude-opus-4.5`, `gemini-2.5-pro`,
and others — availability depends on your Copilot plan.

**Embeddings:** The GitHub Copilot API does not expose an embeddings endpoint.
Semantic search (used by `llmwiki query` with chunked retrieval) will fall back
to full-index selection without embeddings. For embedding-dependent workflows,
switch to the `openai` provider and provide `OPENAI_API_KEY`.

### Request timeouts

The OpenAI SDK defaults to a 10-minute per-request timeout, which can cut off long compile-time completions on slower local models. Override per provider:

- `LLMWIKI_REQUEST_TIMEOUT_MS` — provider-agnostic timeout in milliseconds. Applies to both the `openai` and `ollama` backends.
- `OLLAMA_TIMEOUT_MS` — Ollama-specific override. Wins over `LLMWIKI_REQUEST_TIMEOUT_MS` when both are set.

Defaults: 10 minutes for `openai`, 30 minutes for `ollama` (local models commonly need more).

### Output language

Generated wiki content defaults to whatever language the model produces from the source material — typically English. Override with either:

- `LLMWIKI_OUTPUT_LANG` — e.g. `zh-CN`, `Chinese`, `ja`, `Japanese`. Applies to every prompt the compile and query pipelines make.
- `--lang <code>` on `llmwiki compile` and `llmwiki query` — same effect, scoped to one invocation. Wins over the env var.

Unset preserves prior behaviour byte-for-byte.

### Per-concept prompt budget

When many sources contribute to the same compiled concept, `compile` enforces a per-concept character cap on the combined source content sent to the LLM so popular shared concepts don't blow past the model's context window. Each contributing source gets a fair share when truncation kicks in.

- `LLMWIKI_PROMPT_BUDGET_CHARS` — character ceiling for the combined per-concept prompt. Defaults to `200000` (~50k tokens), which fits modern context windows with headroom. Raise it for larger-context models, lower it for local small-context models.

A truncation warning prints to stderr when the cap fires so you know which concept hit the budget.

</details>


<br>

---

<br>


## Why compile, not just retrieve?

llmwiki uses embeddings — chunk-level, incremental, with BM25 reranking. But the embedding layer sits **below** the compiled wiki, not in front of it.

**RAG retrieves chunks at query time.** Every question re-discovers the same relationships from scratch. The wiki structure, citation graph, and merged-concept disambiguation never accumulate; they get re-invented per query.

**llmwiki compiles your sources into a wiki first.** Concepts get their own typed pages. Concepts shared across multiple sources are merged into one page instead of competing as duplicate chunks. Pages link to each other via `[[wikilinks]]`. When you ask a question with `--save`, the answer becomes a new page, and future queries use it as context.

Then semantic retrieval, BM25 reranking, and graph expansion run over the compiled artifact — narrowing hundreds of pages to a tight, citation-traceable evidence pack.

```
RAG:     query → search chunks → answer → forget
llmwiki: sources → compile → wiki → embed → query → save → richer wiki → better answers
```

llmwiki is complementary to traditional RAG: use RAG for ad-hoc retrieval over noisy or fast-changing corpora; use llmwiki when you want a persistent, structured, citation-traceable artifact that compounds.

## How it works

```
sources/  →  hash check  →  LLM concept extraction  →  page generation  →  [[wikilink]] resolve
                                                                            ↓
                                                       chunk embeddings  ←  wiki/  →  index.md
                                                              ↓
                                       semantic search + BM25 rerank + graph expansion
                                                              ↓
                                                  llmwiki query / context / MCP
```

**Two-phase compile.** Phase 1 extracts all concepts from all sources. Phase 2 generates pages. This eliminates order-dependence, catches failures before writing anything, and merges concepts shared across multiple sources into single pages.

**Incremental everywhere.** Hash-based change detection on sources, content-hash-aware embedding updates, cached citation judgements. Only changed work runs through the LLM.

**Hybrid retrieval.** `.llmwiki/embeddings.json` v2 carries page- and chunk-level vectors. `llmwiki query` and `llmwiki context` narrow hundreds of pages down to a chunk-level top-K via cosine similarity, then rerank with BM25 and expand along the wikilink graph for the final evidence pack.

**Citation-traceable.** Paragraphs carry `^[source.md]` markers; specific claims pin to `^[source.md:42-58]` line ranges. `llmwiki lint` validates that every citation resolves to a real file and line range; `llmwiki eval` measures citation precision and (optionally) LLM-judged claim support.

**Compounding queries.** `llmwiki query --save` writes the answer as a wiki page and immediately rebuilds the index. Saved answers show up in future queries as context.

### What it produces

A raw source like a Wikipedia article on knowledge compilation becomes a structured wiki page:

```yaml
---
title: Knowledge Compilation
summary: Techniques for converting knowledge representations into forms that support efficient reasoning.
kind: concept
sources:
  - knowledge-compilation.md
createdAt: "2026-04-05T12:00:00Z"
updatedAt: "2026-04-05T12:00:00Z"
---
```

```markdown
Knowledge compilation refers to a family of techniques for pre-processing
a knowledge base into a target language that supports efficient queries.

Related concepts: [[Propositional Logic]], [[Model Counting]]
```

Pages include source attribution in frontmatter. Paragraphs are annotated with `^[filename.md]` markers pointing back to the source file that contributed the content; specific claims can use line ranges like `^[filename.md:42-58]` or `^[filename.md#L42-L58]`.


<br>

---

<br>


<details>
<summary><span style="font-size: 1.4em;"><strong>CLI and wiki model — click to expand</strong></span></summary>


## Commands

| Command | What it does |
|---------|-------------|
| `llmwiki ingest <url\|file>` | Fetch a URL or copy a local file into `sources/` |
| `llmwiki ingest-session <path>` | Import a Claude/Codex/Cursor session export (single file or whole directory) into `sources/` |
| `llmwiki quickstart <source>` | Ingest a source and compile a wiki in one step; supports `--review`, `--no-open`, `--provider`, `--lang`, and `--json` |
| `llmwiki compile` | Incremental compile: extract concepts, generate wiki pages |
| `llmwiki compile --review` | Write candidate pages to `.llmwiki/candidates/` instead of `wiki/` so you can review before they land |
| `llmwiki compile --lang <code>` | Generate wiki content in the given language (e.g. `Chinese`, `ja`, `zh-CN`); also works on `query` |
| `llmwiki review list` | List pending candidate pages |
| `llmwiki review show <id>` | Print a candidate's title, summary, and body |
| `llmwiki review approve <id>` | Promote a candidate into `wiki/` and refresh index/MOC/embeddings |
| `llmwiki review reject <id>` | Archive a candidate without touching `wiki/` |
| `llmwiki schema init` | Write a starter `.llmwiki/schema.json` file |
| `llmwiki schema show` | Print the resolved schema for the current project |
| `llmwiki query "question"` | Ask questions against your compiled wiki |
| `llmwiki query "question" --save` | Answer and save the result as a wiki page |
| `llmwiki export [--target <name>] [--project-id <id>]` | Export the wiki to portable formats — `llms.txt`, `llms-full.txt`, JSON, JSON-LD, GraphML, Marp slides. `--project-id` pins a stable identifier inside the JSON envelope so downstream importers (e.g. [`@atomicmemory/llmwiki`](https://github.com/atomicstrata/atomicmemory/tree/main/packages/llmwiki)) can derive deterministic external IDs |
| `llmwiki view [--open]` | Start a read-only local web viewer for browsing, searching, and inspecting the compiled wiki |
| `llmwiki next [--json]` | Show the recommended next action for this project (read-only); `--json` emits a stable envelope for agents |
| `llmwiki context "<prompt>" [--json]` | Build an agent-ready evidence pack (primary pages, citations, neighbors, suggested actions) — same v1 envelope as MCP `get_context_pack` |
| `llmwiki lint` | Check wiki quality (broken links, orphans, empty pages, low confidence, contradictions, etc.) |
| `llmwiki eval [--suite fast\|full]` | Measure wiki quality: health score (0–100), citation coverage, corpus stats. `--suite full` adds LLM-as-judge citation support scoring |
| `llmwiki eval cache show` | Print score distribution and top-cited pages from the citation judgement cache |
| `llmwiki eval cache clear` | Remove the citation judgement cache |
| `llmwiki eval report` | Print the most recent eval report |
| `llmwiki eval history [--n N]` | Show a trend table of past eval runs from `history.jsonl` |
| `llmwiki eval judgements [--score 0\|1\|2] [--page slug]` | Inspect individual citation judgements with optional score or page filters |
| `llmwiki watch` | Auto-recompile when `sources/` changes |
| `llmwiki serve [--root <dir>]` | Start an MCP server exposing wiki tools to AI agents |

`llmwiki context --include-sources` and MCP `get_context_pack` with `includeSources: true` are opt-in because they can return raw snippets from files under `sources/`. Path confinement prevents reads outside `sources/`, but only enable source windows for agents you trust with the ingested source text.

## Output

```
log.md              append-only activity journal (ingests, compiles, queries)
wiki/
  concepts/         one .md file per concept, with YAML frontmatter
  queries/          saved query answers, included in index and retrieval
  index.md          auto-generated table of contents
.llmwiki/
  schema.json       optional page-kind and cross-link policy
  candidates/       pending review candidates from `compile --review`
  candidates/archive/  rejected candidates kept for audit
```

Obsidian-compatible. `[[wikilinks]]` resolve to concept titles.

`log.md` records what happened and when. Each entry is a heading with a fixed
prefix — `## [YYYY-MM-DDThh:mm:ssZ] operation | description` (an ISO 8601 UTC
timestamp) — followed by a short bullet body carrying page wikilinks and counts:

```markdown
## [2026-06-05T09:14:02Z] ingest | Attention Is All You Need
- Source: https://arxiv.org/abs/1706.03762
- Saved: sources/attention-is-all-you-need.md
- Chars: 38,214

## [2026-06-05T09:15:30Z] compile | 1 source(s) → 6 page(s)
- Sources: attention-is-all-you-need.md
- Created: [[self-attention]], [[multi-head-attention]], [[transformer]]
- Updated: [[positional-encoding]]

## [2026-06-05T09:16:11Z] query | What is multi-head attention?
- Pages: [[multi-head-attention]], [[self-attention]]
```

Only headings start with `## [`, so the gist's recipe still works even with the
bodies: `grep "^## \[" log.md | tail -5` shows the five most recent operations.
Where `index.md` organizes content for discovery, `log.md` tracks temporal
progression.

## Local web viewer

Run `llmwiki view` from a project root to browse the compiled wiki in a local browser without Obsidian. The viewer is read-only: it renders `wiki/`, exposes sidebar navigation, search, page metadata, health counts, and provenance/citation chips, but does not mutate sources or generated pages.

```bash
llmwiki view          # prints Viewer ready at http://127.0.0.1:<port>
llmwiki view --open   # also opens the URL in your default browser
```

The server is private by default. It binds to `127.0.0.1` unless you explicitly provide both `--host <host>` and `--allow-lan`; wildcard hosts are rejected. Viewer responses use a strict local-asset CSP and path-confinement checks so the UI can safely render local markdown content.

## Review queue

By default, `compile` writes pages directly to `wiki/`. Add `--review` to write candidate JSON records to `.llmwiki/candidates/` instead, so you can inspect each generated page before it lands.

```bash
llmwiki compile --review     # produces candidates, leaves wiki/ untouched
llmwiki review list          # see what's pending
llmwiki review show <id>     # inspect a single candidate
llmwiki review approve <id>  # write into wiki/ + refresh index/MOC/embeddings
llmwiki review reject <id>   # archive to .llmwiki/candidates/archive/
```

A few things to know:

- **Approve and reject acquire `.llmwiki/lock`** so they serialize cleanly against each other and against any concurrent `compile`.
- **Source state is deferred per-source.** When one source produces multiple candidates, the source isn't marked compiled until the last candidate is approved — so unresolved siblings stay re-detectable on the next `compile --review`.
- **Deletion bookkeeping is deferred.** `compile --review` does not orphan-mark deleted sources; the next non-review `compile` does that. The `--review` help text advertises this.
- MCP `wiki_status` exposes `pendingCandidates` so agents can see the queue depth.

## Page metadata

Compiled pages can carry epistemic metadata in frontmatter so consumers know how trustworthy each page is. All fields are optional and existing pages without them continue to work.

```yaml
---
title: Knowledge Compilation
summary: Techniques for converting knowledge representations...
sources:
  - knowledge-compilation.md
confidence: 0.82           # 0–1, LLM-reported confidence in the synthesized page
provenanceState: merged    # extracted | merged | inferred | ambiguous
contradictedBy:
  - slug: probabilistic-reasoning
---
```

When multiple sources merge into one slug, metadata is reconciled: `min` confidence, `provenanceState = 'merged'`, union of `contradictedBy` (deduped by slug).

`llmwiki lint` adds three rules that surface this metadata:

- `low-confidence` — flags pages with `confidence` below a threshold
- `contradicted-page` — flags pages with non-empty `contradictedBy`
- `excess-inferred-paragraphs` — flags pages whose body has too many uncited prose paragraphs (counted directly from the rendered text — the body is the single source of truth, no frontmatter field involved)

## Claim-level provenance

Paragraph citations continue to use the original source-marker form:

```markdown
This paragraph is grounded in the source. ^[source.md]
```

For claims that need tighter verification, pages can pin a statement to a line range in the ingested source:

```markdown
The system uses a two-phase compile pipeline. ^[architecture-notes.md:42-58]
The same range can also use GitHub-style anchors. ^[architecture-notes.md#L42-L58]
```

`llmwiki lint` validates both forms. It reports missing source files, malformed claim citations, impossible ranges like line `0` or `8-3`, and ranges that extend past the end of the source file.

## Schema layer

Projects can optionally define `.llmwiki/schema.json` to shape the wiki beyond flat concept pages. Existing projects do not need a schema file; missing or invalid `kind` values fall back to `concept`.

```bash
llmwiki schema init
llmwiki schema show
```

The schema supports four page kinds:

- `concept` — standalone idea or pattern
- `entity` — specific person, product, organization, or named artifact
- `comparison` — side-by-side analysis across concepts or entities
- `overview` — map page that connects several concepts in a domain

Schema rules can set per-kind `minWikilinks` and optional `seedPages`. Compile can materialize seed pages such as overviews, lint enforces page-kind-specific cross-link minimums, and review candidates surface schema violations before approval.

## Eval / quality measurement

`llmwiki eval` gives the wiki a quantitative health score and tracks citation quality over time, making it possible to detect regressions after a recompile.

```bash
llmwiki eval                   # fast suite: health score, citation coverage, corpus stats
llmwiki eval --suite full      # + LLM-as-judge citation support scoring (requires API)
llmwiki eval report            # re-print the most recent report
llmwiki eval history           # trend table across past runs
llmwiki eval history --n 10    # limit to last 10 entries
llmwiki eval judgements        # all cached citation judgements
llmwiki eval judgements --score 0          # only unsupported citations
llmwiki eval judgements --page some-slug   # filter to one page
llmwiki eval cache show        # score distribution + top-cited pages
llmwiki eval cache clear       # wipe the citation judgement cache
```

**What it measures:**

- **Health score (0–100)** aggregates all lint rules. Errors (broken citations, broken wikilinks, duplicate concepts) cost more than warnings.
- **Citation coverage** — fraction of prose paragraphs that carry a `^[...]` marker, plus citation precision (fraction of citations pointing to existing source files).
- **Citation support (full suite)** — samples up to N `(claim, source span)` pairs, asks a judge model to score each 0–2 (unsupported → fully supported), and caches results so subsequent runs only re-judge new pairs.
- **Corpus stats** — page count, source count, total wiki characters, embedding counts, appended to `history.jsonl` for trend tracking.
- **Regression deltas** — current report is diffed against the previous entry in history.

**CI thresholds:** add `.llmwiki/eval/thresholds.yaml` to configure minimum acceptable scores:

```yaml
health_score: 85
citation_coverage_percent: 70
citation_precision_percent: 90
citation_support_mean: 1.4   # only checked when --suite full
```

Threshold violations are listed in the report. Exit code is non-zero when any threshold is breached, suitable for CI gating.

**Artifacts** written under `.llmwiki/eval/`:

```
.llmwiki/eval/
  history.jsonl          one JSON line per eval run
  citation-cache.jsonl   one JSON line per citation judgement
  thresholds.yaml        optional CI threshold config
```

</details>


<br>

---

<br>


## Demo

Try it on any article or document:

```bash
mkdir my-wiki && cd my-wiki
llmwiki quickstart https://en.wikipedia.org/wiki/Andrej_Karpathy
llmwiki query "What terms did Andrej coin?"
```

See `examples/basic/` in the repo for pre-generated output you can browse without an API key.


<br>

---

<br>


<details>
<summary><span style="font-size: 1.4em;"><strong>MCP Server — click to expand</strong></span></summary>


## MCP Server

llmwiki ships an MCP (Model Context Protocol) server so AI agents (Claude Desktop, Cursor, Claude Code, etc.) can drive the full pipeline directly: ingest sources, compile, query, search, lint, and read pages — without scraping CLI output.

Where [llm-wiki-kit](https://github.com/iamsashank09/llm-wiki-kit) gives agents raw CRUD against wiki pages, llmwiki exposes the **automated pipelines**: agents get intelligent compilation, incremental change detection, and semantic query routing built in.

### Setup

Start the server (stdio transport, no API key required at startup):

```bash
llmwiki serve --root /path/to/your/wiki-project
```

### Claude Desktop / Cursor configuration

Add to your client's MCP config (e.g. `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "llmwiki": {
      "command": "npx",
      "args": ["llm-wiki-compiler", "serve", "--root", "/path/to/wiki-project"],
      "env": {
        "ANTHROPIC_API_KEY": "sk-ant-..."
      }
    }
  }
}
```

Tools that need an LLM (`compile_wiki`, `query_wiki`, `search_pages`) check for a configured provider on each call. Read-only tools (`read_page`, `lint_wiki`, `wiki_status`) and `ingest_source` work without any credentials. `get_context_pack` is read-only and provider credentials are optional — when present, semantic retrieval is used; otherwise the tool falls back to lexical ranking and surfaces an `embedding-store-missing` or `query-embedding-unavailable` warning.

### Tools

| Tool | What it does |
|------|--------------|
| `ingest_source` | Fetch a URL or local file into `sources/`. |
| `compile_wiki` | Run the incremental compile pipeline; returns counts, slugs, errors. |
| `query_wiki` | Two-step grounded answer with optional `--save`. |
| `search_pages` | Return full content of pages relevant to a question. |
| `read_page` | Read a single page by slug (concepts/ then queries/). |
| `lint_wiki` | Run quality checks; returns structured diagnostics. |
| `wiki_status` | Page count, source count, orphans, pending changes (read-only). |
| `get_context_pack` | Build an agent-ready evidence pack (primary pages, semantic chunks, graph neighbors, citations, warnings, suggested actions) — same v1 JSON envelope as `llmwiki context --json`. `get_context_pack` **packages evidence**; `query_wiki` **generates answers**. |

### Resources

| URI | Returns |
|-----|---------|
| `llmwiki://index` | Full `wiki/index.md` content. |
| `llmwiki://concept/{slug}` | A single concept page (frontmatter + body). |
| `llmwiki://query/{slug}` | A single saved query page. |
| `llmwiki://sources` | List of ingested source files with metadata. |
| `llmwiki://state` | Compilation state (per-source hashes, last compile times). |

</details>


<br>

---

<br>


## Companion: Atomic Memory

llmwiki and [Atomic Memory](https://github.com/atomicstrata/atomicmemory) are complementary layers of open context infrastructure, both maintained by [Atomic Strata](https://github.com/atomicstrata):

- **llmwiki** gives you a persistent **knowledge base** — durable markdown compiled from your sources, inspectable on disk.
- **Atomic Memory** gives your agents persistent **working memory** — runtime context that's searchable, correctable, scoped, and inspectable over time.

Use them independently or together. Each remains valuable on its own — llmwiki as a notebook, RAG index, CI-checked knowledge base, or domain pack source; Atomic Memory as a runtime memory layer for any agent or app.

The [`@atomicmemory/llmwiki`](https://github.com/atomicstrata/atomicmemory/tree/main/packages/llmwiki) bridge ingests `llmwiki export --target json --project-id <id>` envelopes as one verbatim Atomic Memory record per wiki page, preserving all advisory metadata (kind, citations, confidence, provenance state, contradictions, aliases, freshness) under `memory.metadata.llmwiki.*`. See the [bridge cookbook](https://github.com/atomicstrata/atomicmemory/blob/main/packages/llmwiki/docs/cookbook.md) for the full compile → export → import → package workflow.

## Scale and what works

Still early software, but the scale story has matured well past the "few dozen sources" era.

- **Semantic chunk retrieval** (`.llmwiki/embeddings.json` v2) narrows hundreds of pages down to a small top-K before LLM selection, with BM25 reranking and graph-neighborhood expansion layered on top.
- **Incremental everything.** Hash-based source-change detection, content-hash-aware embedding updates, cached citation judgements. Re-running on an unchanged corpus is a few seconds.
- **Lexical fallback.** Index-based routing kicks in automatically when no embedding store is present or the active provider has no embedding credentials, surfacing a stable warning code rather than hard-failing.

**Honest about truncation.** Sources that exceed the character limit are truncated on ingest with `truncated: true` and the original character count recorded in frontmatter, so downstream consumers know they're working with partial content. A per-concept prompt budget prevents popular shared concepts from crashing compile.

**Where it's still early.** No source-freshness watchdog yet (re-ingest detects content changes, but doesn't proactively re-check URLs). No team / multi-writer conflict resolution. The viewer is read-only by design — write operations go through the CLI or MCP.

## Karpathy's LLM Wiki pattern vs this compiler

Karpathy described an abstract pattern for turning raw data into compiled knowledge. Here's how llmwiki maps to it today:

| Karpathy's concept | llmwiki | Status |
|---|---|---|
| Data ingest | `llmwiki ingest`, `ingest-session` (Claude/Codex/Cursor) | Implemented |
| Compile wiki | `llmwiki compile` (two-phase, incremental) | Implemented |
| Q&A | `llmwiki query` (semantic + BM25 + graph expansion) | Implemented |
| Output filing (save answers back) | `llmwiki query --save` | Implemented |
| Auto-recompile | `llmwiki watch` | Implemented |
| Linting / health-check pass | `llmwiki lint` + `llmwiki eval` (CI-gateable) | Implemented |
| Agent integration | `llmwiki serve` MCP server with `get_context_pack` | Implemented |
| Multimodal ingest | Images, PDFs, transcripts via `llmwiki ingest` | Implemented |
| Marp slides | `llmwiki export --target marp` | Implemented |
| Bridge to runtime memory | `llmwiki export --target json --project-id` → [`@atomicmemory/llmwiki`](https://github.com/atomicstrata/atomicmemory/tree/main/packages/llmwiki) | Implemented |
| Fine-tuning | — | Not yet implemented |

## Roadmap

Available on main, will ship in 0.9.0:

- ✅ Source freshness — `llmwiki lint` flags pages whose sources changed (`stale`) or were all deleted (`orphaned`) since compile, computed on demand from `.llmwiki/state.json` and the current `sources/`; the JSON export carries per-page `freshnessStatus`, `contradicted`, and `archived`
- ✅ JSON export bridge contract — `llmwiki export --target json --project-id <id>` adds per-page `path`, `kind`, advisory confidence/provenance, flattened citations, aliases, and freshness so downstream importers (e.g. [`@atomicmemory/llmwiki`](https://github.com/atomicstrata/atomicmemory/tree/main/packages/llmwiki)) can ingest pages as durable memory records
- ✅ Eval over MCP — `run_eval` MCP tool scores wiki quality (fast suite needs no API key; full suite LLM-judges a sample of citations), plus read-only `llmwiki://eval/report` and `llmwiki://eval/history` resources
- ✅ Alias-aware wikilinks — the viewer resolves a `[[term]]` link to any page that declares `term` in its `aliases` frontmatter, not just an exact slug match

Shipped in 0.8.0:

- ✅ Guided project flow — `llmwiki next` recommends the next useful command, and `llmwiki quickstart <source>` ingests, compiles, and opens the viewer in one step
- ✅ Graph/context layer — `llmwiki context` and MCP `get_context_pack` produce token-budgeted evidence packs with primary pages, graph neighbors, citations, optional source windows, warnings, and suggested actions
- ✅ Viewer graph route — `llmwiki view` includes a force-directed `#/graph` route for exploring page relationships
- ✅ Evaluation harness — `llmwiki eval` measures health score, citation coverage/precision, corpus stats, regression deltas, optional LLM-as-judge citation support, and CI thresholds

Shipped in 0.7.0:

- ✅ Read-only local web viewer — `llmwiki view` with sidebar navigation, markdown rendering, search, metadata, health counts, and provenance/citation chips
- ✅ GitHub Copilot provider — `LLMWIKI_PROVIDER=copilot` with `GITHUB_TOKEN=$(gh auth token)` for Copilot chat/tool calls
- ✅ Cached lint health summary — `llmwiki lint` writes `.llmwiki/last-lint.json` so viewer health can show the latest lint counts without re-running lint

Shipped in 0.6.0:

- ✅ Export bundle (`llms.txt`, JSON, JSON-LD, GraphML, Marp slides)
- ✅ Session-history adapters — `llmwiki ingest-session` for Claude, Codex, and Cursor exports
- ✅ Configurable output language — `--lang <code>` and `LLMWIKI_OUTPUT_LANG`
- ✅ Defensive per-concept prompt budget so popular shared concepts don't crash compile

Shipped in 0.5.0:

- ✅ Multimodal ingest (images, PDFs, transcripts)
- ✅ Chunked retrieval with reranking and `--debug` output
- ⚠️ Minimum Node version raised to 24 (was 18)

Shipped in 0.4.0:

- ✅ Claim-level provenance with source ranges
- ✅ First-class schema layer with typed page kinds (`concept`, `entity`, `comparison`, `overview`)

Shipped in 0.3.0:

- ✅ Candidate review queue (approve compile output before pages are written)
- ✅ Confidence and contradiction metadata on compiled pages

Shipped in 0.2.0:

- ✅ Better provenance (paragraph-level source attribution)
- ✅ Linting pass for wiki quality checks
- ✅ Multi-provider support (OpenAI, Ollama, MiniMax)
- ✅ Larger-corpus query strategy (semantic search, embeddings)
- ✅ Deeper Obsidian integration (tags, aliases, Map of Content)
- ✅ MCP server for agent integration

Next up:

- **Task and decision ledger** — turn session ingest into durable agent memory: goals, decisions, open questions, outcomes, and next-agent handoffs.
- **Rollback, audit, and source lifecycle** — undo/reverse ingest, compile diff reports, stale-claim checks, freshness reports, and a durable operation log.
- **Domain templates** — schema/prompt packs for research, codebase docs, team handbooks, decision logs, and standards/regulations.
- **Eval extensions** — retrieval recall suites, update-drift benchmarks, and comparisons against serious retrieval baselines.

Later / open to discussion:

- Recurring source refresh jobs — re-ingest URLs on a schedule, diff against the prior snapshot, re-compile only what changed
- MCP prompt resources — curated agent prompts such as "review the wiki", "propose new sources", and "draft a comparison page"
- Codex OAuth provider — ChatGPT subscription auth as a dedicated provider, with clear token refresh and embedding-limit behavior
- Team-chat connectors for Slack/Discord/Teams-style institutional memory

If you like ambitious problems: **task/decision ledger**, **rollback/audit tooling**, and **eval extensions** are the meatiest next contributions. Open an issue to claim one or kick off a design discussion.

Explicitly not planned (good ideas, just not for this repo): full static-site generator, desktop or mobile apps, fine-tuning, a formal ontology engine, heavy graph database infrastructure.

## Requirements

Node.js >= 24, plus provider credentials (for Anthropic: `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`).

## About

llmwiki is maintained by [Atomic Strata](https://github.com/atomicstrata), the team behind [Atomic Memory](https://github.com/atomicstrata/atomicmemory). Atomic Strata builds open context infrastructure: durable compiled knowledge with llmwiki, runtime memory with Atomic Memory.

## License

MIT


## Disclaimer

No LLMs were harmed in the making of this repo.
