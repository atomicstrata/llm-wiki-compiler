/**
 * Find the images a source keeps in `sources/images/`.
 *
 * A source names its images in two ways: a frontmatter `images:` list, and
 * ordinary Markdown embeds of the form `![alt](images/<file>)`. Both yield bare
 * file names, which the viewer loads through `/api/source-image/<file>`.
 */

const IMAGE_FILE_PATTERN = "[A-Za-z0-9._-]+\\.(?:png|jpe?g|gif|webp)";
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;
const MARKDOWN_EMBED = new RegExp(`!\\[[^\\]]*\\]\\(images/(${IMAGE_FILE_PATTERN})\\)`, "gi");
const IMAGE_FILE = new RegExp(IMAGE_FILE_PATTERN, "gi");

/** Image file names referenced by a source, in order, without duplicates. */
export function sourceImageNames(sourceText: string): string[] {
  const embedded = [...sourceText.matchAll(MARKDOWN_EMBED)].map((match) => match[1]);
  return [...new Set([...frontmatterImages(sourceText), ...embedded])];
}

/** File names in the frontmatter `images:` entry, written inline or as a block list. */
function frontmatterImages(sourceText: string): string[] {
  const lines = (FRONTMATTER.exec(sourceText)?.[1] ?? "").split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith("images:"));
  if (start === -1) return [];
  const entry = [lines[start]];
  for (const line of lines.slice(start + 1)) {
    if (!/^\s*-|^\s+\S/.test(line)) break;
    entry.push(line);
  }
  return entry.join("\n").match(IMAGE_FILE) ?? [];
}
