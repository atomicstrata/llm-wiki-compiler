/**
 * Shared fixture helpers for the compile-reroute safety/resilience test suite
 * (floor proof, fault injection, journal-bounded, refresh/watch, seed collision).
 *
 * Centralizes the small on-disk setup + introspection each of those files needs
 * — journal-dir file counting, the overview-seed schema, the deleted-source
 * state.json, and the AnthropicProvider stub — so the per-file boilerplate is
 * declared once rather than duplicated across the suite.
 */

import { existsSync } from "fs";
import { readdir, writeFile, mkdir } from "fs/promises";
import path from "path";
import { vi } from "vitest";
import { AnthropicProvider } from "../../src/providers/anthropic.js";
import { LLMWIKI_DIR } from "../../src/utils/constants.js";

/** Count `.json` files directly under `<root>/.llmwiki/journal/` (commit-pruned). */
export async function journalFileCount(root: string): Promise<number> {
  const dir = path.join(root, LLMWIKI_DIR, "journal");
  if (!existsSync(dir)) return 0;
  return (await readdir(dir)).filter((f) => f.endsWith(".json")).length;
}

/** Write a schema declaring one overview seed page (optionally related to slugs). */
export async function writeOverviewSeedSchema(
  root: string,
  title = "Overview",
  relatedSlugs: string[] = [],
): Promise<void> {
  await mkdir(path.join(root, LLMWIKI_DIR), { recursive: true });
  const schema = {
    version: 1, defaultKind: "concept", kinds: {},
    seedPages: [{ title, kind: "overview", summary: "Top-level overview.", relatedSlugs }],
  };
  await writeFile(path.join(root, LLMWIKI_DIR, "schema.json"), JSON.stringify(schema), "utf-8");
}

/** Write a minimal state.json marking `<file>` as the lone compiled owner of `<slug>`. */
export async function writeSingleOwnerState(root: string, file: string, slug: string): Promise<void> {
  await mkdir(path.join(root, LLMWIKI_DIR), { recursive: true });
  await writeFile(
    path.join(root, LLMWIKI_DIR, "state.json"),
    JSON.stringify({
      version: 1, indexHash: "", frozenSlugs: [],
      sources: { [file]: { hash: "x", concepts: [slug], compiledAt: "2024-01-01T00:00:00Z" } },
    }),
    "utf-8",
  );
}

/** Stub the AnthropicProvider: a fixed single-concept extraction + page body, logs silenced. */
export function stubExtractionAndBody(concept: string, body: string): void {
  vi.spyOn(AnthropicProvider.prototype, "toolCall").mockResolvedValue(
    JSON.stringify({ concepts: [{ concept, summary: `${concept} summary.`, is_new: true, confidence: 0.9 }] }),
  );
  vi.spyOn(AnthropicProvider.prototype, "complete").mockResolvedValue(body);
  vi.spyOn(console, "log").mockImplementation(() => {});
}
