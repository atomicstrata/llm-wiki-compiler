/**
 * Locate literal Markdown code without rendering or reserializing a page.
 * Block maps come from the existing Markdown parser so nested list/blockquote
 * fences and indented code follow its grammar. Inline backtick runs require an
 * equally sized closing run; protected offsets always refer to original bytes.
 */
import MarkdownIt from "markdown-it";

type Span = { start: number; end: number };
const markdown = new MarkdownIt();
// Parsing only (nothing is rendered): `html` makes raw HTML blocks such as
// <pre> and <script> visible as html_block tokens so their bytes stay literal.
const markdownWithHtml = new MarkdownIt({ html: true });

/** Which literal regions a caller must leave untouched. */
export interface LiteralMarkdownOptions {
  /**
   * Also treat raw HTML blocks as literal. Off by default so link repair keeps
   * matching the viewer and answer-publication rules, which read wikilinks in
   * HTML blocks as live links; the resolver turns it on because it must never
   * insert a new link into code.
   */
  htmlBlocks?: boolean;
}

/** Literal blocks, and the inline-content blocks where code spans may occur, by original line range. */
function blockSpans(body: string, parser: MarkdownIt): { literal: Span[]; inline: Span[] } {
  const offsets = [0];
  for (const match of body.matchAll(/\n/g)) offsets.push(match.index + 1);
  offsets.push(body.length);
  const tokens = parser.parse(body, {}).filter(token => token.map);
  const span = (token: (typeof tokens)[number]) => ({ start: offsets[token.map![0]], end: offsets[token.map![1]] });
  return {
    literal: tokens.filter(token => ["fence", "code_block", "html_block"].includes(token.type)).map(span),
    inline: [
      ...tokens.filter(token => token.type === "inline").map(span),
      // Table cells' inline tokens carry no source map; markdown-it splits each
      // row into cells at unescaped pipes before inline parsing, so do the same.
      ...tokens.filter(token => token.type === "tr_open").flatMap(token => tableCellSpans(body, span(token))),
    ],
  };
}

/**
 * Split one table row's source into its cells at unescaped `|`. As in
 * markdown-it's table rule, any backslash directly before a `|` escapes it,
 * even when that backslash is itself preceded by another backslash.
 */
function tableCellSpans(body: string, row: Span): Span[] {
  const cells: Span[] = [];
  let start = row.start;
  for (let at = row.start; at < row.end; at++) {
    if (body[at] !== "|" || body[at - 1] === "\\") continue;
    cells.push({ start, end: at });
    start = at + 1;
  }
  cells.push({ start, end: row.end });
  return cells;
}

/** Locate matched code spans; an unmatched backtick remains ordinary prose. */
function inlineSpans(body: string): Span[] {
  const runs = [...body.matchAll(/`+/g)];
  const spans: Span[] = [];
  for (let i = 0; i < runs.length; i++) {
    const opener = runs[i];
    const backslashes = body.slice(0, opener.index).match(/\\+$/)?.[0].length ?? 0;
    if (backslashes % 2 === 1) continue;
    const close = runs.findIndex((run, j) => j > i && run[0].length === opener[0].length);
    if (close < 0) continue;
    const closer = runs[close];
    spans.push({ start: opener.index, end: closer.index + closer[0].length });
    i = close;
  }
  return spans;
}

/** Return a predicate identifying matches inside literal Markdown regions. */
export function isLiteralMarkdown(body: string, options: LiteralMarkdownOptions = {}): (offset: number) => boolean {
  const { literal, inline } = blockSpans(body, options.htmlBlocks ? markdownWithHtml : markdown);
  // Code spans pair backticks only within one inline block (a paragraph, heading,
  // list item or table cell), as Markdown does: an unmatched backtick never pairs
  // with one in another block, or with a fenced block's run.
  const spans = [...literal];
  for (const block of inline) {
    spans.push(...inlineSpans(body.slice(block.start, block.end))
      .map(span => ({ start: span.start + block.start, end: span.end + block.start })));
  }
  return offset => spans.some(span => offset >= span.start && offset < span.end);
}
