/**
 * @file test/fixtures/fallback-stub.ts
 * @description Shared helpers for the embeddings-unavailable fallback-selection
 * tests: stub `callClaude` (under `selectPages`) to echo a fixed list of pageId
 * tokens, and seed a NO-embeddings project with concept/query/typed pages so a
 * test can drive `selectFallbackRefs`/`pickSearchRefs` deterministically. Callers
 * `vi.mock("../src/utils/llm.js")` themselves; the stub only sets the resolved value.
 */

import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { vi } from "vitest";
import { makeTempRoot } from "./temp-root.js";
import { writePage } from "./write-page.js";
import { writeProfileFile } from "./profile-fixtures.js";
import type { ProfilePack } from "../../src/profile/types.js";

/** Stub callClaude (under selectPages) to echo the given pageId tokens. */
export async function stubSelectPages(tokens: string[]): Promise<void> {
  const { callClaude } = await import("../../src/utils/llm.js");
  vi.mocked(callClaude).mockResolvedValue(JSON.stringify({ pages: tokens, reasoning: "test" }));
}

/** A profile whose single `papers` type opts INTO search. */
export const SEARCH_PAPERS_PROFILE: ProfilePack = {
  schemaVersion: 1,
  profileId: "papers-test",
  entities: { papers: { directory: "wiki/papers", retrieval: { includeInSearch: true } } },
};

/**
 * Seed a NO-embeddings project with one concept, one saved query, and one typed
 * `papers` page (plus a placeholder index.md), under the given profile.
 *
 * @param prefix - Temp-root name prefix.
 * @param slugs - `{ concept, query, typed }` slugs to seed.
 * @param profile - Profile to write (defaults to {@link SEARCH_PAPERS_PROFILE}).
 * @returns The created project root.
 */
export async function seedFallbackProject(
  prefix: string,
  slugs: { concept: string; query: string; typed: string },
  profile: ProfilePack = SEARCH_PAPERS_PROFILE,
): Promise<string> {
  const root = await makeTempRoot(prefix);
  await mkdir(path.join(root, "wiki/papers"), { recursive: true });
  await writePage(path.join(root, "wiki/concepts"), slugs.concept, { title: "Concept Page", summary: "s" }, "Concept body.");
  await writePage(path.join(root, "wiki/queries"), slugs.query, { title: "Query Page", summary: "s" }, "Query body.");
  await writePage(path.join(root, "wiki/papers"), slugs.typed, { title: "Typed Page", summary: "s" }, "Typed body.");
  await writeProfileFile(root, profile);
  await writeFile(path.join(root, "wiki", "index.md"), "# Knowledge Wiki\n");
  return root;
}
