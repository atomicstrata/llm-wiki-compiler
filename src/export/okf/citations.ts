/** @file Render a derived, human-readable `# Citations` section (non-canonical). */
import type { FlatCitation } from "../../context/provenance.js";
import { safeRefName } from "./mapping.js";

/** Build a `# Citations` block; entries link to bundle-relative references/ (safe names). */
export function renderCitationsSection(citations: FlatCitation[]): string {
  if (citations.length === 0) return "";
  const lines = citations.map((c, i) => {
    const span = c.start !== undefined ? `:${c.start}${c.end !== undefined ? `-${c.end}` : ""}` : "";
    return `${i + 1}. [${c.file}${span}](/references/${safeRefName(c.file)})`;
  });
  return `\n# Citations\n\n${lines.join("\n")}\n`;
}
