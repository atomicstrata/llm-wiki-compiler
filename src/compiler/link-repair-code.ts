/**
 * Locate literal Markdown code without rendering or reserializing a page.
 * Block maps come from the existing Markdown parser so nested list/blockquote
 * fences and indented code follow its grammar. Inline backtick runs require an
 * equally sized closing run; protected offsets always refer to original bytes.
 */
import MarkdownIt from "markdown-it";

type Span = { start: number; end: number };
const markdown = new MarkdownIt();

/** Locate literal blocks by their original line ranges. */
function blockSpans(body: string): Span[] {
  const offsets = [0];
  for (const match of body.matchAll(/\n/g)) offsets.push(match.index + 1);
  offsets.push(body.length);
  return markdown.parse(body, {})
    .filter(token => ["fence", "code_block", "html_block"].includes(token.type) && token.map)
    .map(token => ({ start: offsets[token.map![0]], end: offsets[token.map![1]] }));
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
export function isLiteralMarkdown(body: string): (offset: number) => boolean {
  const spans = blockSpans(body);
  // Inline scanning must not pair a prose backtick with a fenced block's run.
  let start = 0;
  for (const block of [...spans, { start: body.length, end: body.length }]) {
    spans.push(...inlineSpans(body.slice(start, block.start))
      .map(span => ({ start: span.start + start, end: span.end + start })));
    start = block.end;
  }
  return offset => spans.some(span => offset >= span.start && offset < span.end);
}
