/**
 * Hover previews for wikilinks and citation chips, anywhere in the app.
 *
 * One set of document listeners watches for any element carrying
 * `data-page-id` (server wikilinks, rail links) or a citation chip's
 * `data-file`. Pointer interest opens a card after a short delay so passing
 * over a link does nothing; keyboard focus opens it at once; leaving, Escape
 * or a navigation closes it. The card is a manual popover, so it renders in
 * the top layer, above a modal dialog such as the page details sheet. The card is supplemental: everything it shows is
 * one click away, so it is a non-interactive `role="tooltip"` described by its
 * trigger, and it lets the pointer pass through. Floating UI places it, flipping
 * at viewport edges; it writes position through the CSSOM, which the viewer's
 * `style-src 'self'` policy allows. Touch input never opens a card: a tap
 * follows the link, as it always did.
 */
import { autoUpdate, computePosition, flip, offset, shift, size } from "@floating-ui/dom";
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import type { PageRow, PagesEnvelope } from "./api";
import { citedSourceText, findTrigger, isTracked, pageBlurb, pageKindLabel, previewTarget, sliceExcerpt, type CitationTarget, type Excerpt, type PreviewTarget } from "./preview-data";
import { useAsync, type AsyncState } from "./use-async";

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
      // Whatever opens a card, keyboard focus or a delay running out, cancels any other card still waiting.
      window.clearTimeout(timer);
      pending = null;
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
    const controller = new AbortController();
    listen(controller.signal, { onOver, show, hide, current: () => current });
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, []);
  return open;
}

interface InterestHandlers {
  onOver: (event: PointerEvent) => void;
  show: (trigger: HTMLElement) => void;
  hide: () => void;
  current: () => HTMLElement | null;
}

/** Attach every listener under one signal: pointer interest, keyboard focus, leaving the window, Escape, navigation. */
function listen(signal: AbortSignal, { onOver, show, hide, current }: InterestHandlers): void {
  document.addEventListener("pointerover", onOver, { signal });
  document.addEventListener("pointerout", (event) => { if (event.relatedTarget === null) hide(); }, { signal });
  document.addEventListener("focusin", (event) => {
    const trigger = findTrigger(event.target);
    // Only keyboard focus opens at once; a mouse click focuses a link too, and that is not interest.
    if (trigger !== null && trigger !== current() && trigger.matches(":focus-visible")) show(trigger);
  }, { signal });
  document.addEventListener("focusout", (event) => { if (findTrigger(event.target) === current()) hide(); }, { signal });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") hide(); }, { signal });
  window.addEventListener("hashchange", hide, { signal });
}

/** Keep the card beside its trigger, and tie the two together for assistive technology. */
function usePlacement(card: HTMLDivElement | null, trigger: HTMLElement, id: string): void {
  useEffect(() => {
    if (card === null) return;
    trigger.setAttribute("aria-describedby", id);
    // The top layer puts the card above a modal dialog's backdrop, such as the page details sheet.
    card.showPopover?.();
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
function PageCard({ id, row, snapshot }: { id: string; row: PageRow | undefined; snapshot: string }): ReactNode {
  const blurb = useAsync(() => pageBlurb(id, row, snapshot), id);
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
function CitationBody({ state, target }: { state: AsyncState<string>; target: CitationTarget }): ReactNode {
  if (state.status === "loading") return <p className="mt-1.5 text-zinc-500">Loading…</p>;
  if (state.status === "error") return <p className="mt-1.5 text-amber-700 dark:text-amber-400">The cited source is not available.</p>;
  const excerpt = sliceExcerpt(state.data, target.lineStart, target.lineEnd);
  if (excerpt.lines.length === 0) return <p className="mt-1.5 text-amber-700 dark:text-amber-400">The cited lines are past the end of the source.</p>;
  return <ExcerptLines excerpt={excerpt} />;
}

/** The cited source's name, then its cited lines. */
function CitationCard({ target, snapshot }: { target: CitationTarget; snapshot: string }): ReactNode {
  const source = useAsync(() => citedSourceText(target, snapshot), target.file);
  return (
    <>
      <p className="truncate font-mono text-xs text-zinc-500 dark:text-zinc-400">{target.file}</p>
      <CitationBody state={source} target={target} />
    </>
  );
}

/** The card for one open preview; `snapshot` identifies the wiki the texts are cached for. */
function PreviewCard({ open, rows, snapshot }: { open: OpenPreview; rows: Map<string, PageRow>; snapshot: string }): ReactNode {
  const [card, setCard] = useState<HTMLDivElement | null>(null);
  const id = useId();
  usePlacement(card, open.trigger, id);
  const { target } = open;
  return (
    <div ref={setCard} id={id} role="tooltip" popover="manual"
      className={`pointer-events-none invisible fixed inset-auto z-50 m-0 max-w-[calc(100vw-1rem)] overflow-hidden rounded-xl border-0 ${target.kind === "page" ? "w-96" : "w-[34rem]"} bg-white p-4 text-sm text-zinc-900 shadow-lg ring-1 ring-zinc-950/10 dark:bg-zinc-800 dark:text-zinc-100 dark:ring-white/10`}>
      {target.kind === "page" ? <PageCard id={target.id} row={rows.get(target.id)} snapshot={snapshot} /> : <CitationCard target={target} snapshot={snapshot} />}
    </div>
  );
}

/** Mount once in the shell; shows a card for whichever trigger holds the reader's interest. */
export function HoverPreviews({ wiki }: { wiki: PagesEnvelope }): ReactNode {
  const open = usePreviewTrigger();
  const rows = useMemo(() => new Map(wiki.pages.map((row) => [row.id, row])), [wiki.pages]);
  if (open === null) return null;
  return <PreviewCard key={previewKey(open.target)} open={open} rows={rows} snapshot={wiki.updatedAt} />;
}

/** A key that remounts the card when the previewed thing changes. */
function previewKey(target: PreviewTarget): string {
  return target.kind === "page" ? `page:${target.id}` : `citation:${target.file}:${target.lineStart}-${target.lineEnd}`;
}
