/**
 * Wiki page rendering for the llmwiki compile pipeline.
 *
 * Encapsulates the single-page generation step: gather related pages, call
 * the LLM, build frontmatter, and produce the final markdown blob. Splitting
 * this away from the orchestrator (`compiler/index.ts`) keeps the orchestrator
 * focused on phase sequencing and lets the review-candidate code path reuse
 * the exact same renderer used for direct writes.
 */

import {
  buildFrontmatter,
  parseFrontmatter,
} from "../utils/markdown.js";
import { asCompileAccess, type CompileAccess, type CompileProject } from "./compile-access.js";
import { callClaude } from "../utils/llm.js";
import { buildPagePrompt } from "./prompts.js";
import { addObsidianMeta } from "./obsidian.js";
import { addModelProvenanceMeta, addProvenanceMeta, reportContradictionWarnings } from "./provenance.js";
import { normalizeCitationsInBody } from "./citation-normalize.js";
import type { SchemaConfig } from "../schema/index.js";
import type { ExtractedConcept } from "../utils/types.js";

/** Maximum number of existing concept pages to include as cross-reference context. */
export const RELATED_PAGE_CONTEXT_LIMIT = 5;

/** A merged-concept input from the orchestrator (multiple sources merged into one). */
interface RenderableConcept {
  slug: string;
  concept: ExtractedConcept;
  sourceFiles: string[];
  combinedContent: string;
  rebuild?: boolean;
  linkTargets?: readonly string[];
}

/**
 * Render a wiki page (frontmatter + body) for a merged concept by calling
 * the LLM with cross-referencing context from existing concept pages.
 * @param project - The project, as its access seam or a local root directory.
 * @param entry - The merged concept to render.
 * @param schema - Resolved schema config, used to stamp `kind` on frontmatter.
 * @returns Full markdown content (frontmatter + body, trailing newline).
 */
export async function renderMergedPageContent(
  project: CompileProject,
  entry: RenderableConcept,
  schema: SchemaConfig,
): Promise<string> {
  const access = asCompileAccess(project);
  const existingPage = await access.readConceptPage(
    entry.slug, false /* new page — absence is normal */,
  );
  const relatedPages = await loadRelatedPages(access, entry.slug);

  const system = buildPagePrompt(
    entry.concept.concept,
    entry.combinedContent,
    entry.rebuild ? "" : existingPage,
    relatedPages,
    entry.linkTargets,
  );

  const rawPageBody = await callClaude({
    system,
    messages: [
      { role: "user", content: `Write the wiki page for "${entry.concept.concept}".` },
    ],
  });

  const pageBody = normalizeCitationsInBody(
    rawPageBody,
    entry.sourceFiles,
    entry.combinedContent,
    entry.rebuild === true,
  );

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
 * @param access - The project's access seam.
 * @param excludeSlug - Slug of the current page to exclude.
 * @returns Concatenated related page contents (empty when there are no concept pages).
 */
async function loadRelatedPages(access: CompileAccess, excludeSlug: string): Promise<string> {
  const files = await access.listConceptPageFiles();

  const related = files
    .filter((f) => f.endsWith(".md") && f !== `${excludeSlug}.md`)
    .slice(0, RELATED_PAGE_CONTEXT_LIMIT);

  const contents: string[] = [];
  for (const f of related) {
    const content = await access.readConceptPage(f.replace(/\.md$/, ""));
    if (!content) continue;
    const { meta } = parseFrontmatter(content);
    if (meta.orphaned) continue;
    contents.push(content);
  }

  return contents.join("\n\n---\n\n");
}
