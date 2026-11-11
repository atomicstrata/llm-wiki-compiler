/**
 * The command palette: one box to jump to any page, screen, or full-text hit.
 *
 * It is a native modal `<dialog>`, so the browser handles the top layer,
 * focus containment, Escape, and returning focus to whatever opened it. The
 * box follows the ARIA combobox pattern: focus stays in the input, the arrow
 * keys move `aria-activedescendant` through a listbox, and Enter opens the
 * active row. Anything can open the palette by calling `openPalette`, which
 * the header button and the keyboard shortcuts both do.
 */
import { ArrowRight, CornerDownLeft, FileText, History, Lightbulb, Search, TextSearch, type LucideIcon } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { HealthPayload, PagesEnvelope } from "./api";
import { navDestinations, type Destination } from "./nav";
import { paletteItems, readRecent, type PaletteGroup, type PaletteItem } from "./palette-model";
import { useLiveResults } from "./search";

const OPEN_EVENT = "llmwiki:open-palette";
/** Full-text search waits for two characters; one matches nearly every page. */
const MIN_TEXT_QUERY = 2;

const GROUP_ICON: Record<PaletteGroup, LucideIcon> = {
  Recent: History,
  Pages: Lightbulb,
  "Go to": ArrowRight,
  "In page text": FileText,
  Search: TextSearch,
};

/** Open the palette from anywhere. */
export function openPalette(): void {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

/** Move the active row by `step`, wrapping at either end. */
export function stepIndex(current: number, step: number, count: number): number {
  return count === 0 ? 0 : (current + step + count) % count;
}

/** The arrow-key step for a key, or 0 for keys the list does not handle. */
function keyStep(key: string): number {
  if (key === "ArrowDown") return 1;
  return key === "ArrowUp" ? -1 : 0;
}

/** One row: its icon, label, quiet detail, and an Enter hint while active. */
function PaletteOption({ item, id, active, onPick, onPoint }: {
  item: PaletteItem<Destination>;
  id: string;
  active: boolean;
  onPick: () => void;
  onPoint: () => void;
}): ReactNode {
  const Icon = item.destination?.icon ?? GROUP_ICON[item.group];
  return (
    <li id={id} role="option" aria-selected={active} onClick={onPick} onMouseMove={onPoint}
      className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm aria-selected:bg-zinc-950/5 dark:aria-selected:bg-white/10">
      <Icon className="size-4 shrink-0 text-zinc-400" strokeWidth={1.75} />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-zinc-900 dark:text-zinc-100">{item.label}</span>
        {item.detail && <span className="block truncate text-xs text-zinc-500 dark:text-zinc-400">{item.detail}</span>}
      </span>
      {active && <CornerDownLeft className="size-4 shrink-0 text-zinc-400" strokeWidth={1.75} />}
    </li>
  );
}

/** The grouped listbox. */
function PaletteList({ items, listId, active, onPick, onPoint }: {
  items: PaletteItem<Destination>[];
  listId: string;
  active: number;
  onPick: (item: PaletteItem<Destination>) => void;
  onPoint: (index: number) => void;
}): ReactNode {
  return (
    <ul id={listId} role="listbox" aria-label="Results" className="max-h-[min(60vh,28rem)] overflow-y-auto p-2">
      {items.map((item, index) => (
        <PaletteRow key={item.key} item={item} previous={items[index - 1]} listId={listId} index={index}
          active={index === active} onPick={() => onPick(item)} onPoint={() => onPoint(index)} />
      ))}
    </ul>
  );
}

/** A row, preceded by its group's heading when it starts a group. */
function PaletteRow({ item, previous, listId, index, active, onPick, onPoint }: {
  item: PaletteItem<Destination>;
  previous: PaletteItem<Destination> | undefined;
  listId: string;
  index: number;
  active: boolean;
  onPick: () => void;
  onPoint: () => void;
}): ReactNode {
  const startsGroup = previous?.group !== item.group && item.group !== "Search";
  return (
    <>
      {startsGroup && <li role="presentation" className="px-3 pt-3 pb-1 text-xs font-medium text-zinc-500 first:pt-1 dark:text-zinc-400">{item.group}</li>}
      <PaletteOption item={item} id={`${listId}-${index}`} active={active} onPick={onPick} onPoint={onPoint} />
    </>
  );
}

/** The input and list; mounted only while the dialog is open, so each opening starts empty. */
function PaletteBody({ wiki, health, onPick }: { wiki: PagesEnvelope; health: HealthPayload | null; onPick: (href: string) => void }): ReactNode {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const { results } = useLiveResults(query.trim().length >= MIN_TEXT_QUERY ? query : "");
  const destinations = useMemo(() => navDestinations(wiki, health), [wiki, health]);
  const recentIds = useMemo(() => readRecent(), []);
  const items = useMemo(
    () => paletteItems(query, { rows: wiki.pages, recentIds, destinations, textResults: results }),
    [query, wiki.pages, recentIds, destinations, results],
  );
  const current = Math.min(active, Math.max(0, items.length - 1));
  useEffect(() => { document.getElementById(`${listId}-${current}`)?.scrollIntoView({ block: "nearest" }); }, [listId, current]);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Enter" && items[current]) { event.preventDefault(); onPick(items[current].href); return; }
    const step = keyStep(event.key);
    if (step === 0) return;
    event.preventDefault();
    setActive(stepIndex(current, step, items.length));
  };
  return (
    <>
      <div className="flex items-center gap-3 border-b border-zinc-950/5 px-4 dark:border-white/10">
        <Search className="size-5 shrink-0 text-zinc-400" strokeWidth={1.75} />
        <input autoFocus value={query} onChange={(event) => { setQuery(event.target.value); setActive(0); }} onKeyDown={onKeyDown}
          role="combobox" aria-expanded="true" aria-controls={listId} aria-activedescendant={items.length > 0 ? `${listId}-${current}` : undefined}
          aria-label="Search pages and screens" placeholder="Search pages, or jump to a screen…"
          className="h-14 w-full bg-transparent text-base text-zinc-900 placeholder:text-zinc-400 focus:outline-none dark:text-white" />
      </div>
      <PaletteList items={items} listId={listId} active={current} onPick={(item) => onPick(item.href)} onPoint={setActive} />
      <p className="flex gap-4 border-t border-zinc-950/5 px-4 py-2 text-xs text-zinc-500 dark:border-white/10 dark:text-zinc-400">
        <span><kbd className="font-sans">↑↓</kbd> move</span><span><kbd className="font-sans">↵</kbd> open</span><span><kbd className="font-sans">esc</kbd> close</span>
      </p>
    </>
  );
}

/** Mount once in the shell. */
export function CommandPalette({ wiki, health }: { wiki: PagesEnvelope; health: HealthPayload | null }): ReactNode {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onOpen = (): void => setOpen(true);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, []);
  useEffect(() => {
    if (open && dialog.current?.open === false) dialog.current.showModal();
  }, [open]);
  const pick = (href: string): void => {
    dialog.current?.close();
    window.location.hash = href;
  };
  return (
    <dialog ref={dialog} onClose={() => setOpen(false)} aria-label="Command palette"
      onClick={(event) => { if (event.target === event.currentTarget) dialog.current?.close(); }}
      className="mx-auto mt-[12vh] w-[calc(100%-2rem)] max-w-xl overflow-hidden rounded-xl bg-white p-0 shadow-2xl outline-none ring-1 ring-zinc-950/10 backdrop:bg-zinc-950/40 backdrop:backdrop-blur-sm dark:bg-zinc-900 dark:ring-white/10">
      {open && <PaletteBody wiki={wiki} health={health} onPick={pick} />}
    </dialog>
  );
}
