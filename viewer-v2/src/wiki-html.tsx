/**
 * Displays HTML the server rendered from wiki Markdown.
 *
 * The server sanitizes the HTML and renders each citation as a
 * `span.citation-chip` carrying the cited file and line range, with adjacent
 * chips touching. This component separates them with a space, makes them
 * keyboard-reachable, shortens each label to its line range with the full
 * citation kept as a tooltip, and opens the cited source when one is activated.
 * Wikilinks are plain `#/...` anchors and need no handling here; the shell's
 * hover previews pick them up by their `data-page-id`. `onRender` hands the
 * rendered container to the caller once per body, which the page view uses to
 * build its outline.
 */
import { useEffect, useRef, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { citationHref } from "./route";

const CHIP_SELECTOR = ".citation-chip";

/**
 * Typography for the server's Markdown HTML. The citation chips and missing
 * wikilinks are server markup this client cannot put classes on, so they are
 * styled from here with descendant variants.
 */
const PROSE = [
  "prose prose-zinc max-w-none dark:prose-invert",
  "prose-headings:scroll-mt-20 prose-headings:tracking-tight prose-a:font-medium prose-a:text-indigo-600 prose-a:no-underline hover:prose-a:underline dark:prose-a:text-indigo-400",
  "[&_.citation-chip]:cursor-pointer [&_.citation-chip]:rounded [&_.citation-chip]:bg-zinc-100 [&_.citation-chip]:px-1 [&_.citation-chip]:py-0.5",
  "[&_.citation-chip]:font-mono [&_.citation-chip]:text-[11px] [&_.citation-chip]:text-zinc-500 [&_.citation-chip]:hover:bg-indigo-50 [&_.citation-chip]:hover:text-indigo-700",
  "dark:[&_.citation-chip]:bg-white/5 dark:[&_.citation-chip]:text-zinc-400 dark:[&_.citation-chip]:hover:bg-indigo-500/10 dark:[&_.citation-chip]:hover:text-indigo-300",
  "[&_.citation-chip[data-resolved=false]]:cursor-default [&_.citation-chip[data-resolved=false]]:line-through",
  "[&_[data-missing=true]]:text-zinc-400",
].join(" ");

/** The hash a citation chip points at, or null when the target is not a chip. */
function chipTarget(target: EventTarget): string | null {
  const chip = target instanceof Element ? target.closest<HTMLElement>(CHIP_SELECTOR) : null;
  if (chip === null) return null;
  const { file, lineStart, lineEnd } = chip.dataset;
  return citationHref(file, lineStart, lineEnd);
}

/** Follow a chip's target, if the event landed on one. */
function openChip(target: EventTarget): void {
  const href = chipTarget(target);
  if (href !== null) window.location.hash = href;
}

/** `notes.md:12-15` reads as `L12–15`; the full citation moves to the tooltip. A chip without lines keeps its file name. */
function shortenChip(chip: HTMLElement): void {
  const { file, lineStart, lineEnd } = chip.dataset;
  if (!file || !lineStart) return;
  chip.title = chip.textContent ?? file;
  chip.textContent = lineEnd && lineEnd !== lineStart ? `L${lineStart}–${lineEnd}` : `L${lineStart}`;
}

/** Render server-sanitized wiki HTML with working citation chips. */
export function WikiHtml({ html, onRender }: { html: string; onRender?: (container: HTMLElement) => void }): ReactNode {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    for (const chip of container.current?.querySelectorAll<HTMLElement>(CHIP_SELECTOR) ?? []) {
      chip.before(" ");
      shortenChip(chip);
      chip.tabIndex = 0;
      chip.setAttribute("role", "link");
    }
    if (container.current) onRender?.(container.current);
    // `onRender` is a callback prop; the rendered body is what identifies a run.
  }, [html]);
  const onClick = (event: MouseEvent): void => openChip(event.target);
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Enter") openChip(event.target);
  };
  return (
    <div
      ref={container}
      className={PROSE}
      onClick={onClick}
      onKeyDown={onKeyDown}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
