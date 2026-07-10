/**
 * @file test/fixtures/parity-corpus.ts
 * @description Fixed, representative DEFAULT-profile project used as the
 * pre-refactor GOLDEN parity baseline (CLP Phase 0, Task 0).
 *
 * `buildParityCorpus(root)` materializes a small but deliberately diverse
 * wiki on disk so every deterministic, no-LLM surface (SDK / CLI / MCP /
 * viewer) has something stable to read. The corpus is intentionally NOT
 * produced by `compile` — running the compiler would require an LLM
 * provider and would yield non-deterministic output. Instead every page,
 * source, and the `.llmwiki/state.json` are written directly with PINNED
 * ISO timestamps and pinned source hashes so the captured goldens are
 * byte-stable run-to-run.
 *
 * Coverage the corpus deliberately exercises:
 *   - an EMPTY concept page (empty edge for body-derived surfaces)
 *   - a normal concept page with a `^[src:line]` citation
 *   - a wikilink-with-alias (`[[Target|shown text]]`)
 *   - a query page (the queries/ namespace)
 *   - NON-SLUG-SAFE filenames: a stem with a SPACE (`Foo Bar.md`) and a
 *     stem with a CJK char (`研究.md`). These prove the default collector
 *     preserves raw stems verbatim — a later profile-refactor task must
 *     not slugify or reject them.
 *   - an ORPHANED page (frontmatter `orphaned: true`)
 *   - a STALE page (its owning source's recorded hash no longer matches
 *     the on-disk content, so freshness classifies it stale)
 *
 * The pinned hashes in `state.json` are arbitrary fixed strings: freshness
 * only compares recorded-vs-current, so a deliberately WRONG recorded hash
 * for the stale source's owner reliably yields `stale` without any real
 * hashing, while the fresh source records its true on-disk hash.
 */

import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { buildFrontmatter } from "../../src/utils/markdown.js";
import { hashFile } from "../../src/compiler/hasher.js";
import {
  CONCEPTS_DIR,
  QUERIES_DIR,
  SOURCES_DIR,
  STATE_FILE,
  INDEX_FILE,
} from "../../src/utils/constants.js";

/** Pinned timestamps so every timestamped surface is stable run-to-run. */
const CREATED_AT = "2024-01-01T00:00:00.000Z";
const UPDATED_AT = "2024-01-02T00:00:00.000Z";
const COMPILED_AT = "2024-01-03T00:00:00.000Z";

/** On-disk content of the fresh source whose owner page stays fresh. */
const FRESH_SOURCE_BODY = "# Alpha source\n\nAlpha establishes the core idea.\n";
/** On-disk content of the stale source; state.json records a mismatching hash. */
const STALE_SOURCE_BODY = "# Beta source\n\nBeta has drifted since last compile.\n";

/** A recorded hash that intentionally will NOT match the stale source on disk. */
const STALE_RECORDED_HASH = "0000000000000000000000000000000000000000000000000000000000000000";

/**
 * Build the fixed parity corpus under `root`. Writes sources, concept and
 * query pages (including non-slug-safe stems), a wiki index, and a pinned
 * `.llmwiki/state.json`. Idempotent for a fresh directory.
 *
 * @param root - Absolute path to the (empty) project root to populate.
 */
export async function buildParityCorpus(root: string): Promise<void> {
  await ensureDirs(root);
  await writeSources(root);
  await writeConceptPages(root);
  await writeQueryPage(root);
  await writeIndex(root);
  await writeState(root);
}

/** Create the standard wiki/concepts, wiki/queries, sources, and .llmwiki dirs. */
async function ensureDirs(root: string): Promise<void> {
  await mkdir(path.join(root, CONCEPTS_DIR), { recursive: true });
  await mkdir(path.join(root, QUERIES_DIR), { recursive: true });
  await mkdir(path.join(root, SOURCES_DIR), { recursive: true });
  await mkdir(path.join(root, ".llmwiki"), { recursive: true });
}

/** Write the two source files the concept pages cite/own. */
async function writeSources(root: string): Promise<void> {
  const sources = path.join(root, SOURCES_DIR);
  await writeFile(path.join(sources, "alpha.md"), FRESH_SOURCE_BODY);
  await writeFile(path.join(sources, "beta.md"), STALE_SOURCE_BODY);
}

/** Frontmatter fields shared by concept pages, with pinned timestamps. */
function conceptFields(extra: Record<string, unknown>): Record<string, unknown> {
  return { createdAt: CREATED_AT, updatedAt: UPDATED_AT, ...extra };
}

/** Write a markdown page (frontmatter + body) at an arbitrary stem (raw, unslugged). */
async function writePageRaw(
  dir: string,
  stem: string,
  fields: Record<string, unknown>,
  body: string,
): Promise<void> {
  const fm = buildFrontmatter(fields);
  await writeFile(path.join(dir, `${stem}.md`), `${fm}\n\n${body}\n`);
}

/** Write every concept page (normal, empty, alias-link, orphaned, stale, non-slug-safe stems). */
async function writeConceptPages(root: string): Promise<void> {
  const dir = path.join(root, CONCEPTS_DIR);
  await writePageRaw(
    dir,
    "alpha",
    conceptFields({ title: "Alpha", summary: "The core idea.", sources: ["alpha.md"], tags: ["core"] }),
    "# Alpha\n\nAlpha establishes the core idea.^[alpha.md:1]\n\nSee also [[Beta|the beta concept]].",
  );
  await writePageRaw(
    dir,
    "beta",
    conceptFields({ title: "Beta", summary: "Drifted concept.", sources: ["beta.md"], tags: [] }),
    "# Beta\n\nBeta has drifted since its source last compiled.",
  );
  await writePageRaw(
    dir,
    "empty-edge",
    conceptFields({ title: "Empty Edge", summary: "", sources: [], tags: [] }),
    "",
  );
  await writePageRaw(
    dir,
    "orphan",
    conceptFields({ title: "Orphan", summary: "No live source.", sources: [], tags: [], orphaned: true }),
    "# Orphan\n\nThis page has no live owning source.",
  );
  await writeNonSlugSafePages(dir);
}

/**
 * Write the two concept pages with non-slug-safe stems (a space and a CJK
 * char). The default collector must preserve these stems verbatim — a later
 * profile-refactor task must not slugify or reject them.
 */
async function writeNonSlugSafePages(dir: string): Promise<void> {
  await writePageRaw(
    dir,
    "Foo Bar",
    conceptFields({ title: "Foo Bar", summary: "Stem with a space.", sources: [], tags: [] }),
    "# Foo Bar\n\nProves a space in the stem is preserved verbatim.",
  );
  await writePageRaw(
    dir,
    "研究",
    conceptFields({ title: "研究", summary: "Stem with a CJK char.", sources: [], tags: [] }),
    "# 研究\n\nProves a unicode/CJK stem is preserved verbatim.",
  );
}

/** Write the single query page (queries/ namespace). */
async function writeQueryPage(root: string): Promise<void> {
  const dir = path.join(root, QUERIES_DIR);
  await writePageRaw(
    dir,
    "what-is-alpha",
    conceptFields({ title: "What is Alpha?", summary: "Generated answer.", sources: ["alpha.md"], tags: [] }),
    "# What is Alpha?\n\nAlpha is the core idea.^[alpha.md:1] See [[Alpha]].",
  );
}

/** Write the auto-index page (wiki/index.md). */
async function writeIndex(root: string): Promise<void> {
  const body = [
    "# Wiki Index",
    "",
    "## Concepts",
    "- [[alpha]]",
    "- [[beta]]",
    "",
    "## Queries",
    "- [[what-is-alpha]]",
    "",
  ].join("\n");
  await writeFile(path.join(root, INDEX_FILE), body);
}

/**
 * Write `.llmwiki/state.json` with pinned compile time and hashes. The fresh
 * source records its TRUE on-disk hash (page stays fresh); the stale source
 * records a deliberately mismatching hash so its owner page is classified
 * stale by the freshness layer.
 */
async function writeState(root: string): Promise<void> {
  const freshHash = await hashFile(path.join(root, SOURCES_DIR, "alpha.md"));
  const state = {
    version: 1 as const,
    indexHash: "",
    sources: {
      "alpha.md": { hash: freshHash, concepts: ["alpha"], compiledAt: COMPILED_AT },
      "beta.md": { hash: STALE_RECORDED_HASH, concepts: ["beta"], compiledAt: COMPILED_AT },
    },
  };
  await writeFile(path.join(root, STATE_FILE), JSON.stringify(state, null, 2), "utf-8");
}
