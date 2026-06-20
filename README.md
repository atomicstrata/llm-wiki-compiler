# llmwiki

[![CI](https://img.shields.io/github/actions/workflow/status/atomicstrata/llm-wiki-compiler/ci.yml?branch=main&logo=github&label=CI)](https://github.com/atomicstrata/llm-wiki-compiler/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/llm-wiki-compiler?logo=npm&label=npm)](https://www.npmjs.com/package/llm-wiki-compiler)
[![docs](https://img.shields.io/badge/docs-llmwiki.atomicstrata.ai-blue)](https://llmwiki.atomicstrata.ai)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

<p align="center">
  <img src="docs/images/okf-readme-banner.svg" alt="Breaking News: llmwiki supports Open Knowledge Format" width="900">
</p>

**Breaking News:** llmwiki is now an **Open Knowledge Format (OKF)** producer and consumer, aligning compiled agent knowledge with Google Cloud's emerging standard for portable knowledge sharing. Export compiled wikis with `llmwiki export --target okf`, import external bundles with `llmwiki import --okf`, and stage untrusted knowledge through review before it becomes live agent context.

---

## What llmwiki does

Compile raw sources into an interlinked, citation-traceable markdown wiki that agents and humans can browse, query, lint, export, and reuse.

llmwiki implements the [LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) pattern: instead of re-discovering knowledge from raw files at query time, compile it once into durable pages that accumulate structure, provenance, review state, and retrieval metadata over time.

![llmwiki demo](docs/images/demo.gif)

## When to use this repo

Use llmwiki when you need a persistent knowledge base from raw material:

- Compile papers, notes, READMEs, transcripts, PDFs, images, or web pages into typed wiki pages.
- Give agents a stable, citation-aware context pack instead of a pile of loose files.
- Keep generated knowledge auditable with source citations, review queues, freshness checks, and quality gates.
- Browse the result locally, query it from the CLI, expose it over MCP, or embed it through the SDK.
- Exchange compiled knowledge with other tools using Open Knowledge Format (OKF), JSON, JSON-LD, GraphML, Marp, and `llms.txt`.

Do not use llmwiki as a general static-site generator, a heavy ontology database, or a replacement for ad-hoc search over fast-changing raw logs. It is strongest when source knowledge is worth compiling, reviewing, and reusing.

## What you get

- **Compiled wiki, not chunks.** A two-phase LLM pipeline extracts concepts, then generates typed pages: `concept`, `entity`, `comparison`, and `overview`.
- **Citation-traceable output.** Paragraphs and claims cite source files and line ranges, and `llmwiki lint` validates the links.
- **Hybrid retrieval.** Semantic chunk search, BM25 reranking, and wikilink graph expansion build compact evidence packs for queries and agents.
- **Local viewer.** `llmwiki view` opens a read-only browser UI with search, page metadata, graph exploration, source-freshness badges, and citation chips.
- **Review policy.** Generated pages can be auto-held for review when confidence, contradiction, schema, or provenance rules trip.
- **Freshness repair.** `llmwiki lint` and `llmwiki next` surface stale/orphaned pages; `llmwiki refresh --stale` repairs changed knowledge without compiling unrelated new sources.
- **Eval harness.** `llmwiki eval` reports health score, citation coverage/precision, corpus stats, regression deltas, and optional judge-model citation support.
- **MCP server.** `llmwiki serve` exposes ingest, compile, query, lint, read, status, eval, context-pack, and OKF exchange tools to MCP-compatible agents.
- **SDK.** `createWiki({ root })` drives ingest, compile, query, context, status, export, eval, and OKF import/export from TypeScript without shelling out.
- **Open Knowledge Format exchange.** Export and import OKF bundles for portable, markdown-native knowledge exchange. External OKF imports are staged through the review queue by default; trusted bundles can be written live explicitly.
- **Other portable exports.** Export JSON, JSON-LD, GraphML, Marp slides, and `llms.txt` for downstream systems.
- **Provider portable.** Anthropic, Claude Agent SDK local login, OpenAI-compatible servers, Ollama, GitHub Copilot, and local OpenAI-compatible runtimes.

## Karpathy's LLM Wiki pattern

Andrej Karpathy described the LLM Wiki pattern as a way to turn raw material into compiled knowledge that future agents can reuse. llmwiki is a concrete compiler for that pattern.

The key shift is moving work from query time to compile time. Traditional RAG repeatedly retrieves raw chunks and asks the model to reconstruct relationships for each question. llmwiki first turns sources into typed, interlinked pages with citations, metadata, and review state. Queries, context packs, exports, and MCP tools then operate over that compiled artifact.

That makes llmwiki useful when knowledge should compound: concepts shared across sources become one page, saved answers become future context, stale pages can be detected and repaired, and agents can consume a stable evidence pack instead of re-reading the same raw files from scratch.

See [`docs/concepts/karpathy-pattern.mdx`](docs/concepts/karpathy-pattern.mdx) for the deeper explanation.

## Agent decision guide

If an agent is scanning this README, these are the high-signal entry points:

| Goal | Use |
|---|---|
| Create a wiki from one source and inspect it | `llmwiki quickstart <source>` |
| Add more files or URLs | `llmwiki ingest <url-or-file>` |
| Compile or recompile changed sources | `llmwiki compile` |
| Hold generated pages for human approval | `llmwiki compile --review` or review policy config |
| Ask grounded questions | `llmwiki query "question"` |
| Save an answer back into the wiki | `llmwiki query "question" --save` |
| Build an evidence pack for another agent | `llmwiki context "<task>" --json` or MCP `get_context_pack` |
| Inspect the compiled knowledge base | `llmwiki view --open` |
| Check broken links, citations, confidence, freshness, and quality | `llmwiki lint` and `llmwiki eval` |
| Repair stale compiled pages | `llmwiki refresh --stale --dry-run`, then `llmwiki refresh --stale` |
| Drive llmwiki from an agent | `llmwiki serve --root <project>` |
| Drive llmwiki from TypeScript | `createWiki({ root })` |
| Export for another system | `llmwiki export --target <format>` |
| Export an Open Knowledge Format bundle | `llmwiki export --target okf --out <dir>` |
| Import an Open Knowledge Format bundle | `llmwiki import --okf <dir> --dry-run`, then review/approve |

## Quick start

```bash
npm install -g llm-wiki-compiler

export ANTHROPIC_API_KEY=sk-...
# or choose another provider:
# export LLMWIKI_PROVIDER=openai
# export OPENAI_API_KEY=sk-...

llmwiki quickstart ./notes.md
llmwiki query "what are the key ideas?"
llmwiki view --open
```

`quickstart` ingests one source, compiles pages, and opens the viewer. Inside an existing project, run `llmwiki next` when you want the safest next action.

## Demo

Try it on any article or document:

```bash
mkdir my-wiki && cd my-wiki
llmwiki quickstart https://en.wikipedia.org/wiki/Andrej_Karpathy
llmwiki query "What terms did Andrej coin?"
```

The [`examples/basic/`](examples/basic/) directory includes a small pre-generated wiki you can inspect without an API key.

## Core commands

| Command | What it does |
|---|---|
| `llmwiki ingest <url-or-file>` | Fetch a URL or copy a local file into `sources/`. |
| `llmwiki ingest-session <path>` | Import exported Claude, Codex, or Cursor sessions into `sources/`. |
| `llmwiki quickstart <source>` | Ingest, compile, and optionally open the viewer in one step. |
| `llmwiki compile` | Incrementally extract concepts and generate wiki pages. |
| `llmwiki refresh --stale [--dry-run]` | Recompile changed owners of stale pages and clean selected orphaned ownership. |
| `llmwiki review list/show/approve/reject` | Inspect and manage held candidates. |
| `llmwiki query "question" [--save]` | Ask questions against the compiled wiki, optionally saving the answer. |
| `llmwiki context "<prompt>" --json` | Build a citation-aware evidence pack for agents. |
| `llmwiki view [--open]` | Start the read-only local browser viewer. |
| `llmwiki lint` | Validate wiki structure, citations, links, metadata, and freshness. |
| `llmwiki eval [--suite fast\|full]` | Measure wiki quality and optional citation support. |
| `llmwiki export --target <format>` | Export the wiki to portable formats, including Open Knowledge Format (`okf`). |
| `llmwiki import --okf <dir> [--dry-run] [--trusted]` | Import an Open Knowledge Format bundle, staged for review by default. |
| `llmwiki serve --root <dir>` | Start the MCP server. |

Full command docs live in [`docs/cli/`](docs/cli/).

## Open Knowledge Format

llmwiki is an Open Knowledge Format (OKF) producer and consumer. OKF is a Google Cloud initiative for sharing compiled knowledge as portable markdown files with structured frontmatter.

```bash
llmwiki export --target okf --out ./dist/okf
llmwiki import --okf ./dist/okf --dry-run
llmwiki import --okf ./dist/okf
```

OKF import is intentionally review-first: untrusted bundles become review candidates, not live wiki pages. The importer preserves foreign OKF metadata, stores llmwiki provenance under `x-llmwiki`, and re-exports imported pages honestly after local edits, including safe original nested paths.

See [`docs/guides/open-knowledge-format.mdx`](docs/guides/open-knowledge-format.mdx), [`docs/cli/export.mdx`](docs/cli/export.mdx), and [`docs/cli/import.mdx`](docs/cli/import.mdx).

## What llmwiki creates

A project has raw inputs in `sources/`, compiled markdown in `wiki/`, and compiler state under `.llmwiki/`:

```text
sources/
  raw source files
wiki/
  concepts/      compiled pages
  queries/       saved answers
  index.md       generated TOC
.llmwiki/
  config.json    review policy
  schema.json    page-kind/cross-link policy
  state.json     source hashes and ownership
  candidates/    held review candidates
  eval/          quality history and thresholds
log.md           activity journal
```

Compiled pages are plain markdown with YAML frontmatter, plus enough metadata for agents to reason about citations, freshness, confidence, contradictions, and review state. See [`docs/concepts/wiki-model.mdx`](docs/concepts/wiki-model.mdx).

## Agent integration

### MCP

Run:

```bash
llmwiki serve --root /path/to/wiki-project
```

MCP clients can ingest sources, compile, query, search pages, read pages, lint, run eval, inspect status, request context packs, and exchange OKF bundles. Read-only tools work without provider credentials; LLM-backed tools validate provider credentials at call time.

See [`docs/guides/mcp-agent-integration.mdx`](docs/guides/mcp-agent-integration.mdx).

### SDK

```ts
import { createWiki } from "llm-wiki-compiler";

const wiki = createWiki({ root: "/path/to/wiki-project" });
await wiki.ingest({ source: "./notes.md" });
await wiki.compile();
const answer = await wiki.query({ question: "What changed?" });
```

See [`docs/guides/sdk.mdx`](docs/guides/sdk.mdx).

## Configuration

Minimum requirement: Node.js 24 or newer.

The default provider is Anthropic:

```bash
export ANTHROPIC_API_KEY=sk-...
```

Provider selection is environment-driven:

| Provider | Typical setup |
|---|---|
| Anthropic | `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` |
| Claude Agent SDK | Local Claude Code login, `LLMWIKI_PROVIDER=claude-agent` |
| OpenAI-compatible | `LLMWIKI_PROVIDER=openai`, `OPENAI_API_KEY`, optional `OPENAI_BASE_URL` |
| Ollama | `LLMWIKI_PROVIDER=ollama`, `OLLAMA_HOST` |
| GitHub Copilot | `LLMWIKI_PROVIDER=copilot`, `GITHUB_TOKEN=$(gh auth token)` |

See [`docs/configuration/providers.mdx`](docs/configuration/providers.mdx) and [`docs/configuration/environment-variables.mdx`](docs/configuration/environment-variables.mdx).

## Quality and safety model

llmwiki is designed for auditable generated knowledge:

- **Review before write.** Use `compile --review` or `.llmwiki/config.json` review policy to hold risky pages as candidates.
- **Fail-closed config.** Invalid review-policy config aborts compile instead of silently disabling review.
- **Source confinement.** Source snippets and import/export paths are confined to the project.
- **Freshness is explicit.** Pages can be fresh, stale, orphaned, or unverified; stale pages are flagged and repairable.
- **Imported compiled knowledge is staged by default.** External bundles go through the review queue unless explicitly trusted.
- **CI gates are supported.** `llmwiki lint` and `llmwiki eval` can enforce quality thresholds.

See [`docs/configuration/review-policy.mdx`](docs/configuration/review-policy.mdx), [`docs/troubleshooting/stale-pages.mdx`](docs/troubleshooting/stale-pages.mdx), and [`docs/guides/ci-quality-gates.mdx`](docs/guides/ci-quality-gates.mdx).

## Scale and what works

llmwiki is still early software, but it is no longer a toy pipeline for a handful of notes.

- **Incremental compilation** means unchanged sources do not flow back through the LLM.
- **Chunk-level embeddings** narrow large wikis before BM25 reranking and graph expansion.
- **Content-hash-aware embedding updates** avoid recomputing vectors for unchanged pages and chunks.
- **Cached citation judgements** make repeated `eval --suite full` runs cheaper.
- **Lexical fallback** keeps query/context workflows usable when the active provider has no embedding endpoint.
- **Prompt budgeting and ingest truncation metadata** make large sources explicit instead of silently pretending they fit.

The current sweet spot is a durable project or domain wiki: research folders, codebase docs, team handbooks, standards, design notes, decision logs, or curated source packs. The less ideal fit is a high-churn firehose where raw search is enough and compiled structure would go stale faster than it can be reviewed.

## Documentation

The full docs site source is in [`docs/`](docs/):

- Start here: [`docs/introduction.mdx`](docs/introduction.mdx)
- Quickstart: [`docs/quickstart.mdx`](docs/quickstart.mdx)
- Installation: [`docs/installation.mdx`](docs/installation.mdx)
- Karpathy's LLM Wiki pattern: [`docs/concepts/karpathy-pattern.mdx`](docs/concepts/karpathy-pattern.mdx)
- How the compiler works: [`docs/concepts/how-it-works.mdx`](docs/concepts/how-it-works.mdx)
- Wiki model: [`docs/concepts/wiki-model.mdx`](docs/concepts/wiki-model.mdx)
- CLI reference: [`docs/cli/`](docs/cli/)
- Open Knowledge Format: [`docs/guides/open-knowledge-format.mdx`](docs/guides/open-knowledge-format.mdx)
- MCP integration: [`docs/guides/mcp-agent-integration.mdx`](docs/guides/mcp-agent-integration.mdx)
- SDK: [`docs/guides/sdk.mdx`](docs/guides/sdk.mdx)
- Atomic Memory bridge: [`docs/guides/atomic-memory-bridge.mdx`](docs/guides/atomic-memory-bridge.mdx)

Preview the docs locally with Node 24:

```bash
cd docs
volta run --node 24 npx mint dev --port 3001
```

## Current release

**On main, ships in `0.12.0`:**

- Batch embedding for `compile` — provider-native batches cut compile latency on cold starts and large refreshes.

**Released `0.11.0`:**

- In-process SDK (`createWiki().exportOkf`/`importOkf`) and MCP (`export_okf`/`import_okf`) access to the OKF round-trip.
- Faithful nested-path reconstruction when re-exporting imported foreign bundles.

See [`CHANGELOG.md`](CHANGELOG.md) for release history.

## Companion: Atomic Memory

llmwiki and [Atomic Memory](https://github.com/atomicstrata/atomicmemory) are complementary open context infrastructure:

- **llmwiki** compiles source material into durable, inspectable knowledge.
- **Atomic Memory** gives agents runtime memory that is searchable, scoped, correctable, and inspectable.

Use them independently or together. The [`@atomicmemory/llmwiki`](https://github.com/atomicstrata/atomicmemory/tree/main/packages/llmwiki) bridge imports `llmwiki export --target json --project-id <id>` as durable memory records.

## Contributing

Contributions are welcome. If llmwiki is missing something you need, open an issue or PR and describe the workflow you are trying to support - need-driven improvements are often the best ones. If you want to contribute more generally, roadmap items are a good place to start. For larger changes to core compile, review, import/export, or retrieval semantics, please start with an issue or design discussion so we can align on the contract first.

Before committing code changes, run:

```bash
npx tsc --noEmit
npm run build
npm test
npm run fallow:ci
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

MIT

## Disclaimer

No LLMs were harmed in the making of this repo.
