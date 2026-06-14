/** @file Render a derived, human-readable `# Citations` section (non-canonical). */
import type { FlatCitation } from "../../context/provenance.js";

/**
 * Build a `# Citations` block. Each entry links to its bundle-relative
 * `references/<name>` file ONLY when `refName(file)` returns a (copied) name;
 * when it returns null the file was not bundled, so the entry is emitted as
 * PLAIN TEXT with no link — preserving the listing without a dangling link.
 *
 * @param citations - The page's flat citations (in order).
 * @param refName - Lookup from a cited filename to its bundled reference name, or null.
 * @returns The rendered `# Citations` section, or "" when there are no citations.
 */
export function renderCitationsSection(
  citations: FlatCitation[],
  refName: (file: string) => string | null,
): string {
  if (citations.length === 0) return "";
  const lines = citations.map((c, i) => {
    const span = c.start !== undefined ? `:${c.start}${c.end !== undefined ? `-${c.end}` : ""}` : "";
    const label = `${c.file}${span}`;
    const name = refName(c.file);
    return name ? `${i + 1}. [${label}](/references/${name})` : `${i + 1}. ${label}`;
  });
  return `\n# Citations\n\n${lines.join("\n")}\n`;
}
