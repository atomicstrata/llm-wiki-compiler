/**
 * Obsidian integration helpers for the llmwiki knowledge compiler.
 *
 * Provides two capabilities:
 * 1. Enriching wiki page frontmatter with tags and aliases for better
 *    Obsidian graph navigation and search.
 * 2. Generating a Map of Content (MOC) page that groups concept pages
 *    by tag for easy browsing.
 */

import { readdir } from "fs/promises";
import path from "path";
import { slugify, atomicWrite, parseFrontmatter } from "../utils/markdown.js";
import { readWikiPageInDirOrWarn } from "./confined-wiki-read.js";
import { CONCEPTS_DIR, MOC_FILE } from "../utils/constants.js";

/** Minimum word count to generate an abbreviation alias. */
const ABBREVIATION_MIN_WORDS = 3;

/** Conjunctions that trigger a word-swap alias. */
const SWAP_CONJUNCTIONS = [" and ", " or "];

/**
 * Enrich a frontmatter object with Obsidian-specific tags and aliases.
 * Mutates the frontmatter object in place.
 * @param frontmatter - The frontmatter object to enrich.
 * @param conceptTitle - The human-readable concept title.
 * @param tags - Tags from extraction (may be empty).
 */
export function addObsidianMeta(
  frontmatter: Record<string, unknown>,
  conceptTitle: string,
  tags: string[],
): void {
  frontmatter.tags = tags;
  frontmatter.aliases = generateAliases(conceptTitle);
}

/**
 * Generate deterministic aliases from a concept title.
 * Produces up to three alias variants:
 * - Slug form (e.g., "gradient-descent")
 * - Word-swap around conjunctions (e.g., "Optimization and Gradient Descent")
 * - Abbreviation from first letters for 3+ word titles (e.g., "RAG")
 * @param title - The concept title to derive aliases from.
 * @returns Array of aliases that differ from the original title.
 */
function generateAliases(title: string): string[] {
  const aliases: string[] = [];
  const slug = slugify(title);

  if (slug !== title) {
    aliases.push(slug);
  }

  const swapAlias = generateSwapAlias(title);
  if (swapAlias) {
    aliases.push(swapAlias);
  }

  const abbreviation = generateAbbreviation(title);
  if (abbreviation) {
    aliases.push(abbreviation);
  }

  return aliases;
}

/**
 * Generate a word-swap alias by reversing parts around a conjunction.
 * E.g., "Gradient Descent and Optimization" becomes "Optimization and Gradient Descent".
 * @param title - The concept title.
 * @returns The swapped alias, or null if no conjunction found.
 */
function generateSwapAlias(title: string): string | null {
  for (const conjunction of SWAP_CONJUNCTIONS) {
    const index = title.toLowerCase().indexOf(conjunction);
    if (index === -1) continue;

    const before = title.slice(0, index);
    const after = title.slice(index + conjunction.length);
    const originalConjunction = title.slice(index, index + conjunction.length);
    return `${after}${originalConjunction}${before}`;
  }
  return null;
}

/**
 * Generate an abbreviation from first letters of each word for titles with 3+ words.
 * E.g., "Retrieval Augmented Generation" becomes "RAG".
 * @param title - The concept title.
 * @returns The abbreviation, or null if title has fewer than 3 words.
 */
function generateAbbreviation(title: string): string | null {
  const words = title.split(/\s+/);
  if (words.length < ABBREVIATION_MIN_WORDS) return null;

  const abbreviation = words.map((w) => w[0].toUpperCase()).join("");
  if (abbreviation === title) return null;

  return abbreviation;
}

/**
 * Generate a Map of Content (MOC) page grouping concept pages by tag.
 * Reads all concept pages, extracts their tags from frontmatter, and writes
 * a structured MOC.md with sections per tag and an Uncategorized section.
 * @param root - Project root directory.
 */
export async function generateMOC(root: string): Promise<void> {
  const conceptsPath = path.join(root, CONCEPTS_DIR);
  const pages = await loadConceptPages(conceptsPath);

  const tagGroups = groupPagesByTag(pages);
  const content = buildMOCContent(tagGroups);

  await atomicWrite(path.join(root, MOC_FILE), content, { confineRoot: root });
}

/** Minimal page info needed for MOC generation. */
interface PageInfo {
  slug: string;
  title: string;
  tags: string[];
}

/**
 * Load all concept pages and extract their title and tags.
 * @param conceptsPath - Absolute path to the concepts directory.
 * @returns Array of page info objects.
 */
async function loadConceptPages(conceptsPath: string): Promise<PageInfo[]> {
  let files: string[];
  try {
    files = await readdir(conceptsPath);
  } catch {
    return [];
  }

  // The concepts directory is itself the confinement boundary: a symlinked
  // entry whose target escapes it is dropped (warned, skipped) and never enters
  // the MOC. An empty file is skipped, matching the prior behavior.
  const pages: PageInfo[] = [];
  for (const file of files) {
    if (!file.endsWith(".md")) continue;

    const slug = file.replace(/\.md$/, "");
    const result = await readWikiPageInDirOrWarn(conceptsPath, slug);
    const content = "content" in result ? result.content : "";
    if (!content) continue;

    const { meta } = parseFrontmatter(content);
    if (meta.orphaned) continue;

    const title = typeof meta.title === "string" ? meta.title : slug;
    const tags = Array.isArray(meta.tags) ? (meta.tags as string[]) : [];
    pages.push({ slug, title, tags });
  }

  return pages;
}

/**
 * Group pages by their tags into a map. Pages with no tags go under "Uncategorized".
 * @param pages - Array of page info objects.
 * @returns Map of tag name to array of page titles.
 */
function groupPagesByTag(pages: PageInfo[]): Map<string, PageInfo[]> {
  const groups = new Map<string, PageInfo[]>();

  for (const page of pages) {
    if (page.tags.length === 0) {
      appendToGroup(groups, "Uncategorized", page);
      continue;
    }

    for (const tag of page.tags) {
      appendToGroup(groups, tag, page);
    }
  }

  return groups;
}

/** Append a page to a group, creating the group if needed. */
function appendToGroup(groups: Map<string, PageInfo[]>, key: string, page: PageInfo): void {
  const existing = groups.get(key);
  if (existing) {
    existing.push(page);
  } else {
    groups.set(key, [page]);
  }
}

/**
 * Build the MOC markdown content from grouped pages.
 * @param tagGroups - Map of tag name to array of page titles.
 * @returns Complete MOC markdown string.
 */
function buildMOCContent(tagGroups: Map<string, PageInfo[]>): string {
  const lines: string[] = ["# Map of Content", ""];

  const sortedTags = [...tagGroups.keys()].sort((a, b) => {
    // "Uncategorized" always goes last
    if (a === "Uncategorized") return 1;
    if (b === "Uncategorized") return -1;
    return a.localeCompare(b);
  });

  for (const tag of sortedTags) {
    const pages = tagGroups.get(tag) ?? [];
    lines.push(`## ${tag}`, "");
    for (const page of pages.sort((a, b) => a.title.localeCompare(b.title))) {
      lines.push(`- [[${page.slug}|${page.title}]]`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
