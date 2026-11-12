/**
 * Displays HTML the server rendered from wiki Markdown.
 *
 * The server sanitizes the HTML and renders each citation as a
 * `span.citation-chip` carrying the cited file and line range. This component
 * shortens each chip's label to its line range (`L12–15`), names it in full for
 * assistive technology, and, when the cited file exists, makes it a keyboard
 * reachable link that opens the source at those lines. A chip whose file is
 * missing stays plain struck-through text. Every value is rebuilt from the
 * chip's data attributes, never from its current text, so decorating twice
 * (as React's StrictMode does) changes nothing; it runs before paint, so the
 * long form never flashes.
 *
 * Wikilinks are plain `#/...` anchors and need no handling here; the shell's
 * hover previews pick them up by their `data-page-id`. `onRender` hands the
 * rendered container to the caller once per body, which the page view uses to
 * build its outline.
 */
import { useLayoutEffect, useRef, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { closestElement } from "./dom";
import { rangeLabel } from "./page-model";
import { previewTarget, type CitationTarget } from "./preview-data";
import { sourceHref } from "./route";

const CHIP_SELECTOR = ".citation-chip[data-file]";

/**
 * Typography for the server's Markdown HTML. The citation chips and missing
 * wikilinks are server markup this client cannot put classes on, so they are
 * styled from here with descendant variants.
 */
const PROSE = [
  "prose prose-zinc max-w-none dark:prose-invert",
  "prose-headings:scroll-mt-20 prose-headings:tracking-tight prose-a:font-medium prose-a:text-indigo-600 prose-a:no-underline hover:prose-a:underline dark:prose-a:text-indigo-400",
  "[&_.citation-chip]:ml-1 [&_.citation-chip]:cursor-pointer [&_.citation-chip]:whitespace-nowrap [&_.citation-chip]:rounded [&_.citation-chip]:bg-zinc-100 [&_.citation-chip]:px-1 [&_.citation-chip]:py-0.5",
  "[&_.citation-chip]:font-mono [&_.citation-chip]:text-[11px] [&_.citation-chip]:text-zinc-500 [&_.citation-chip]:hover:bg-indigo-50 [&_.citation-chip]:hover:text-indigo-700",
  "dark:[&_.citation-chip]:bg-white/5 dark:[&_.citation-chip]:text-zinc-400 dark:[&_.citation-chip]:hover:bg-indigo-500/10 dark:[&_.citation-chip]:hover:text-indigo-300",
  "[&_.citation-chip[data-resolved=false]]:cursor-default [&_.citation-chip[data-resolved=false]]:line-through",
  "[&_[data-missing=true]]:text-zinc-400",
].join(" ");

/** The citation a chip carries, or null for anything else. */
function chipCitation(chip: HTMLElement): CitationTarget | null {
  const target = previewTarget(chip);
  return target?.kind === "citation" ? target : null;
}

/** Give one chip its short label and full name, and make it a link when its file exists. */
export function decorateChip(chip: HTMLElement): void {
  const citation = chipCitation(chip);
  if (citation === null) return;
  const lines = citation.lineStart === undefined ? null : { start: citation.lineStart, end: citation.lineEnd ?? citation.lineStart };
  chip.textContent = lines ? rangeLabel(lines) : citation.file;
  chip.setAttribute("aria-label", lines ? `${citation.file}, ${lines.start === lines.end ? `line ${lines.start}` : `lines ${lines.start}–${lines.end}`}` : citation.file);
  if (!citation.resolved) return;
  chip.tabIndex = 0;
  chip.setAttribute("role", "link");
}

/** Open the source a resolved chip cites, if the event landed on one. */
function openChip(target: EventTarget): void {
  const chip = closestElement(target, CHIP_SELECTOR);
  const citation = chip ? chipCitation(chip) : null;
  if (citation?.resolved) window.location.hash = sourceHref(citation.file, citation.lineStart, citation.lineEnd);
}

/** Render server-sanitized wiki HTML with working citation chips. */
export function WikiHtml({ html, onRender }: { html: string; onRender?: (container: HTMLElement) => void }): ReactNode {
  const container = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    for (const chip of container.current?.querySelectorAll<HTMLElement>(CHIP_SELECTOR) ?? []) decorateChip(chip);
    if (container.current) onRender?.(container.current);
    // `onRender` is a callback prop; the rendered body is what identifies a run.
  }, [html]);
  const onClick = (event: MouseEvent): void => openChip(event.target);
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Enter") openChip(event.target);
  };
  return <div ref={container} className={PROSE} onClick={onClick} onKeyDown={onKeyDown} dangerouslySetInnerHTML={{ __html: html }} />;
}
