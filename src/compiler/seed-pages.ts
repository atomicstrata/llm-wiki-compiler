/**
 * Schema-driven seed-page generation for the compilation pipeline.
 *
 * Owns the single responsibility of materialising the schema-declared seed
 * pages (overview / comparison / entity): rendering each seed body via the LLM,
 * stamping deterministic frontmatter, and applying the valid ones as ONE
 * journalled executor batch under compile's held lock. Seed pages land under
 * `wiki/concepts/` so existing tooling (index, MOC, lint, embeddings) treats
 * them uniformly with concept pages.
 */

import {
  buildFrontmatter,
  parseFrontmatter,
  validateWikiPage,
  slugify,
} from "../utils/markdown.js";
import { callClaude } from "../utils/llm.js";
import { buildSeedPagePrompt } from "./prompts.js";
import { type SchemaConfig, type SeedPage } from "../schema/index.js";
import { readWikiPageContentOrWarn } from "./confined-wiki-read.js";
import { addObsidianMeta } from "./obsidian.js";
import { addModelProvenanceMeta } from "./provenance.js";
import {
  applyCompilePageWritesLocked,
  type CompilePageWrite,
  type SkippedWrite,
} from "./compile-write.js";
import * as output from "../utils/output.js";
import { CONCEPTS_DIR } from "../utils/constants.js";
import type { WikiFrontmatter } from "../utils/types.js";
import type { PageGenerationResult } from "./types.js";

/**
 * Materialise schema-declared seed pages (overview, comparison, entity).
 * Each seed page is written under wiki/concepts/ next to concept pages so
 * existing tooling (index, MOC, lint, embeddings) treats them uniformly.
 * Slugs from generated pages this run are added so seed pages can be linked
 * deterministically without waiting for a second compile pass.
 * @param root - Project root directory.
 * @param schema - Resolved schema config.
 * @param generation - Result of the concept-page generation phase.
 */
export async function generateSeedPages(
  root: string,
  schema: SchemaConfig,
  generation: PageGenerationResult,
): Promise<void> {
  if (schema.seedPages.length === 0) return;
  // Dedup seeds by slug FIRST-SEEN-WINS before rendering, mirroring
  // mergeExtractions' `bySlug` map: two distinct seed titles can `slugify` to the
  // SAME slug, and a later collider would share the committed set's
  // `namespace/slug` key — so if the planner floor-blocked one, BOTH would drop
  // from `seedSlugs`, silently never resolving/embedding the committed sibling.
  // Dropping the collider up front means no two writes can share that key.
  const dedupedSeeds = dedupSeedsBySlug(schema.seedPages);
  // Render every seed body (reading prior committed pages), then apply the valid
  // ones as ONE journalled seed batch through the executor — instead of an
  // inline per-page atomicWrite. A page that fails the validate prefilter records
  // an error and is excluded from the batch (skip-not-abort, like generation).
  const writes: CompilePageWrite[] = [];
  for (const seed of dedupedSeeds) {
    const result = await generateSingleSeedPage(root, schema, seed);
    if (result.error) {
      generation.errors.push(result.error);
      continue;
    }
    if (result.write) writes.push(result.write);
  }
  const { skipped } = await applyCompilePageWritesLocked(root, writes);
  reportSeedOutcome(generation, writes, skipped);
}

/**
 * Dedup seeds by `slugify(title)`, keeping the FIRST occurrence (mirrors
 * mergeExtractions' first-seen-wins `bySlug` map). A later seed whose title
 * collapses to an already-seen slug is dropped — and warned, so the collision is
 * not silent — because two writes sharing a `namespace/slug` key would let a
 * floor-blocked collider drop its committed sibling from `seedSlugs`.
 */
function dedupSeedsBySlug(seeds: SeedPage[]): SeedPage[] {
  const bySlug = new Map<string, SeedPage>();
  for (const seed of seeds) {
    const slug = slugify(seed.title);
    if (bySlug.has(slug)) {
      const kept = bySlug.get(slug)!;
      output.status(
        "!",
        output.warn(
          `Seed "${seed.title}" collides on slug "${slug}" with "${kept.title}" — skipped (first wins).`,
        ),
      );
      continue;
    }
    bySlug.set(slug, seed);
  }
  return [...bySlug.values()];
}

/** Identity key for a compile write — `namespace`+`slug` (slug alone is ambiguous across namespaces). */
function writeIdentity(item: CompilePageWrite): string {
  return `${item.namespace}/${item.slug}`;
}

/**
 * Derive `seedSlugs` from the COMMITTED set only: a write that passed the validate
 * prefilter but was FLOOR-BLOCKED by the planner lands in `skipped` and must NOT be
 * reported as written — otherwise `finalizeWiki` resolves links to a missing file
 * and refreshes embeddings for a phantom. Pushes only writes whose identity is not
 * skipped; keeps the existing `skipped → generation.errors` reporting.
 */
function reportSeedOutcome(
  generation: PageGenerationResult,
  writes: CompilePageWrite[],
  skipped: SkippedWrite[],
): void {
  const skippedIdentities = new Set(skipped.map((s) => writeIdentity(s.item)));
  for (const w of writes) {
    if (!skippedIdentities.has(writeIdentity(w))) generation.seedSlugs.push(w.slug);
  }
  for (const s of skipped) generation.errors.push(`Page "${s.item.slug}" skipped — ${s.reason}`);
}

/**
 * Outcome of a single seed-page generation: a `write` when valid (carries its own
 * slug+namespace), an `error` message when invalid. The committed-slug derivation
 * is done AFTER apply from the returned `write`s, so no slug is surfaced eagerly.
 */
interface SeedPageOutcome {
  write?: CompilePageWrite;
  error?: string;
}

/** Build, prompt, and render a single seed page into a validated CompilePageWrite. */
async function generateSingleSeedPage(
  root: string,
  schema: SchemaConfig,
  seed: SeedPage,
): Promise<SeedPageOutcome> {
  const slug = slugify(seed.title);
  const relatedContent = await loadSeedRelatedPages(root, seed.relatedSlugs ?? []);
  const rule = schema.kinds[seed.kind];
  const system = buildSeedPagePrompt(seed, rule, relatedContent);
  const pageBody = await callClaude({
    system,
    messages: [{ role: "user", content: `Write the ${seed.kind} page titled "${seed.title}".` }],
  });

  const now = new Date().toISOString();
  const existing = await readWikiPageContentOrWarn(
    root, CONCEPTS_DIR, slug, false /* first compile — absence is normal */,
  );
  const existingMeta = existing ? parseFrontmatter(existing).meta : null;
  const createdAt = typeof existingMeta?.createdAt === "string" ? existingMeta.createdAt : now;
  const typedFields: WikiFrontmatter = {
    title: seed.title,
    summary: seed.summary,
    sources: [],
    kind: seed.kind,
    createdAt,
    updatedAt: now,
  };
  const frontmatterFields: Record<string, unknown> = { ...typedFields };
  addObsidianMeta(frontmatterFields, seed.title, []);
  addModelProvenanceMeta(frontmatterFields);
  const frontmatter = buildFrontmatter(frontmatterFields);
  const content = `${frontmatter}\n\n${pageBody}\n`;
  if (!validateWikiPage(content)) {
    output.status("!", output.warn(`Invalid page for "${seed.title}" — skipped.`));
    return { error: `Invalid page for "${seed.title}" — failed validation` };
  }
  return { write: { namespace: "concepts", slug, body: content } };
}

/**
 * Load the bodies of the related concept pages a seed page should weave together.
 * Each read is confined to `wiki/concepts`: a symlinked page whose target escapes
 * that dir is dropped (warned only when physically present, skipped) so its bytes
 * never enter the seed prompt or the re-emitted seed body. A related slug that
 * points at no page is silently skipped, as before.
 */
async function loadSeedRelatedPages(root: string, slugs: string[]): Promise<string> {
  if (slugs.length === 0) return "";
  const contents: string[] = [];
  for (const slug of slugs) {
    const content = await readWikiPageContentOrWarn(
      root, CONCEPTS_DIR, slug, false /* related slug may name no page — absence is normal */,
    );
    if (content) contents.push(content);
  }
  return contents.join("\n\n---\n\n");
}
