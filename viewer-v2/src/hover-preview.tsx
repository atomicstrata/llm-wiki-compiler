/**
 * Hover previews for wikilinks and citation chips, anywhere in the app.
 *
 * One set of document listeners watches for any element carrying
 * `data-page-id` (server wikilinks, rail links) or a citation chip's
 * `data-file`. Pointer interest opens a card after a short delay so passing
 * over a link does nothing; keyboard focus opens it at once; leaving, Escape
 * or a navigation closes it. The card is supplemental: everything it shows is
 * one click away, so it is a non-interactive `role="tooltip"` described by its
 * trigger, and it lets the pointer pass through. Floating UI places it, flipping
 * at viewport edges; it writes position through the CSSOM, which the viewer's
 * `style-src 'self'` policy allows. Touch input never opens a card: a tap
 * follows the link, as it always did.
 */
import { autoUpdate, computePosition, flip, offset, shift, size } from "@floating-ui/dom";
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import type { PageRow } from "./api";
import { citedSourceText, findTrigger, isTracked, pageBlurb, pageKindLabel, previewTarget, sliceExcerpt, type Excerpt, type PreviewTarget } from "./preview-data";
import type { AsyncState } from "./use-async";
import { useAsync } from "./use-async";

/** Long enough that sweeping the pointer across a paragraph opens nothing. */
const OPEN_DELAY_MS = 350;
const CARD_GAP_PX = 6;
const VIEWPORT_PADDING_PX = 8;
/** A card never shrinks below this, even in a short viewport. */
const MIN_CARD_HEIGHT_PX = 120;

interface OpenPreview {
  trigger: HTMLElement;
  target: PreviewTarget;
}

/** Wire the document listeners; report the open preview, or null. */
function usePreviewTrigger(): OpenPreview | null {
  const [open, setOpen] = useState<OpenPreview | null>(null);
  useEffect(() => {
    let timer: number | undefined;
    let pending: HTMLElement | null = null;
    let current: HTMLElement | null = null;
    const show = (trigger: HTMLElement): void => {
      const target = previewTarget(trigger);
      current = target ? trigger : null;
      setOpen(target ? { trigger, target } : null);
    };
    const hide = (): void => {
      window.clearTimeout(timer);
      pending = current = null;
      setOpen(null);
    };
    const onOver = (event: PointerEvent): void => {
      if (event.pointerType === "touch") return;
      const trigger = findTrigger(event.target);
      if (isTracked(trigger, current, pending)) return;
      hide();
      pending = trigger;
      if (trigger !== null) timer = window.setTimeout(() => show(trigger), OPEN_DELAY_MS);
    };
    const listeners = listenerTable(onOver, show, hide, () => current);
    for (const [type, listener] of listeners) document.addEventListener(type, listener as EventListener);
    window.addEventListener("hashchange", hide);
    return () => {
      window.clearTimeout(timer);
      for (const [type, listener] of listeners) document.removeEventListener(type, listener as EventListener);
      window.removeEventListener("hashchange", hide);
    };
  }, []);
  return open;
}

/** The remaining listeners: leaving the window, focus in and out, and Escape. */
function listenerTable(
  onOver: (event: PointerEvent) => void,
  show: (trigger: HTMLElement) => void,
  hide: () => void,
  current: () => HTMLElement | null,
): [string, (event: never) => void][] {
  return [
    ["pointerover", onOver],
    ["pointerout", (event: PointerEvent) => { if (event.relatedTarget === null) hide(); }],
    ["focusin", (event: FocusEvent) => {
      const trigger = findTrigger(event.target);
      if (trigger !== null && trigger !== current()) show(trigger);
    }],
    ["focusout", (event: FocusEvent) => { if (findTrigger(event.target) === current()) hide(); }],
    ["keydown", (event: KeyboardEvent) => { if (event.key === "Escape") hide(); }],
  ];
}

/** Keep the card beside its trigger, and tie the two together for assistive technology. */
function usePlacement(card: HTMLDivElement | null, trigger: HTMLElement, id: string): void {
  useEffect(() => {
    if (card === null) return;
    trigger.setAttribute("aria-describedby", id);
    const place = (): void => {
      void computePosition(trigger, card, {
        strategy: "fixed",
        placement: "bottom-start",
        middleware: [
          offset(CARD_GAP_PX),
          flip({ padding: VIEWPORT_PADDING_PX }),
          shift({ padding: VIEWPORT_PADDING_PX }),
          size({
            padding: VIEWPORT_PADDING_PX,
            apply: ({ availableHeight }) => { card.style.maxHeight = `${Math.max(MIN_CARD_HEIGHT_PX, availableHeight)}px`; },
          }),
        ],
      }).then(({ x, y }) => {
        Object.assign(card.style, { left: `${x}px`, top: `${y}px`, visibility: "visible" });
      });
    };
    const stop = autoUpdate(trigger, card, place);
    return () => {
      stop();
      trigger.removeAttribute("aria-describedby");
    };
  }, [card, trigger, id]);
}

/** The summary or opening under a page card's title; nothing when it cannot load. */
function Blurb({ state }: { state: AsyncState<string> }): ReactNode {
  if (state.status === "error") return null;
  const text = state.status === "ready" ? state.data : "Loading…";
  return text ? <p className="mt-1.5 line-clamp-5 text-zinc-600 dark:text-zinc-300">{text}</p> : null;
}

/** A page's title, where it lives, and its summary, or its opening when it has none. */
function PageCard({ id, row }: { id: string; row: PageRow | undefined }): ReactNode {
  const blurb = useAsync(() => pageBlurb(id, row), id);
  return (
    <>
      <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{pageKindLabel(id, row)}</p>
      <p className="mt-0.5 font-semibold text-zinc-950 dark:text-white">{row?.title || id}</p>
      <Blurb state={blurb} />
    </>
  );
}

/** Numbered cited lines, and how many more the span covers. */
function ExcerptLines({ excerpt }: { excerpt: Excerpt }): ReactNode {
  return (
    <>
      <ol className="mt-2 space-y-0.5 font-mono text-xs leading-5 text-zinc-800 dark:text-zinc-200">
        {excerpt.lines.map((line) => (
          <li key={line.number} className="flex gap-3">
            <span className="w-8 shrink-0 text-right text-zinc-400 tabular-nums select-none">{line.number}</span>
            <span className="min-w-0 break-words whitespace-pre-wrap">{line.text || " "}</span>
          </li>
        ))}
      </ol>
      {excerpt.hiddenCount > 0 && <p className="mt-1.5 text-xs text-zinc-500">{excerpt.hiddenCount} more lines in the source</p>}
    </>
  );
}

/** The cited lines once loaded, or why there are none. */
function CitationBody({ state, target }: { state: AsyncState<string>; target: Extract<PreviewTarget, { kind: "citation" }> }): ReactNode {
  if (state.status === "loading") return <p className="mt-1.5 text-zinc-500">Loading…</p>;
  if (state.status === "error") return <p className="mt-1.5 text-amber-700 dark:text-amber-400">The cited source is not available.</p>;
  return <ExcerptLines excerpt={sliceExcerpt(state.data, target.lineStart, target.lineEnd)} />;
}

/** The cited source's name, then its cited lines. */
function CitationCard({ target }: { target: Extract<PreviewTarget, { kind: "citation" }> }): ReactNode {
  const source = useAsync(() => citedSourceText(target), target.file);
  return (
    <>
      <p className="truncate font-mono text-xs text-zinc-500 dark:text-zinc-400">{target.file}</p>
      <CitationBody state={source} target={target} />
    </>
  );
}

/** The card for one open preview. */
function PreviewCard({ open, rows }: { open: OpenPreview; rows: Map<string, PageRow> }): ReactNode {
  const [card, setCard] = useState<HTMLDivElement | null>(null);
  const id = useId();
  usePlacement(card, open.trigger, id);
  const { target } = open;
  return (
    <div ref={setCard} id={id} role="tooltip"
      className={`pointer-events-none invisible fixed top-0 left-0 z-50 max-w-[calc(100vw-1rem)] overflow-hidden rounded-xl ${target.kind === "page" ? "w-96" : "w-[34rem]"} bg-white p-4 text-sm shadow-lg ring-1 ring-zinc-950/10 dark:bg-zinc-800 dark:ring-white/10`}>
      {target.kind === "page" ? <PageCard id={target.id} row={rows.get(target.id)} /> : <CitationCard target={target} />}
    </div>
  );
}

/** Mount once in the shell; shows a card for whichever trigger holds the reader's interest. */
export function HoverPreviews({ pages }: { pages: PageRow[] }): ReactNode {
  const open = usePreviewTrigger();
  const rows = useMemo(() => new Map(pages.map((row) => [row.id, row])), [pages]);
  if (open === null) return null;
  return <PreviewCard key={previewKey(open.target)} open={open} rows={rows} />;
}

/** A key that remounts the card when the previewed thing changes. */
function previewKey(target: PreviewTarget): string {
  return target.kind === "page" ? `page:${target.id}` : `citation:${target.file}:${target.lineStart}-${target.lineEnd}`;
}
