/**
 * @file Render one ExportPage into a conformant OKF concept-doc markdown string.
 *
 * Produces: fenced YAML frontmatter (via `mapPageToOkfFrontmatter`) followed by
 * the canonical body with wikilinks rewritten to OKF links and a derived
 * `# Citations` section appended (non-canonical, stripped before hashing).
 */
import type { ExportPage } from "../types.js";
import type { LinkResolver } from "./types.js";
import { buildFrontmatter } from "../../utils/markdown.js";
import { mapPageToOkfFrontmatter, wikilinksToOkf, canonicalBody } from "./mapping.js";
import { renderCitationsSection } from "./citations.js";

/**
 * Render a single ExportPage as a full OKF `.md` document.
 *
 * @param page - The fully-resolved wiki page to render.
 * @param resolve - Link resolver that maps a slug to its OKF directory + title.
 * @returns Fenced YAML frontmatter + rewritten body + derived Citations section.
 */
export function renderOkfDoc(page: ExportPage, resolve: LinkResolver): string {
  const fm = mapPageToOkfFrontmatter(page);
  const canonical = canonicalBody(page.body);
  const rewritten = wikilinksToOkf(canonical, resolve);
  const citations = renderCitationsSection(page.citations ?? []);
  // buildFrontmatter already returns fenced YAML (---\n...\n---).
  const frontmatter = buildFrontmatter(fm as unknown as Record<string, unknown>);
  return `${frontmatter}\n${rewritten}${citations}`;
}
