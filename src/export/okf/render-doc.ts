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
import { withExportBody } from "../connector-content.js";

/**
 * Render a single ExportPage as a full OKF `.md` document.
 *
 * @param page - The fully-resolved wiki page to render.
 * @param resolve - Link resolver that maps a slug to its OKF directory + title.
 * @param refName - Lookup from a cited filename to its bundled reference name, or
 *   null when the file was not copied (so the citation is rendered without a link).
 * @returns Fenced YAML frontmatter + rewritten body + derived Citations section.
 */
export function renderOkfDoc(
  page: ExportPage,
  resolve: LinkResolver,
  refName: (file: string) => string | null,
): string {
  const renderedPage = withExportBody(page);
  const fm = mapPageToOkfFrontmatter(renderedPage);
  const canonical = canonicalBody(renderedPage.body);
  const rewritten = wikilinksToOkf(canonical, resolve);
  const citations = renderCitationsSection(renderedPage.citations ?? [], refName);
  // buildFrontmatter already returns fenced YAML (---\n...\n---).
  const frontmatter = buildFrontmatter(fm as unknown as Record<string, unknown>);
  return `${frontmatter}\n${rewritten}${citations}`;
}
