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
 * Older markers are still recognised, so pages written with them are rewritten
 * once, without a model call, the next time their tail is refreshed.
 */

/** Where the generated tail starts. A blank line must precede it for markdown to read it as a comment. */
const GENERATED_MARKER = "[//]: # (llmwiki-generated)";
/** Markers earlier timeline pages used. */
const LEGACY_MARKERS = ["[//]: # (llmwiki-timeline-related)", "<!-- llmwiki:timeline-related -->"];

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
