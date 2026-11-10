/**
 * Displays HTML the server rendered from wiki Markdown.
 *
 * The server sanitizes the HTML and renders each citation as a
 * `span.citation-chip` carrying the cited file and line range. This component
 * makes those chips keyboard-reachable and opens the cited source when one is
 * activated. Wikilinks are plain `#/...` anchors and need no handling.
 */
import { useEffect, useRef, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { citationHref } from "./route";

const CHIP_SELECTOR = ".citation-chip";

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

/** Render server-sanitized wiki HTML with working citation chips. */
export function WikiHtml({ html }: { html: string }): ReactNode {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    for (const chip of container.current?.querySelectorAll<HTMLElement>(CHIP_SELECTOR) ?? []) {
      chip.tabIndex = 0;
      chip.setAttribute("role", "link");
    }
  }, [html]);
  const onClick = (event: MouseEvent): void => openChip(event.target);
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Enter") openChip(event.target);
  };
  return (
    <div
      ref={container}
      className="wiki-html"
      onClick={onClick}
      onKeyDown={onKeyDown}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
