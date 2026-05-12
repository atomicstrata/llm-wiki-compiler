# llmwiki

Compile raw sources into an interlinked markdown wiki.

Inspired by Karpathy's [LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) pattern: instead of re-discovering knowledge at query time, compile it once into a persistent, browsable artifact that compounds over time.

![llmwiki demo](docs/images/demo.gif)

## Who this is for

- **AI researchers and engineers** building persistent knowledge from papers, docs, and notes
- **Technical writers** compiling scattered sources into a structured, interlinked reference
- **Anyone with too many bookmarks** who wants a wiki instead of a graveyard of tabs

## Quick start

```bash
npm install -g llm-wiki-compiler
export ANTHROPIC_API_KEY=sk-...
# Or use ANTHROPIC_AUTH_TOKEN if your Anthropic-compatible gateway expects it.
# Or use a different provider:
# export LLMWIKI_PROVIDER=openai
# export OPENAI_API_KEY=sk-...

llmwiki ingest https://some-article.com
llmwiki compile
llmwiki query "what is X?"
```

## Configuration

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

## Why not just RAG?

RAG retrieves chunks at query time. Every question re-discovers the same relationships from scratch. Nothing accumulates.

llmwiki **compiles** your sources into a wiki. Concepts get their own pages. Pages link to each other. When you ask a question with `--save`, the answer becomes a new page, and future queries use it as context. Your explorations compound.

This is complementary to RAG, not a replacement. RAG is great for ad-hoc retrieval over large corpora. llmwiki gives you a persistent, structured artifact to retrieve from.

```
RAG:     query → search chunks → answer → forget
llmwiki: sources → compile → wiki → query → save → richer wiki → better answers
```

## How it works

```
sources/  →  SHA-256 hash check  →  LLM concept extraction  →  wiki page generation  →  [[wikilink]] resolution  →  index.md
```

**Two-phase pipeline.** Phase 1 extracts all concepts from all sources. Phase 2 generates pages. This eliminates order-dependence, catches failures before writing anything, and merges concepts shared across multiple sources into single pages.

**Incremental.** Only changed sources go through the LLM. Everything else is skipped via hash-based change detection.

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

## Commands

| Command | What it does |
|---------|-------------|
| `llmwiki ingest <url\|file>` | Fetch a URL or copy a local file into `sources/` |
| `llmwiki ingest-session <path>` | Import a Claude/Codex/Cursor session export (single file or whole directory) into `sources/` |
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
| `llmwiki export [--target <name>]` | Export the wiki to portable formats — `llms.txt`, `llms-full.txt`, JSON, JSON-LD, GraphML, Marp slides |
| `llmwiki lint` | Check wiki quality (broken links, orphans, empty pages, low confidence, contradictions, etc.) |
| `llmwiki watch` | Auto-recompile when `sources/` changes |
| `llmwiki serve [--root <dir>]` | Start an MCP server exposing wiki tools to AI agents |

## Output

```
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

## Demo

Try it on any article or document:

```bash
mkdir my-wiki && cd my-wiki
llmwiki ingest https://en.wikipedia.org/wiki/Andrej_Karpathy
llmwiki compile
llmwiki query "What terms did Andrej coin?"
```

See `examples/basic/` in the repo for pre-generated output you can browse without an API key.

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

Tools that need an LLM (`compile_wiki`, `query_wiki`, `search_pages`) check for a configured provider on each call. Read-only tools (`read_page`, `lint_wiki`, `wiki_status`) and `ingest_source` work without any credentials.

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

### Resources

| URI | Returns |
|-----|---------|
| `llmwiki://index` | Full `wiki/index.md` content. |
| `llmwiki://concept/{slug}` | A single concept page (frontmatter + body). |
| `llmwiki://query/{slug}` | A single saved query page. |
| `llmwiki://sources` | List of ingested source files with metadata. |
| `llmwiki://state` | Compilation state (per-source hashes, last compile times). |

## Limitations

Early software. Best for small, high-signal corpora (a few dozen sources). Query routing is index-based.

**Honest about truncation.** Sources that exceed the character limit are truncated on ingest with `truncated: true` and the original character count recorded in frontmatter, so downstream consumers know they're working with partial content.

## Karpathy's LLM Wiki pattern vs this compiler

Karpathy describes an abstract pattern for turning raw data into compiled knowledge. Here's how llmwiki maps to it:

| Karpathy's concept | llmwiki | Status |
|---|---|---|
| Data ingest | `llmwiki ingest` | Implemented |
| Compile wiki | `llmwiki compile` | Implemented |
| Q&A | `llmwiki query` | Implemented |
| Output filing (save answers back) | `llmwiki query --save` | Implemented |
| Auto-recompile | `llmwiki watch` | Implemented |
| Linting / health-check pass | `llmwiki lint` | Implemented |
| Agent integration | `llmwiki serve` (MCP server) | Implemented |
| Image support | `llmwiki ingest <image>` | Implemented |
| Marp slides | `llmwiki export --target marp` | Implemented |
| Fine-tuning | — | Not yet implemented |

## Roadmap

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

- **Read-only local web UI** — browse `wiki/` without Obsidian: sidebar, markdown rendering, wikilinks, search, and provenance/citation panels.
- **Graph/context layer** — page-neighborhood tools, graph paths, gap detection, and token-budgeted context packs for agents.
- **Evaluation harness** — benchmark answer quality, citation accuracy, update drift, retrieval recall, and scale curves against serious retrieval baselines.
- **Task and decision ledger** — turn session ingest into durable agent memory: goals, decisions, open questions, outcomes, and next-agent handoffs.
- **Rollback, audit, and source lifecycle** — undo/reverse ingest, compile diff reports, stale-claim checks, freshness reports, and a durable operation log.
- **Domain templates** — schema/prompt packs for research, codebase docs, team handbooks, decision logs, and standards/regulations.

Later / open to discussion:

- Recurring source refresh jobs — re-ingest URLs on a schedule, diff against the prior snapshot, re-compile only what changed
- MCP prompt resources — curated agent prompts such as "review the wiki", "propose new sources", and "draft a comparison page"
- Codex OAuth provider — ChatGPT subscription auth as a dedicated provider, with clear token refresh and embedding-limit behavior
- Team-chat connectors for Slack/Discord/Teams-style institutional memory

If you like ambitious problems: **local web UI**, **graph/context packs**, and **eval harness** are the meatiest next contributions. Open an issue to claim one or kick off a design discussion.

Explicitly not planned (good ideas, just not for this repo): full static-site generator, desktop or mobile apps, fine-tuning, a formal ontology engine, heavy graph database infrastructure.

## Requirements

Node.js >= 24, plus provider credentials (for Anthropic: `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`).

## License

MIT


## Disclaimer

No LLMs were harmed in the making of this repo.
