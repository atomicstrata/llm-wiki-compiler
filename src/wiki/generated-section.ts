/**
 * @file src/wiki/generated-section.ts
 * @description The deterministic tail of a generated page: sections compile
 * rebuilds on every run without a model call, such as a day's "Pages from this
 * day" or a person's "Days". They sit after a marker, and the model-written text
 * above the marker is never touched.
 *
 * The marker is a markdown comment, `[//]: # (llmwiki-generated)`, which renders
 * as nothing (the viewer escapes raw HTML, so an HTML comment would show) and
 * cannot appear in what a model writes. The tail is found by the LAST marker.
 * Two other timeline markers are also recognised as a tail's start, and a tail
 * refresh writes the current marker in their place, with no model call.
 */

/** Where the generated tail starts. A blank line must precede it for markdown to read it as a comment. */
const GENERATED_MARKER = "[//]: # (llmwiki-generated)";
/** Other markers a timeline page's tail may start with; a refresh replaces them. */
const LEGACY_MARKERS = ["[//]: # (llmwiki-timeline-related)", "<!-- llmwiki:timeline-related -->"];

/** A link to another page, as a generated list shows it. */
export interface PageLink {
  /** The page's path under wiki/: `trip-plan`, `person/alex-kim`, `timeline/2026-05-04`. */
  target: string;
  title: string;
}

/** Links as a markdown bullet list of wikilinks. */
export function linkList(links: PageLink[]): string {
  return links.map((link) => `- [[${link.target}|${link.title}]]`).join("\n");
}

/** A page's text without its generated tail. */
export function withoutGenerated(text: string): string {
  const at = Math.max(...[GENERATED_MARKER, ...LEGACY_MARKERS].map((marker) => text.lastIndexOf(marker)));
  return at === -1 ? text : text.slice(0, at);
}

/**
 * A page's text with its generated tail replaced by `tail` (markdown sections),
 * or removed when `tail` is empty. Idempotent: the same tail gives the same text.
 */
export function withGenerated(text: string, tail: string): string {
  const kept = withoutGenerated(text).trimEnd();
  return tail.trim() ? `${kept}\n\n${GENERATED_MARKER}\n${tail.trim()}\n` : `${kept}\n`;
}
