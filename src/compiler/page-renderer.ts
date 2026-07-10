/**
 * Wiki page rendering for the llmwiki compile pipeline.
 *
 * Encapsulates the single-page generation step: gather related pages, call
 * the LLM, build frontmatter, and produce the final markdown blob. Splitting
 * this away from the orchestrator (`compiler/index.ts`) keeps the orchestrator
 * focused on phase sequencing and lets the review-candidate code path reuse
 * the exact same renderer used for direct writes.
 */

import { readdir } from "fs/promises";
import path from "path";
import {
  buildFrontmatter,
  parseFrontmatter,
} from "../utils/markdown.js";
import { readWikiPageContentOrWarn } from "./confined-wiki-read.js";
import { callClaude } from "../utils/llm.js";
import { buildPagePrompt } from "./prompts.js";
import { addObsidianMeta } from "./obsidian.js";
import { addModelProvenanceMeta, addProvenanceMeta, reportContradictionWarnings } from "./provenance.js";
import { normalizeCitationsInBody } from "./citation-normalize.js";
import { CONCEPTS_DIR } from "../utils/constants.js";
import type { SchemaConfig } from "../schema/index.js";
import type { ExtractedConcept } from "../utils/types.js";

/** Maximum number of existing concept pages to include as cross-reference context. */
const RELATED_PAGE_CONTEXT_LIMIT = 5;

/** A merged-concept input from the orchestrator (multiple sources merged into one). */
interface RenderableConcept {
  slug: string;
  concept: ExtractedConcept;
  sourceFiles: string[];
  combinedContent: string;
}

/**
 * Render a wiki page (frontmatter + body) for a merged concept by calling
 * the LLM with cross-referencing context from existing concept pages.
 * @param root - Project root directory.
 * @param entry - The merged concept to render.
 * @param schema - Resolved schema config, used to stamp `kind` on frontmatter.
 * @returns Full markdown content (frontmatter + body, trailing newline).
 */
export async function renderMergedPageContent(
  root: string,
  entry: RenderableConcept,
  schema: SchemaConfig,
): Promise<string> {
  const existingPage = await readWikiPageContentOrWarn(
    root, CONCEPTS_DIR, entry.slug, false /* new page — absence is normal */,
  );
  const relatedPages = await loadRelatedPages(root, entry.slug);

  const system = buildPagePrompt(
    entry.concept.concept,
    entry.combinedContent,
    existingPage,
    relatedPages,
  );

  const rawPageBody = await callClaude({
    system,
    messages: [
      { role: "user", content: `Write the wiki page for "${entry.concept.concept}".` },
    ],
  });

  const pageBody = normalizeCitationsInBody(rawPageBody, entry.sourceFiles, entry.combinedContent);

  const frontmatter = buildMergedFrontmatter(entry, existingPage, schema);
  reportContradictionWarnings(entry.concept.concept, entry.concept);
  return `${frontmatter}\n\n${pageBody}\n`;
}

/**
 * Construct the frontmatter block for a merged concept, preserving createdAt
 * and stamping the `kind` field from the schema's default kind.
 */
function buildMergedFrontmatter(
  entry: RenderableConcept,
  existingPage: string,
  schema: SchemaConfig,
): string {
  const now = new Date().toISOString();
  const existing = existingPage ? parseFrontmatter(existingPage) : null;
  const createdAt = (existing?.meta.createdAt && typeof existing.meta.createdAt === "string")
    ? existing.meta.createdAt
    : now;
  const frontmatterFields: Record<string, unknown> = {
    title: entry.concept.concept,
    summary: entry.concept.summary,
    sources: entry.sourceFiles,
    kind: schema.defaultKind,
    createdAt,
    updatedAt: now,
  };
  addObsidianMeta(frontmatterFields, entry.concept.concept, entry.concept.tags ?? []);
  addProvenanceMeta(frontmatterFields, entry.concept);
  addModelProvenanceMeta(frontmatterFields);
  return buildFrontmatter(frontmatterFields);
}

/**
 * Load related wiki pages to provide cross-referencing context.
 * Returns concatenated content of up to RELATED_PAGE_CONTEXT_LIMIT pages.
 * Each per-file read is confined to `wiki/concepts`: a symlinked entry whose
 * target escapes that dir is dropped (warned, skipped) so its bytes never enter
 * the generation prompt.
 * @param root - Project root directory.
 * @param excludeSlug - Slug of the current page to exclude.
 * @returns Concatenated related page contents (empty when concepts dir is missing).
 */
async function loadRelatedPages(root: string, excludeSlug: string): Promise<string> {
  const conceptsPath = path.join(root, CONCEPTS_DIR);
  let files: string[];

  try {
    files = await readdir(conceptsPath);
  } catch {
    return "";
  }

  const related = files
    .filter((f) => f.endsWith(".md") && f !== `${excludeSlug}.md`)
    .slice(0, RELATED_PAGE_CONTEXT_LIMIT);

  const contents: string[] = [];
  for (const f of related) {
    const content = await readWikiPageContentOrWarn(root, CONCEPTS_DIR, f.replace(/\.md$/, ""));
    if (!content) continue;
    const { meta } = parseFrontmatter(content);
    if (meta.orphaned) continue;
    contents.push(content);
  }

  return contents.join("\n\n---\n\n");
}
