/**
 * "On this page": the outline of a rendered wiki page, with the section the
 * reader is in highlighted.
 *
 * The server renders headings without ids, and a plain `#id` hash would be
 * read by the hash router as a route, so the outline gives each `h2`/`h3` an
 * id here and scrolls to it directly instead of changing the URL. The active
 * section is the last heading that has scrolled past the sticky header; that
 * is read from layout on scroll, batched to one read per frame. Two cases
 * that rule gets wrong on a short page: a heading the reader clicked may never
 * reach the top because the page runs out, so a click pins the highlight until
 * the reader scrolls by hand; and once the page bottoms out, the last heading
 * is the one in view.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { prefersReducedMotion } from "./media";
import { RailSection } from "./page-rail";

/** One outline entry. */
export interface OutlineItem {
  id: string;
  text: string;
  level: 2 | 3;
}

/** A heading counts as passed once its top is above this line: the sticky header plus breathing room. */
const ACTIVE_LINE_PX = 96;
/** Ids carry a prefix so a heading named "main" cannot collide with the app's own ids. */
const ID_PREFIX = "h-";
const MIN_ITEMS = 2;

/** A URL-safe fragment of heading text. */
export function slugify(text: string): string {
  return text.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "") || "section";
}

/** Give every `h2` and `h3` under `root` a unique id and list them in order. */
export function assignHeadingIds(root: ParentNode): OutlineItem[] {
  const seen = new Map<string, number>();
  return Array.from(root.querySelectorAll<HTMLHeadingElement>("h2, h3")).map((heading) => {
    const text = heading.textContent?.trim() ?? "";
    const base = `${ID_PREFIX}${slugify(text)}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    heading.id = count === 1 ? base : `${base}-${count}`;
    return { id: heading.id, text, level: heading.tagName === "H3" ? 3 : 2 };
  });
}

/** Where the reader is: each heading's top, whether the page has bottomed out, and a clicked heading. */
export interface SpyInput {
  tops: { id: string; top: number }[];
  atBottom: boolean;
  pinned: string | null;
}

/** The outline item to highlight: a clicked one, the last one at the page end, else the last above the line. */
export function activeHeading({ tops, atBottom, pinned }: SpyInput, line = ACTIVE_LINE_PX): string | null {
  if (pinned !== null) return pinned;
  if (atBottom && tops.length > 0) return tops[tops.length - 1].id;
  let active = tops[0]?.id ?? null;
  for (const { id, top } of tops) {
    if (top > line) break;
    active = id;
  }
  return active;
}

/** Inputs that mean the reader is scrolling by hand, which releases a pinned highlight. */
const MANUAL_SCROLL_EVENTS = ["wheel", "touchstart", "keydown"] as const;
/** Sub-pixel layouts can stop a page a pixel short of its end. */
const BOTTOM_TOLERANCE_PX = 2;

/** Read the current layout into a spy input. */
function readSpyInput(items: OutlineItem[], pinned: string | null): SpyInput {
  const tops = items.flatMap((item) => {
    const heading = document.getElementById(item.id);
    return heading ? [{ id: item.id, top: heading.getBoundingClientRect().top }] : [];
  });
  const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - BOTTOM_TOLERANCE_PX;
  return { tops, atBottom, pinned };
}

/** Track which outline item the reader is in; `pin` holds a clicked item until the next manual scroll. */
function useScrollSpy(items: OutlineItem[]): { active: string | null; pin: (id: string) => void } {
  const [active, setActive] = useState<string | null>(null);
  const pinned = useRef<string | null>(null);
  useEffect(() => {
    let frame = 0;
    const measure = (): void => {
      frame = 0;
      setActive(activeHeading(readSpyInput(items, pinned.current)));
    };
    const onScroll = (): void => {
      if (frame === 0) frame = requestAnimationFrame(measure);
    };
    const release = (): void => { pinned.current = null; };
    const controller = new AbortController();
    const options = { passive: true, signal: controller.signal };
    measure();
    window.addEventListener("scroll", onScroll, options);
    for (const type of MANUAL_SCROLL_EVENTS) window.addEventListener(type, release, options);
    return () => {
      cancelAnimationFrame(frame);
      controller.abort();
    };
  }, [items]);
  const pin = (id: string): void => {
    pinned.current = id;
    setActive(id);
  };
  return { active, pin };
}

/** Scroll a heading into view, without animation when the reader asked for less motion. */
function scrollToHeading(id: string): void {
  const heading = document.getElementById(id);
  heading?.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
  heading?.setAttribute("tabindex", "-1");
  heading?.focus({ preventScroll: true });
}

/** The outline section of the rail; nothing for a page with fewer than two headings. */
export function Outline({ items }: { items: OutlineItem[] }): ReactNode {
  const { active, pin } = useScrollSpy(items);
  if (items.length < MIN_ITEMS) return null;
  return (
    <RailSection title="On this page">
      <nav aria-label="On this page">
        <ul role="list" className="space-y-1 border-l border-zinc-950/10 dark:border-white/10">
          {items.map((item) => (
            <li key={item.id}>
              <button type="button" onClick={() => { pin(item.id); scrollToHeading(item.id); }} aria-current={item.id === active ? "location" : undefined}
                className={`-ml-px block w-full border-l py-0.5 pr-1 text-left text-zinc-600 hover:text-zinc-950 aria-[current=location]:border-indigo-600 aria-[current=location]:font-medium aria-[current=location]:text-indigo-600 dark:text-zinc-400 dark:hover:text-white dark:aria-[current=location]:border-indigo-400 dark:aria-[current=location]:text-indigo-400 ${item.level === 3 ? "pl-6" : "pl-3"} border-transparent`}>
                {item.text}
              </button>
            </li>
          ))}
        </ul>
      </nav>
    </RailSection>
  );
}
