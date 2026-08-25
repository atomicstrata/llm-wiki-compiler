# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Caller system policy on compile** — `compile({ systemPolicy })` appends deployment-specific editorial or publication guidance to the built-in compile prompts, for SDK hosts that need it without forking the prompts. It is additive rather than a replacement, sits before the source material, and blank or omitted leaves the prompt byte-identical.

  It is advisory rather than enforceable: a policy makes a model more likely to follow a rule, and nothing downstream verifies that it did. Anything that must hold belongs in a lint rule or a trust gate.

  The policy is a prompt modifier, so changing or clearing it regenerates the pages compiled under the previous one, and replaces a pending review candidate produced under it. Each page records the policy's **digest**, never its text, since the modifier set travels into `state.json`, page frontmatter and the JSON export. `PROMPT_VERSION` advances to `v2`.

  Groundwork by **@TigerOfCountryYao** (#170), and see #144 for the request this partly answers.

- **Atlas Cloud provider** — `LLMWIKI_PROVIDER=atlascloud` (aliases `atlas-cloud`, `atlas`) routes chat and tool calls through the [Atlas Cloud](https://www.atlascloud.ai) gateway, which exposes an OpenAI-compatible API across models from several publishers. Authenticate with `ATLASCLOUD_API_KEY` or `ATLAS_CLOUD_API_KEY`; `ATLASCLOUD_BASE_URL` overrides the endpoint.

  Model ids are namespaced by publisher, and `compile` extracts concepts through a tool call, so the default is a model Atlas Cloud lists as supporting tools. Embeddings are not wired up: the provider fails closed rather than inheriting OpenAI's semantics, so route them elsewhere with `LLMWIKI_EMBEDDING_PROVIDER` for semantic search.

  Contributed by **@binyangzhu000-sudo** (#167).

- **Separate embedding provider** — `LLMWIKI_EMBEDDING_PROVIDER` selects the backend that serves embeddings, independently of `LLMWIKI_PROVIDER`. This makes split setups possible, such as Claude Agent SDK for generation with a local vLLM instance serving embeddings over its OpenAI-compatible endpoint. Valid values are `anthropic`, `claude-agent`, `openai`, and `ollama`. `minimax` and `copilot` expose no embeddings API, and naming one now fails with a clear error listing the valid values instead of an opaque failure from the provider's `embed()`. When the variable is set, the provider's own credential is required — `VOYAGE_API_KEY` for `anthropic` and `claude-agent`, `OPENAI_API_KEY` for `openai` — unless `OPENAI_EMBEDDINGS_BASE_URL` points at a self-hosted endpoint, which needs no key. Behaviour is unchanged when the variable is unset.

  Thanks to **@knew-inventai** for the request (#154).

  Changing the embedding backend invalidates the embedding index. It records the provider, model, and endpoint that produced its vectors, so the next `llmwiki compile` re-embeds every page. The model name alone is not enough to tell two backends apart — a local server answering to `text-embedding-3-small` and cloud OpenAI tag a store identically while producing vectors that do not share a space, and nothing downstream would notice. Moving between `anthropic` and `claude-agent` does not rebuild: both embed via Voyage with the same model.

  Set `OPENAI_EMBEDDINGS_API_KEY` to give a separate embeddings endpoint its own credential. Without it the embeddings client reuses `OPENAI_API_KEY`, which sends your cloud OpenAI key to whatever host `OPENAI_EMBEDDINGS_BASE_URL` names; llmwiki now warns when that happens, except on `localhost`. The warning redacts any credential carried in the endpoint URL itself, and the endpoint is hashed rather than stored verbatim in `.llmwiki/embeddings.json`.

  An index written before llmwiki recorded the endpoint carries only its model name. It is preserved while you run without `LLMWIKI_EMBEDDING_PROVIDER` or an endpoint override, so upgrading does not re-embed an existing project; under either override the model name cannot establish where the vectors came from, so the next compile rebuilds the index once and records the full configuration from then on.

- **`llmwiki rm <source>`** — Deletes a source and the concept pages derived exclusively from it, leaving pages another source also contributed to untouched. There is no confirmation flag; preview first with `--dry-run`, which takes no lock and changes nothing. `rm` refuses cleanly if another llmwiki process holds the project lock, and journals page deletes so a crash mid-removal recovers on the next `rm` or `compile` (#60).

  The plan is computed before the lock is taken, so `rm` recomputes which pages the source owns from fresh state under the lock and refuses the whole removal if anything moved in between — a page became shared, became exclusive, moved to another source, or was added. Nothing is deleted on a refusal; re-running plans against current state. `llmwiki watch` recompiles on any change under `sources/`, so this window is an ordinary workflow rather than a rare schedule.

  The source file is deleted before the pages, so a failed page batch leaves the file gone and its state entry behind. Re-running `rm` with the same name recognizes that pairing as an interrupted removal and finishes the job, rather than reporting "no source matches" while the pages are still on disk. A name occupied by something that is not a valid source — a symlink, a directory — is not treated as an interrupted removal.

  A kept page's body still cites the removed source, which `llmwiki lint` reports as a `broken-citation` error. `rm` warns whenever it keeps a page so the lint failure is not a surprise; it does not edit the citations.

  `rm` is now a reserved core CLI verb, alongside llmwiki's other top-level commands. A profile that declares a workflow keyed `rm` now fails validation at load instead of installing; rename the workflow to use that profile.

### Fixed

- **Changing the output language left existing pages untouched** — `llmwiki compile --lang Japanese` over an already-compiled project reported "Nothing to compile" and every page kept its previous language, because change detection classified a source by the SHA-256 of its bytes alone and a prompt modifier is not part of the source. The selected modifiers are now recorded in `.llmwiki/state.json`, and flipping one invalidates the pages it would have changed. Setting `LLMWIKI_OUTPUT_LANG` has the same effect as the flag.

  Pages also carry a `promptModifiers` frontmatter entry naming the modifiers active when they were generated, surfaced per page in the JSON export. `promptVersion` names the prompt implementation and is identical whether or not a modifier was selected, so it could not tell two such pages apart.

  A project that never set a modifier pays nothing on upgrade: its first compile records "none selected" and finds no difference. A project already running with `--lang` when it upgrades recompiles once, because a state file predating this cannot establish what its pages were generated under.

- **Windows: profile path validation rejected every declared directory** — on win32, `llmwiki template init` failed for every template with `entity directory must be under 'wiki/'`, any profile declaring a workflow `projectionFile` failed to load, and an entity directory declared as `wiki/` was wrongly accepted despite containing every reserved subtree — on win32 it was the only entity directory that loaded at all. Declared directories canonicalize to `/`-joined repo-relative paths, but the containment check built its prefix with the platform separator (`\` on Windows), so no nested path ever matched. The lexical profile-path checks now compare POSIX paths directly; native path confinement is unchanged. Reported and diagnosed by @squ1ddy (#163).

- **Windows: broken links in the generated wiki index** — the same separator bug on the output side. Entity-page links in `wiki/index.md` are built from `path.relative`, which emits `\` on win32, so a NESTED entity directory produced the unusable link `research\papers/foo.md`. Link targets are now normalized to POSIX. Single-level directories were unaffected, which is why this went unnoticed (#163).

- **Windows: native separators in public problem paths** — the same separator bug one layer further out, on the reported-problem surface. `EntityProblemView.path` is documented as project-relative portable content, but both producers returned `path.relative` output raw, so on win32 `llmwiki status`, the viewer, context packs, and the JSON export reported `wiki\notes\untitled.md` where the contract promises `wiki/notes/untitled.md`. Both now normalize to POSIX. The regression gate was widened to match: instead of naming the two symbols the first fix touched, it now requires every `path.relative` in the lexical profile layer to be routed through `toPosixPath` (#163).

- **`npm test` could not run on Windows at all** — vitest's global setup shelled out to `npx`, which is `npx.cmd` there and has not been resolvable by `child_process` without `shell: true` since the Node 22 hardening for CVE-2024-27980. The setup threw, collection aborted, and vitest reported the unrelated "No test files found". It now invokes the build directly with the running Node binary, needing no shell on any platform.

- **Embedding store dimensions after a full rebuild** — when the embedding model changed, the rebuilt store carried the previous vector dimension forward, so switching to a provider whose vectors have a different dimension failed validation on every subsequent compile and never recovered. The rebuilt store now takes its dimension from the newly written vectors.

- **A rebuilt-but-empty embedding index broke every query** — a rebuild with nothing eligible to embed persisted a store declaring `dimensions: 0`, and each later query asserted its query vector against that zero and threw. No compile rewrote the store, so it never recovered. A non-positive stored dimension is now treated as unknown, and a read with no candidates returns before embedding the query at all — which also drops a provider round-trip that could only be scored against an empty pool.

- **`OPENAI_EMBEDDINGS_API_KEY` was accepted at startup and then ignored** — the embeddings client was built only when `OPENAI_EMBEDDINGS_BASE_URL` was also set, so a configuration supplying just the dedicated key passed validation and then authenticated with the chat client's placeholder credential, failing later as a 401. The dedicated client is now built whenever either the endpoint or the key is configured.

- **A misconfigured `LLMWIKI_EMBEDDING_PROVIDER` failed late and inconsistently** — validation ran inside the embedding call, so the same typo made `llmwiki query` exit 1, made context retrieval degrade, and made compile warn, retry, and eventually quarantine the affected pages. An unusable name also fell through to the default model and was reported as "the index was built with a different model", which described the wrong problem. The provider guard now checks it at startup, before any work begins, alongside the chat provider's credentials.

## [1.1.0] - 2026-07-15

Adds a security-first template distribution ecosystem — publishers sign and distribute profile templates offline, and consumers discover, install, update, and verify them through explicitly trusted taps — plus a guided path for authoring a first profile and the `llmwiki status` command. Every addition is opt-in; projects that do not use templates, taps, or profiles are unaffected.

### Added

- **Guided profile authoring** — `llmwiki profile init <profile-id> --entity <type>` scaffolds the smallest useful editable profile and a typed page. It validates before writing, serializes concurrent project mutations, and refuses to reinterpret an existing profile or typed corpus. There is no force mode, and a failed scaffold cleans up only the directories it created. A new "Build your first profile" guide and an interactive profile explorer teach the workflow end to end.
- **Template lifecycle and signing foundations** — template status and read-only update planning with exact historical release resolution, local-drift detection, profile-identity protection, and compatibility audits across pages, artifacts, review history, and workflow state. Update plans are advisory and re-verified under lock. Ed25519 signing and provenance underpin the distribution surfaces below.
- **Signed template taps and remote discovery** — configure explicitly trusted template taps, refresh signed catalogs, and search, inspect, and verify signed package evidence without installing or changing a profile. The tap layer is read-only and network-facing, with exact-origin fetch confinement, continuity state, and cache re-verification.
- **Secure remote install and update** — install, inspect, and update signed templates discovered through taps. Packages resolve from cryptographically verified tap evidence; identity and revocation are rechecked under lock before any mutation; non-interactive installs require explicit consent; and updates refuse incompatible corpus changes, local profile drift, pending review candidates, and active workflow runs.
- **Template publisher workflow** — `llmwiki template publish init | add | build | rotate | revoke` builds signed, verifiable, offline distributions. Private keys are exclusively created, stored `0600`, read no-follow, and never leave the workspace or appear in the manifest. `build` verifies the whole distribution as a consumer would before publishing and commits the sequence last, so a crash leaves the workspace at its prior sequence. `--refresh` renews an expiring index under a fresh lifetime, and a key rotation re-signs every package while content-addressed filenames never change. The output directory must live outside the workspace and be empty or a prior distribution of the same tap.
- **Offline publisher verification** — `llmwiki template publish verify <directory>` verifies a signed distribution using the production tap-index and package parsers and Ed25519 verification with an independently selected tap key.
- **`llmwiki status` command** — a readable snapshot of page and source counts, last compile time, stale and orphaned pages, pending changes, the review queue, active profile, and state-file health, with a next-command hint on each problem line. The status snapshot was previously reachable only over MCP (`wiki_status`) and the SDK (`status()`).

## [1.0.0] - 2026-07-10

Introduces Configurable Lifecycle Profiles (CLP): declarative, fail-closed domain packs that turn llmwiki from a fixed two-directory compiler into a reusable substrate for typed entities, relations, lifecycle gates, workflows, artifacts, connectors, and installable templates. Projects without a profile retain the pre-CLP default behavior byte-for-byte across the guarded surfaces.

### Added

- **Configurable Lifecycle Profiles** — `.llmwiki/profile.json` can declare typed entity directories, field contracts, retrieval policy, relation types, lifecycle state machines, transition evidence, content tiers, workflows, actions, artifact types, and connector bindings. The same validated profile drives CLI, SDK, MCP, status, lint, context, viewer, and export behavior without domain-specific branches in core.
- **Typed relations and lifecycle gates** — append-only typed relations, endpoint validation, standing drift checks, relation-count preconditions, evidence requirements, and artifact-reference requirements are enforced on every state-entry write surface and surfaced again by read-side health checks.
- **Workflow harness and actions** — declared workflows run through start, advance, status, submit, gate approval, fail, resume, cancel, adapt, event history, and derived projections. Page, relation, lifecycle-transition, and artifact outputs share the same trust and typed-validation floors.
- **First-class artifacts** — profile-declared JSON and text artifacts are confined, size-capped, schema-validated, hash-pinned, journaled, and referenceable from typed fields. CLI and SDK writes require trusted authority; MCP verification exposes health and manifest metadata without artifact bodies.
- **First-party connector substrate** — compiled-in connectors stage typed review candidates through a hardened network boundary with host allowlists, DNS/IP confinement, redirect and decompression limits, content fencing, host-computed provenance, idempotency, rate limits, and review-time body-hash pinning. The AutoSci template ships with the Crossref DOI connector.
- **Profile-aware OKF exchange** — OKF export carries profile and relation data, while import routes typed pages and relations through the profile-aware planner instead of bypassing field, lifecycle, trust, or artifact gates.
- **Profile templates** — `llmwiki template list|inspect|init` installs validated declarative packages without adding template resolution to the profile loader. `autosci` and `newsroom` ship as built-in examples; local template files use the same fail-closed validator. Template locks are advisory provenance only and never grant authority.
- **AutoSci and Newsroom packs** — AutoSci provides a practical research workflow with 12 entity types, 12 relations, five workflows, seven artifact types, and Crossref import. Newsroom provides a deliberately dissimilar editorial workflow that demonstrates the same substrate outside research.
- **Richer eval diagnostics** — eval reports now include a per-page health distribution for locating the weakest pages and graph-health metrics for connectivity, isolation, and relation structure.
- **Batch embeddings** — page and chunk embeddings use provider-native batches with bounded sub-batches, integrity checks, transient retry and sequential fallback behavior, provider-specific document/query intent, and optional strict failure handling through `LLMWIKI_EMBED_STRICT`. `LLMWIKI_EMBED_BATCH_SIZE` controls batch size within provider caps.
- **Parallel compilation** — concept extraction and page generation share a configurable concurrency cap. Use `--concurrency <n>` or `LLMWIKI_COMPILE_CONCURRENCY`; the CLI, refresh/watch/quickstart paths, and SDK compile options use the same bounded setting.
- **Verbose command diagnostics** — `--verbose` and `LLMWIKI_VERBOSE` expose per-step detail for compile, refresh, ingest, query, context, quickstart, import, and export while preserving JSON stdout purity and quiet-mode precedence.
- **Crash-visible compile recovery** — generated page mutations are journaled and applied as bounded batches. Incomplete compiles surface across status, lint, viewer, export, context, and SDK reads, and `llmwiki recover` can restore the recorded pre-state without rerunning compilation.
- **`llmwiki state reset`** — a recovery command for a `.llmwiki/state.json` written by a newer llmwiki version. It backs the file up to `state.json.bak` and removes it so the next compile starts fresh. It refuses by default and prints what it will do; pass `--yes` to apply. The reset works even on an unreadable too-new or corrupt state file.
- **Typed-page semantic search** — typed entity pages (e.g. `papers/my-paper`) are now embedded under their qualified `<entityType>/<slug>` id and participate in `query`, MCP/SDK search, and agent context packs alongside concepts and queries. A concept `foo` and an entity page `papers/foo` no longer share an embedding key and can no longer collide.
- **`retrieval.includeInSearch` / `retrieval.includeInContext` enforcement** — an entity type that opts out of both flags is never sent to the embedding provider and never appears in semantic search results. This acts as a per-type privacy and cost control: pages whose type declares `retrieval.includeInSearch: false` are excluded from the embedding index, and pages whose type declares `retrieval.includeInContext: false` are excluded from agent context packs entirely.

### Changed

- Compile now confines the wiki files it reads back into LLM prompts and page bodies. Wiki content must resolve UNDER the project root: a wiki file (`wiki/index.md`, `wiki/concepts/<slug>.md`, `wiki/queries/<slug>.md`) that is a symlink whose target escapes the project root is unsupported. It is dropped — never read, never sent to an LLM provider, never re-emitted into a written page — its escaping path is named in a prominent warning, and the read proceeds as if the file were absent (extraction uses an empty index; seed/resolution/index generation/MOC skip the page). An escaping-symlink wiki file is never silently followed; remove or retarget the symlink so its content lives under the project root to compile that file.
- llmwiki now fails closed when `.llmwiki/state.json` was written by a newer llmwiki version: instead of risking a misread or overwrite of a forward-incompatible layout, commands report a clear error. Use `llmwiki state reset --yes` to back up and reset the file, or upgrade llmwiki to read the project as-is.
- The embedding index format advances from v2 to v3, adding the qualified-key layout required for typed-page embeddings. The upgrade runs automatically on the next `compile` (or any embedding-writing command). Until the upgrade runs, semantic search reports an "embedding index outdated — run compile" notice while lexical search continues to work unchanged.
- Failed or interrupted embedding refreshes now persist a bounded per-page retry list that drains on subsequent compile, review-approval, and OKF-refresh paths. Pending or unreadable refresh state is surfaced by status and lint instead of being silently dropped.
- Eval health scoring now uses the canonical lint rule set. Stale pages therefore reduce `health.score` when freshness data is available; projects that gate on `health_score` may observe a lower score until stale pages are refreshed.
- Production discovery now lists only connectors explicitly marked as template-installable; the internal offline fixture connector remains available to substrate tests but is not presented as a user-facing integration.
- Parser, sanitizer, MCP, viewer, and test-tool dependencies were updated to patched releases; the release dependency audit reports zero known vulnerabilities.

### Fixed

- **Ollama structured tool calls** — Ollama now uses its native `POST /api/chat` JSON-schema format for concept extraction and other structured calls instead of the OpenAI-compatible tool-call path that could double-encode arrays and silently produce no pages. Reverse-proxy path prefixes, timeout handling, invalid hosts, HTTP failures, and empty responses are handled explicitly; defensive concept parsing also accepts string-encoded arrays.
- **Bare-number citations** — compile repairs unambiguous in-range markers such as `^[81]` to include their source filename and drops ambiguous or hallucinated bare line numbers before writing a page, preventing broken `Source not found: 81` callouts.

### Security

- Profile loading, connector ingestion, artifact storage, workflow outputs, typed OKF import, event journals, and template installation fail closed on malformed, unreadable, escaping, or unverifiable state.
- Connector-fetched and non-built-in template content is treated as untrusted data. Connector output is staged, fenced on agent-facing surfaces, and cannot become live without review and a hash pinned to the exact reviewed body.
- The default profile remains the implicit no-file behavior. Templates are install-time materialization only; advisory template metadata cannot skip profile validation or elevate write authority.
- npm releases use GitHub OIDC Trusted Publishing, check out an explicit public commit, verify version and documentation consistency, refuse existing versions, run build/test/package gates, and confirm the published package's `gitHead` without a long-lived npm token.

### Contributors

Thanks to **@dohu012** for contributing the per-page health distribution and graph-health additions to the eval harness in PRs #96 and #140, and to **@JulianKominovic** for the Ollama native structured-tool-call fix in PR #145.

## [0.11.0] - 2026-06-16

Extends Open Knowledge Format support beyond the CLI: in-process SDK and MCP access to the OKF round-trip, and faithful reconstruction of an imported foreign bundle's original nested paths on re-export.

### Added

- **OKF SDK access** — `createWiki().exportOkf({ out? })` and `importOkf(dir, { dryRun?, trusted? })` run the OKF export/import round-trip in-process and return structured reports, with warnings and skips surfaced as data rather than console output. `OkfExportReport` and `OkfImportReport` are exported from the package types.
- **OKF MCP tools** — `llmwiki serve` now registers `export_okf` and a staging-only `import_okf`, bringing the server to 11 tools. `import_okf` previews a bundle with `dryRun` or stages it as review candidates; it exposes no trusted live-write path to agents, and its bundle path is confined under the project root.
- **Nested-path reconstruction on OKF re-export** — imported foreign OKF pages re-export at their original bundle-relative path (for example `tables/customers.md`) instead of `concepts/<slug>.md`, and native-to-foreign links round-trip. Paths that are unsafe, URL-unsafe, non-`.md`, reserved, escaping, or contested fall back to the slug path with a warning.

### Changed

- OKF link reversal now restores `[[wikilinks]]` from any bundle-relative `.md` link that resolves to a known imported page, not only `concepts/` and `queries/` slug links.
- OKF export refuses dangerous output targets — the filesystem root, the project root, directories inside `.git`, and non-empty directories that are not already OKF bundles — before writing, and wholesale-clears a recognized prior bundle while refusing any nested `.git`. All bundle writes are realpath-confined to the output directory.

### Contributors

No external contributors in this release.

## [0.10.0] - 2026-06-14

Adds a review-policy gate for generated knowledge, a full Open Knowledge Format (OKF) export/import round-trip, and a Mintlify documentation site.

### Added

- **Review policy** — `.llmwiki/config.json` can now hold risky generated pages for review during normal `compile` and `refresh --stale` runs. Policies can hold low-confidence, contradicted, schema-violating, provenance-violating, or all pages. Held candidates record structured reasons, and `review list` / `review show` surface those reasons for reviewers.
- **Open Knowledge Format export** — `llmwiki export --target okf [--out <dir>]` writes an OKF-style bundle with `index.md`, per-page `concepts/` and `queries/` docs, copied cited references, and a date-grouped `log.md`. OKF export is opt-in because it writes a directory bundle rather than a single file.
- **Open Knowledge Format import** — `llmwiki import --okf <dir> [--dry-run] [--trusted]` reads OKF bundles. The default path stages imported pages as review candidates; `--dry-run` previews the plan without writes; `--trusted` writes valid pages directly into `wiki/` for bundles you already trust.
- **OKF re-export honesty** — imported foreign OKF pages preserve raw foreign `type` values and producer-specific frontmatter while refreshing llmwiki's own `x-llmwiki` metadata. Re-export derives standard fields such as title, description, tags, and timestamp from the current page so local edits are reflected.
- **Mintlify documentation site** — product documentation now lives under `docs/`, with dedicated pages for getting started, CLI commands, core concepts, configuration, guides, and troubleshooting.

### Changed

- OKF import marks imported pages with durable imported provenance, including an `okf:<bundle>` source token, original OKF path, and original OKF frontmatter snapshot.
- The review queue now supports imported candidates in addition to forced and policy-held candidates.

### Fixed

- The committed `node_modules` symlink was removed from the repository, so fresh clones and worktrees can use a normal `npm ci` install without inheriting a missing parent-level dependency tree.

### Contributors

No external contributors in this release.

## [0.9.0] - 2026-06-08

Adds an end-to-end source-freshness loop — detect stale pages, surface them everywhere, and repair them with a targeted recompile — plus an in-process SDK with source-backed write APIs, a JSON export bridge contract for downstream importers, richer eval metrics, rule-candidate extraction, and a local-login Claude Agent provider.

### Added

- **Source freshness** — `llmwiki lint` flags pages whose sources changed (`stale`) or were all deleted (`orphaned`) since the last compile, computed on demand from `.llmwiki/state.json` and the current `sources/`. Freshness is surfaced across MCP (`wiki_status` stale/orphaned lists and a `stateStatus` field, plus `get_context_pack`), context packs (per-page `freshnessStatus`/`contradicted`/`archived` and a `stale-page` warning), the local viewer (STALE/ORPHANED/CONTRADICTED/ARCHIVED badges, a per-axis filter, health-pane counts, and a corrupt-state banner), the JSON export, and `llmwiki next`.
- **`llmwiki refresh --stale [--dry-run]`** — a targeted recompile that repairs stale/orphaned pages by recompiling their changed owning sources and cleaning up deleted owners, while deliberately skipping unrelated new sources. `--dry-run` previews the plan with no LLM calls and no writes; cleanup-only refreshes require no API key.
- **JSON export bridge contract** — `llmwiki export --target json --project-id <id>` adds per-page `path`, `kind`, advisory confidence/provenance, flattened citations, aliases, and freshness so downstream importers (e.g. [`@atomicmemory/llmwiki`](https://github.com/atomicstrata/atomicmemory/tree/main/packages/llmwiki)) can ingest pages as durable memory records.
- **Eval over MCP** — a `run_eval` MCP tool (the fast suite needs no API key; the full suite LLM-judges a sample of citations), plus read-only `llmwiki://eval/report` and `llmwiki://eval/history` resources.
- **Eval source-utilization metrics** — source-utilization and citation-depth dimensions, surfaced source warnings, a frame-safe report, and a `source_warnings_max` CI gate.
- **Rule-candidate extraction** — extract reusable rule candidates from sources with review/approve and a JSON export pipeline.
- **In-process SDK** — `createWiki()` exposes the compiler in-process, with source-backed write APIs (`writeStatus`, `listSources`/`getSource`/`deleteSource`) for programmatic callers.
- **Claude Agent SDK provider** — a provider that authenticates through a local Claude Code login and uses bundled plan tokens, so no separate API key is required.
- **Alias-aware wikilinks** — the viewer resolves a `[[term]]` link to any page that declares `term` in its `aliases` frontmatter, not just an exact slug match.
- **Append-only activity journal** — an append-only `log.md` records ingest, compile, review, and export activity.

### Changed

- Upgraded core dependencies — zod 3 → 4, openai 4 → 6, and `@anthropic-ai/sdk` 0.39 → 0.101 — and bumped the default model to `claude-sonnet-4-6` (the previous default was deprecated).

### Fixed

- Three read-only paths (`wiki_status`, the `llmwiki://state` MCP resource, and the viewer startup snapshot) no longer write a `.bak` file when `.llmwiki/state.json` is corrupt; corrupt and missing state are now surfaced explicitly instead of being swallowed.
- `wiki_status` derives pending source changes from the freshness snapshot instead of running a redundant second source-hash pass.

### Contributors

Thanks to **@alvins82** for the Claude Agent SDK provider (#81) and the append-only activity journal (#85), **@dohu012** for source-utilization and citation-depth eval metrics (#86), and **@joshuaknipe** for the `run_eval` MCP tool and eval resources (#74).

## [0.8.0] - 2026-05-26

Adds guided project next steps, one-command quickstart, agent-ready context graph packs, a viewer graph route, and the first eval harness for measuring wiki quality over time.

### Added

- **`llmwiki next`** — inspects the current project and recommends the next useful command. Human output is concise; `--json` emits a stable envelope for agents.
- **`llmwiki quickstart <source>`** — ingests one source, compiles the wiki, and opens the local viewer when pages are ready. Supports `--review`, `--no-open`, `--provider`, `--lang`, and `--json`.
- **`llmwiki context "<prompt>"`** — builds an agent-ready evidence pack with primary pages, semantic chunks when available, graph neighbors, citations, gaps, warnings, and suggested actions. `--include-sources` can add path-confined source windows.
- **MCP `get_context_pack`** — exposes the same v1 context-pack envelope over MCP. It packages evidence for agents; `query_wiki` remains the answer-generation tool.
- **Viewer graph route** — the local web viewer now includes a force-directed graph at `#/graph`, plus navigation polish so graph/page/sidebar state stays in sync.
- **`llmwiki eval`** — measures wiki health score, citation coverage, citation precision, corpus stats, regression deltas, and optional LLM-as-judge citation support. Includes `eval report`, `eval history`, `eval judgements`, and `eval cache` subcommands.
- **Eval thresholds** — `.llmwiki/eval/thresholds.yaml` can gate health, citation coverage, citation precision, and full-suite citation support scores in CI.

### Fixed

- **Pipe-alias wikilinks** — `[[slug|Display Text]]` is now detected correctly by lint and viewer link tooling.
- **Source-path confinement in eval** — citation-support judging resolves source paths through a shared confinement helper, including encoded traversal edge cases.
- **Eval cache invalidation** — citation judgements include judge configuration in the cache key, so changing model/provider settings re-judges affected claims instead of reusing stale scores.
- **Sample validation in eval** — invalid `--sample` values fail loudly instead of falling through to surprising sampling behavior.
- **Contributor docs** — upstream remote setup now points at the current `atomicstrata` GitHub org.

### Changed

- **Fallow upgraded to 2.82.0** with follow-on code-health cleanup across CLI, viewer, adapters, watch, and tests. The CI action is pinned to the matching signed release so binary verification uses embedded platform digests rather than unauthenticated GitHub API lookups.

### Test infrastructure

- Hardened the basename-collision CLI tests with explicit timeouts.
- Hardened local Vitest timeouts for subprocess-heavy integration tests.
- Changed the npm publish preflight to run release-doc checks, build, and a dry-run package check; the full test suite remains enforced by CI.
- Added coverage for quickstart/next JSON envelopes, context packs, MCP context packs, graph rendering, eval reports/history/cache/thresholds, and release-doc checks.

### Contributors

Thanks to **@joshuaknipe** for a major release's worth of contributions: pipe-alias wikilink fixes (#61), upstream docs cleanup (#62), the viewer graph route (#63), and the eval harness with health scoring, citation quality, and corpus stats (#67).

## [0.7.0] - 2026-05-18

Adds the first local web viewer for compiled wikis, a GitHub Copilot provider, and a persisted lint summary that lets the viewer report wiki health without re-running lint on every page load.

### Added

- **`llmwiki view`** — starts a local read-only web viewer for the current project. The viewer includes a sidebar grouped by concepts and saved queries, a dashboard home, markdown rendering, wikilinks, title/body search, page metadata, health counts, and provenance/citation support rails.
- **Citation chips in the viewer** — paragraph citations and claim-level source ranges render as visible chips. On loopback binds, chips can include local editor links for source-line context; LAN binds omit filesystem paths and editor links.
- **Secure-by-default local server** — `view` binds to `127.0.0.1` by default, uses an OS-assigned port unless `--port` is provided, and requires `--host <host>` and `--allow-lan` together before binding beyond loopback. The server applies pinned CSP / CORP / nosniff / referrer headers, Host / Origin / Sec-Fetch checks, and path confinement for all served files.
- **Viewer health payload** — `/api/health` exposes cheap project counts, pending review count parity with MCP `wiki_status`, and the latest cached lint summary when available.
- **GitHub Copilot provider** — `LLMWIKI_PROVIDER=copilot` uses the GitHub Copilot API with `GITHUB_TOKEN=$(gh auth token)` from an OAuth token that has the `copilot` scope. Copilot supports chat/tool calls but does not expose embeddings, so embedding-dependent semantic search should use another provider.

### Changed

- **`llmwiki lint` now writes `.llmwiki/last-lint.json`** after each completed lint run so the viewer can show a recent lint summary without running lint on every page load.
- **Shared wiki page collection** — export and viewer collection now share the lower-level wiki collector while preserving each surface's own filtering and payload shape.

### Test infrastructure

- Added subprocess, path-safety, sanitizer, accessibility, JS DOM, pack-asset, and server-security coverage for the viewer. Tests grew from 632 to 850 in this release.

### Contributors

Thanks to **@cadamsdev** for contributing the GitHub Copilot provider in PR #55.

## [0.6.0] - 2026-05-02

Adds session-history ingest (Claude / Codex / Cursor exports), configurable output language, and a defensive cap that prevents `compile` from crashing on popular concepts. Closes a batch of CJK / collision / silent-loss bugs in the ingest path. Tightens `compile --review` so candidates carry both schema AND provenance lint findings before approval. Extracts a shared `ProvenanceMetadata` shape and removes an unreliable LLM extraction-time estimate in favour of body-derived counts.

### Added

- **`llmwiki ingest-session <path>`** — imports AI coding-session exports as wiki sources. Auto-detects three formats: Claude (`.jsonl`), Codex (`.json`), Cursor (`.json`, both `tabs` and flat schemas). Single file or whole directory. Each session lands in `sources/<slug>.md` with frontmatter recording the adapter, source path, ingest timestamp, and (where available) session start/end times. Adapter validation requires ≥ 1 user-or-assistant turn — recognised-but-empty exports fail loudly instead of producing a content-free page.
- **`LLMWIKI_OUTPUT_LANG` env var + `--lang <code>` CLI flag** on `compile` and `query`. When set, every prompt builder (extraction, page generation, seed page, query answer) appends `Write the output in <lang>.` to the system prompt. Unset preserves current behaviour byte-for-byte. Useful for `--lang Chinese`, `--lang Japanese`, etc.
- **`compile --review` provenance lint** — review candidates now carry both `schemaViolations` and `provenanceViolations` (malformed claim citations, broken-source / out-of-bounds line spans). `review show` prints both blocks. Reviewers see citation issues before approving a page rather than discovering them on a later compile.
- **`npm run fallow:ci`** — contributor script that runs `fallow` with the same `--changed-since <PR-base-sha>` scoping the GitHub Action uses, so most CI fallow findings surface locally before pushing. Documented in CONTRIBUTING.md (including the fork-workflow `upstream/main` resolution and the platform-binary parity caveat).

### Fixed

- **Non-ASCII filename ingest** (#35) — `slugify` previously used `\w` without the `/u` flag, so titles like `测试文档` collapsed to the empty string and `ingest` wrote `sources/.md` (a dotfile that subsequent CJK ingests would overwrite). `slugify` now uses Unicode property escapes (`\p{L}`, `\p{N}`); pure-emoji titles that still strip to `""` fail with an actionable error rather than writing a dotfile.
- **Same-basename source collision** (#36) — two distinct sources slugifying to the same name (e.g. `a/notes.md` and `b/notes.md`) used to silently overwrite. `saveSource` now checks for the collision and falls through to `<slug>-<8-hex-of-source>.md` when the existing file's frontmatter `source` doesn't match. Re-ingesting the same source still overwrites in place — no duplicate accumulation.
- **Compile crash on popular concepts** (#39) — `mergeExtractions` used to concatenate every contributing source's full content into the page-generation prompt. Linear in source count; reliably blew past the LLM provider's context window once many sources discussed the same topic. New defensive cap (`LLMWIKI_PROMPT_BUDGET_CHARS`, default 200,000) gives every contributing source a fair share of the budget when the raw total would overflow, with a clear truncation marker. Typical workloads stay byte-identical.
- **Body-derived `excess-inferred-paragraphs`** — the lint rule used to trust an LLM-estimated `inferredParagraphs` frontmatter field when present, falling back to body counting. The estimate was made before the page even existed and routinely disagreed with what the model actually produced. The rule now unconditionally counts uncited prose paragraphs in the rendered body, with Unicode-aware prose detection (`\p{L}`) so pages produced via `--lang Chinese` etc. are correctly counted. Legacy `inferredParagraphs` frontmatter values are intentionally ignored.

### Changed

- **`ProvenanceMetadata` is now a single shared interface** in `src/utils/types.ts` that both `ExtractedConcept` and `WikiFrontmatter` extend. Drops the duplicate private declaration that had drifted into `src/utils/markdown.ts`. JSON shapes serialised on disk and over the LLM tool boundary are byte-identical to before — pure refactor.
- **`inferredParagraphs` is no longer written to frontmatter or sent to the LLM extractor**. The field has moved entirely to body-derived lint at lint time. Old on-disk pages with the field still parse — the loader just ignores the unrecognised key.
- **`CompileResult.pages` now includes seed-page slugs** alongside concept-page slugs. Seed pages used to land on disk silently and stay absent from the result; downstream consumers (MCP, embeddings, programmatic callers) had no way to discover them without scanning `wiki/`. They're also threaded into `finalizeWiki` so `resolveLinks` and `updateEmbeddings` cover them.
- **Lint helper dedupe** — `checkSchemaCrossLinks` (on-disk walker) now delegates to `checkPageCrossLinks` (per-page) so the `schema-cross-link-minimum` rule lives in exactly one place.

### Test infrastructure

- **`useIngestWorkspaces` and `useAimockLifecycle.findSystemPromptByUserMessage`** composables in `test/fixtures/` consolidate temp-workspace and aimock recording boilerplate that had drifted across multiple integration tests.
- Tests grew from 480 (post-0.5.1) to 632 in this release.

### Contributors

Thanks to **@lllcccwww** for filing four high-quality bug reports back-to-back (#35, #36, #37, #39) — every one had a clear repro and pointed at the offending file:line, which made the fixes obvious. Also thanks to **@babysource** for asking about embedding configuration (#42) and **@ishan5ain** for volunteering to take on the read-only Web UI roadmap item (#38).

## [0.5.1] - 2026-04-27

Patch release fixing a CLI startup crash that broke 0.5.0 for everyone installing via npm.

### Fixed

- **Startup crash on `llmwiki <any-command>`** — 0.5.0 imported `youtube-transcript/dist/youtube-transcript.esm.js` (a deep subpath that worked around a broken `main` entry in v1.3.0). v1.3.1 added a proper `exports` map that no longer exposes that subpath, so any `npm install -g llm-wiki-compiler@0.5.0` produced `ERR_PACKAGE_PATH_NOT_EXPORTED` on first command. Switched to importing from the package root (which the new `exports` map covers) and bumped `youtube-transcript` to `^1.3.1`.

### Contributors

Thanks to **@lllcccwww** for reporting (#33) and **@ishan5ain** for the fix (#34) — both very fast turnarounds.

## [0.5.0] - 2026-04-27

Adds multimodal ingest (images, PDFs, transcripts) and chunk-level semantic retrieval with reranking and a `--debug` view. Also raises the minimum Node version to 24 so the project can use modern test-mocking tooling that depends on Node 24+ APIs.

### Added

- **Multimodal ingest** — `llmwiki ingest` now accepts images (vision via the active LLM provider), PDFs (text + metadata via lazy-loaded `pdf-parse`), and transcripts (`.vtt`, `.srt`, plus content-sniffed `.txt` that requires repeated speaker dialogue or anchored timestamps so plain notes aren't misclassified). Each source records its `sourceType` in frontmatter (`web` | `file` | `image` | `pdf` | `transcript`). YouTube transcript URLs are auto-routed.
- **Chunk-level semantic retrieval** — the embedding store gained an optional v2 `chunks` schema. Pages are split on paragraph + heading boundaries (with size guardrails), embedded individually, and reused across compiles when their content hash hasn't changed. Query routing prefers chunk hits, falls back to page-level retrieval and full-index selection.
- **BM25 reranking** over chunk candidates, blending 0.5x cosine similarity with BM25 score so semantic ranking still matters when the query has no overlapping terms.
- **`llmwiki query --debug`** prints the top chunks (slug, score, snippet) and pages selected, so users can audit retrieval decisions. The MCP `query_wiki` tool accepts a `debug` arg too.
- **Empty-store cold-start** — an empty v1 or v2 store with live wiki pages now triggers a full chunk embedding on next compile (previously, embeddings would only update when an existing slug changed).
- **`@copilotkit/aimock` test infrastructure** with `mockClaudeEnv` / `mockOpenAIEnv` / `useAimockLifecycle` helpers. CLI subprocess tests can now stub LLM endpoints deterministically — closes the recurring "no subprocess test for the compile/query happy path" gap that codex flagged across review-queue, schema-layer, confidence-metadata, and chunked-retrieval.

### Changed

- **Minimum Node version raised from 18 to 24.** `engines.node` is `>=24`, the tsup target is `node24`, and CI runs only on Node 24. Users on older Node should pin to `<0.5.0` until they can upgrade their runtime.
- `pdf-parse` is dynamically imported so the cost of loading pdfjs-dist is paid only when a PDF is actually being ingested.

### Test infrastructure

- New `runCLI` / `expectCLIExit` / `expectCLIFailure` / `formatCLIFailure` helpers in `test/fixtures/run-cli.ts` capture full subprocess diagnostics (code, signal, killed, message, stdout, stderr, args, cwd) on assertion failure — flakes now surface their root cause without rerunning.
- `vitest globalSetup` builds dist once before the suite runs, eliminating the per-test `tsup --clean` race that caused intermittent CI flakes.
- Tests grew from 391 to 477 in this release (and to 519 once export-bundle lands as a follow-up).

## [0.4.0] - 2026-04-25

Adds claim-level source-range provenance, a first-class schema layer for typed page kinds, configurable provider request timeouts, and a slug-based wikilink format that resolves reliably in Obsidian.

### Added

- **Claim-level provenance with source ranges** — citations can now pin specific lines: `^[paper.md:42-58]` (colon form) or `^[paper.md#L42-L58]` (GitHub anchor form). Single-line `^[paper.md:7]` works too, as do mixed multi-source markers like `^[a.md, b.md:1-3]`. The legacy paragraph form `^[paper.md]` continues to work unchanged.
- **`extractClaimCitations(body)`** returns structured `{ raw, spans: [{ file, lines? }] }` records for tooling. **`inspectProvenance(body)`** groups spans by source file (deduped), useful for "this page draws from" UIs.
- **`checkBrokenCitations`** lint rule now flags out-of-bounds spans (e.g. `^[src.md:42-58]` against a 3-line source) with cached per-file line counts so a page with many spans into the same source only reads it once.
- **`checkMalformedClaimCitations`** new lint rule catches malformed entries: non-numeric ranges (`:abc-xyz`), half-baked hash forms (`#X9`), line `0`, and reversed ranges (`5-3`). Semantic invalidity is rejected at parse time so `extractClaimCitations` doesn't return impossible spans.
- **First-class schema layer** for typed page kinds. Projects can declare `.llmwiki/schema.json|yaml|yml` (or `wiki/.schema.yaml|yml`) defining page kinds (`concept`, `entity`, `comparison`, `overview`), per-kind `minWikilinks`, and seed pages.
- **`llmwiki schema init`** writes a starter schema file. **`llmwiki schema show`** prints the resolved schema and its source path.
- **`schema-cross-link-minimum`** lint rule enforces per-kind link expectations.
- **Schema-driven seed pages** are generated during compile and run on the early-return path too, so adding a seed-page entry triggers its creation on the next `compile` even when no source files changed.
- **Review-mode schema violations** — `compile --review` runs in-memory schema lint per candidate and stamps any violations onto the candidate JSON. `review show <id>` prints a "Schema violations" block when present.
- **Configurable provider request timeouts** — `LLMWIKI_REQUEST_TIMEOUT_MS` (provider-agnostic) and `OLLAMA_TIMEOUT_MS` (Ollama-specific) override the per-request timeout. Defaults: 10 minutes for OpenAI (matches the SDK), 30 minutes for Ollama (better suited to local models).
- **Slug-based wikilinks** — index, MOC, and the in-body wikilink resolver now emit `[[slug|Title]]` so Obsidian targets the file directly regardless of whether the slug differs from the display title.
- **Test infrastructure for subprocess CLI tests** — `runCLI`/`expectCLIExit`/`expectCLIFailure`/`formatCLIFailure` helpers in `test/fixtures/run-cli.ts` capture full subprocess diagnostics (code, signal, killed, message, stdout, stderr, args, cwd) so flakes surface their root cause without rerunning. dist/ is built once via `vitest globalSetup` so parallel workers don't race on `tsup --clean`.

### Changed

- `extractCitations(body)` continues to return a flat filename list for backward compatibility, but is now backed by `extractClaimCitations` and strips span suffixes when collecting filenames.
- `WikiFrontmatter.kind` references the canonical `PageKind` type from `src/schema/types.ts` via `import type` (no runtime cycle).
- `compile --review` defers seed-page generation and `finalizeWiki` to honor the no-`wiki/`-mutation contract.

### Contributors

Thanks to **@ludevica** for #15 (slug-based wikilinks) and **@BenGSt** for reporting the Ollama timeout (#11).

## [0.3.0] - 2026-04-23

Adds a candidate review queue for `compile` and richer epistemic metadata on compiled pages.

### Added

- **Candidate review queue** — `llmwiki compile --review` writes generated pages to `.llmwiki/candidates/` instead of mutating `wiki/`. New subcommands `llmwiki review list|show|approve|reject` let you inspect each candidate before it lands. `approve` writes the page and refreshes index/MOC/embeddings; `reject` archives the candidate to `.llmwiki/candidates/archive/`. MCP `wiki_status` exposes `pendingCandidates` so agents can see queue depth.
- **Confidence and contradiction metadata** — compiled pages can carry optional frontmatter fields (`confidence`, `provenanceState`, `contradictedBy`, `inferredParagraphs`). When multiple sources merge into one slug, metadata is reconciled (`min` confidence, `provenanceState = 'merged'`, union of `contradictedBy` deduped by slug, `max` `inferredParagraphs`).
- **Three new lint rules** surface the new metadata: `low-confidence`, `contradicted-page`, `excess-inferred-paragraphs`.
- **Multi-source citation parsing in lint** — `^[a.md, b.md]` now validates each filename independently and only reports the missing one(s).
- **Husky pre-commit and pre-push hooks** — pre-commit runs `fallow` + `tsc --noEmit`; pre-push runs `npm run build` + `npm test`. Devs get fast feedback on commit and full validation before push.

### Changed

- Pre-commit/pre-push hooks pin `fallow` to `2.42.0` locally (devDep) and in CI to keep complexity thresholds stable across the team.
- `compile`'s page rendering extracted into `src/compiler/page-renderer.ts` so both direct writes and candidate generation reuse the same renderer.
- `vitest.config.ts` excludes `.claude/**` so `npm test` from the main checkout doesn't discover sibling worktrees.

### Concurrency

- `review approve` and `review reject` acquire `.llmwiki/lock` (the same lock `compile` uses) and re-read the candidate under the lock to close the TOCTOU window between pre-check and mutation.
- When one source produces multiple candidates, source state isn't persisted until the last sibling is approved — unresolved siblings stay re-detectable on the next `compile --review`.

### Infrastructure

- Tests grew from 222 to 291 across all new features.

### Contributors

Thanks to **@ishan5ain** for #12 (split embedding endpoints for OpenAI-compatible providers) and **@sy2ruto** for reporting the multi-source citation lint bug (#10) — the parsing fix shipped here in PR #19.

## [0.2.0] - 2026-04-16

First major release since 0.1.1. Ships the complete initial roadmap plus an MCP server for AI agent integration.

### Added

- **MCP server** (`llmwiki serve`) exposes llmwiki's automated pipelines as Model Context Protocol tools so agents can ingest, compile, query, search, lint, and read pages programmatically. Ships with 7 tools and 5 read-only resources.
- **Semantic search** via embeddings — pre-filters the wiki index to the top 15 most similar pages before calling the selection LLM, with transparent fallback to full-index selection when no embeddings store exists.
- **Multi-provider support** — swap LLM backends via `LLMWIKI_PROVIDER=anthropic|openai|ollama|minimax`.
- **`llmwiki lint`** command with six rule-based checks (broken wikilinks, orphaned pages, missing summaries, duplicate concepts, empty pages, broken citations). No LLM calls, no API key required.
- **Paragraph-level source attribution** — compiled pages now include `^[filename.md]` citation markers pointing back to source files.
- **Obsidian integration** — LLM-extracted tags, deterministic aliases (slug, conjunction swap, abbreviation), and auto-generated `wiki/MOC.md` grouping concept pages by tag.
- **Anthropic provider enhancements** — `ANTHROPIC_AUTH_TOKEN` support, custom base URLs, and `~/.claude/settings.json` fallback for credentials and model.
- **MiniMax provider** via the OpenAI-compatible endpoint.
- GitHub Actions CI with Node 18/20/22 build+test matrix plus Fallow codebase health check (required for merges).

### Changed

- Command functions (`compile`, `query`, `ingest`) now expose structured-result variants (`compileAndReport()`, `generateAnswer()`, `ingestSource()`) alongside the existing CLI-facing versions. The CLI experience is unchanged.
- `runCompilePipeline` decomposed into focused phase helpers to bring function complexity under Fallow's thresholds.

### Infrastructure

- Tests grew from 91 to 211 across all new features.
- Fallow codebase health analyzer required in CI (no dead code, no duplication, no complexity threshold violations).

### Contributors

Thanks to @FrankMa1, @PipDscvr, @goforu, and @socraticblock for their contributions.

## [0.1.1] - 2026-04-07

### Fixed

- Flaky CLI test timeout.

## [0.1.0] - 2026-04-05

Initial release.

### Added

- `llmwiki ingest` — fetch a URL or copy a local file into `sources/`.
- `llmwiki compile` — incremental two-phase compilation (extract concepts, then generate pages). Hash-based change detection skips unchanged sources.
- `llmwiki query` — two-step LLM-powered Q&A (index-based page selection, then streaming answer). `--save` flag writes answers as wiki pages.
- `llmwiki watch` — auto-recompile on source changes.
- Atomic writes, lock-protected compilation, orphan marking for deleted sources.
- `[[wikilink]]` resolution and auto-generated `wiki/index.md`.

[1.1.0]: https://github.com/atomicstrata/llm-wiki-compiler/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/atomicstrata/llm-wiki-compiler/compare/v0.11.0...v1.0.0
[0.2.0]: https://github.com/atomicmemory/llm-wiki-compiler/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/atomicmemory/llm-wiki-compiler/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/atomicmemory/llm-wiki-compiler/releases/tag/v0.1.0
