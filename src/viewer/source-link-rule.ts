/**
 * Markdown-it rule that makes links to ingested sources navigable.
 *
 * The compiler ends each page with a `## Sources` list of Markdown links whose
 * target is the bare source filename, for example `[Kiln log](kiln-log.md)`. A
 * relative href means nothing inside the viewer, and the sanitizer removes it,
 * which leaves a link that cannot be followed.
 *
 * This rule rewrites a link whose target is exactly the name of a known source
 * file to the viewer's own source route, `#/_source/<file>`. Any other relative
 * link is left alone and still loses its href in the sanitizer.
 */

import type MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";

/** Hash route of one ingested source; the remainder is the encoded filename. */
const SOURCE_ROUTE_PREFIX = "#/_source/";

/** What the rule needs to recognize a source link. */
interface SourceLinkContext {
  /** Filenames under `sources/`, frozen at snapshot time. */
  sourceFiles: ReadonlySet<string>;
}

/** Register the rule on a markdown-it instance. */
export function registerSourceLink(md: MarkdownIt, context: SourceLinkContext): void {
  md.core.ruler.push("source_links", (state) => {
    for (const block of state.tokens) rewriteSourceLinks(block.children ?? [], context.sourceFiles);
  });
}

/** Point every link that targets a known source file at the source route. */
function rewriteSourceLinks(tokens: Token[], sourceFiles: ReadonlySet<string>): void {
  for (const token of tokens) {
    if (token.type !== "link_open") continue;
    const file = decodeTarget(token.attrGet("href"));
    if (file !== null && sourceFiles.has(file)) {
      token.attrSet("href", `${SOURCE_ROUTE_PREFIX}${encodeURIComponent(file)}`);
    }
  }
}

/** Undo markdown-it's percent-encoding of a link target; null when it is absent or malformed. */
function decodeTarget(href: string | null): string | null {
  if (href === null) return null;
  try {
    return decodeURIComponent(href);
  } catch {
    return null;
  }
}
