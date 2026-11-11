/**
 * Global keyboard shortcuts and the dialog that lists them.
 *
 * ⌘K or Ctrl+K, and `/`, open the command palette; `g` then a letter jumps to
 * a screen; `j` and `k` move focus down and up the rows of the current list,
 * where Enter then opens the row as any focused link does; `?` shows this
 * list. Plain-letter shortcuts never fire while the reader is typing in a
 * field or has a dialog open, and never with a modifier held, so they cannot
 * swallow text or a browser shortcut. The key handling is a pure function of
 * the key and whether `g` is pending, so it is tested without a browser.
 */
import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react";
import { openPalette } from "./command-palette";
import { CENTRED_DIALOG, closeOnBackdrop } from "./components";
import { closestElement } from "./dom";

/**
 * Where `g` then a letter goes. These are the default project's screens; on a
 * profile project `g c` and `g q` still open those lists, which the sidebar
 * replaces with the profile's own categories, so they are simply empty there.
 */
const GO_KEYS: Record<string, { href: string; label: string }> = {
  d: { href: "#/", label: "Dashboard" },
  c: { href: "#/concepts", label: "Concepts" },
  q: { href: "#/queries", label: "Queries" },
  r: { href: "#/recent", label: "Recent" },
  s: { href: "#/sources", label: "Sources" },
  g: { href: "#/graph", label: "Graph explorer" },
  h: { href: "#/health", label: "Health & lint" },
  v: { href: "#/reviews", label: "Reviews" },
};

/** A `g` waits this long for its second key. */
const SEQUENCE_TIMEOUT_MS = 1200;
/** List rows opt into `j`/`k` with this attribute. */
const ROW_SELECTOR = "main [data-row]";
/** What a single key does when no `g` is waiting. */
const SINGLE_KEYS: Record<string, ShortcutAction> = { "/": { kind: "palette" }, "?": { kind: "help" }, j: { kind: "row", step: 1 }, k: { kind: "row", step: -1 } };

/** What one key press asks for. */
export type ShortcutAction =
  | { kind: "palette" }
  | { kind: "help" }
  | { kind: "go"; href: string }
  | { kind: "row"; step: 1 | -1 }
  | null;

/** Resolve a plain key press, given whether a `g` is waiting for its second key. */
export function resolveKey(key: string, gPending: boolean): { action: ShortcutAction; gPending: boolean } {
  if (gPending) {
    const target = GO_KEYS[key];
    return { action: target ? { kind: "go", href: target.href } : null, gPending: false };
  }
  return { action: SINGLE_KEYS[key] ?? null, gPending: key === "g" };
}

/** Whether the key belongs to whatever has focus: a field, an editable region, or an open dialog. */
export function isTypingContext(target: EventTarget | null): boolean {
  return closestElement(target, "input, textarea, select, [contenteditable=''], [contenteditable='true'], dialog[open]") !== null;
}

/** Whether the press is ⌘K or Ctrl+K, which opens the palette even from a field. */
export function isPaletteChord(event: Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "key">): boolean {
  return (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";
}

/** Whether a plain-letter shortcut may act on this press: no modifier, and not typed into anything. */
export function isPlainKey(event: Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey" | "target">): boolean {
  return !(event.metaKey || event.ctrlKey || event.altKey) && !isTypingContext(event.target);
}

/** Focus the next or previous list row, starting from the first or last when none has focus. */
function moveRowFocus(step: 1 | -1): void {
  const rows = Array.from(document.querySelectorAll<HTMLElement>(ROW_SELECTOR));
  if (rows.length === 0) return;
  const index = rows.indexOf(document.activeElement as HTMLElement);
  const next = index < 0 ? (step > 0 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, index + step));
  rows[next].focus();
}

/** Carry out a resolved action. */
function perform(action: NonNullable<ShortcutAction>, openHelp: () => void): void {
  if (action.kind === "palette") openPalette();
  else if (action.kind === "help") openHelp();
  else if (action.kind === "go") window.location.hash = action.href;
  else moveRowFocus(action.step);
}

/** Listen for the shortcuts for as long as the shell is mounted. */
function useShortcuts(help: RefObject<HTMLDialogElement | null>): void {
  useEffect(() => {
    let gPending = false;
    let timer: number | undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (isPaletteChord(event)) { event.preventDefault(); openPalette(); return; }
      if (!isPlainKey(event)) return;
      const resolved = resolveKey(event.key, gPending);
      gPending = resolved.gPending;
      window.clearTimeout(timer);
      if (gPending) timer = window.setTimeout(() => { gPending = false; }, SEQUENCE_TIMEOUT_MS);
      if (resolved.action === null) return;
      event.preventDefault();
      perform(resolved.action, () => help.current?.showModal());
    };
    window.addEventListener("keydown", onKeyDown);
    return () => { window.clearTimeout(timer); window.removeEventListener("keydown", onKeyDown); };
  }, [help]);
}

/** A key cap. */
function Key({ children }: { children: ReactNode }): ReactNode {
  return <kbd className="inline-flex min-w-6 justify-center rounded border border-zinc-950/10 bg-zinc-50 px-1.5 py-0.5 font-sans text-xs text-zinc-700 dark:border-white/10 dark:bg-white/5 dark:text-zinc-300">{children}</kbd>;
}

const GENERAL_ROWS: [ReactNode, string][] = [
  [<><Key>⌘</Key> <Key>K</Key> or <Key>/</Key></>, "Search and jump"],
  [<><Key>j</Key> <Key>k</Key></>, "Next and previous row in a list"],
  [<Key>?</Key>, "Show these shortcuts"],
];

/** The shortcut list. */
export function ShortcutList(): ReactNode {
  const rows: [ReactNode, string][] = [
    ...GENERAL_ROWS,
    ...Object.entries(GO_KEYS).map(([key, { label }]): [ReactNode, string] => [<><Key>g</Key> <Key>{key}</Key></>, `Go to ${label}`]),
  ];
  return (
    <dl className="divide-y divide-zinc-950/5 text-sm dark:divide-white/10">
      {rows.map(([keys, label]) => (
        <div key={label} className="flex items-center justify-between gap-4 py-2">
          <dt className="text-zinc-700 dark:text-zinc-300">{label}</dt>
          <dd className="shrink-0 text-zinc-500">{keys}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Mount once in the shell: the listener and the help dialog it opens. */
export function KeyboardShortcuts(): ReactNode {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useShortcuts(dialog);
  return (
    <dialog ref={dialog} aria-labelledby={titleId} onClick={closeOnBackdrop} className={`${CENTRED_DIALOG} max-w-md`}>
      <div className="p-6">
        <h2 id={titleId} className="mb-3 text-base font-semibold text-zinc-950 dark:text-white">Keyboard shortcuts</h2>
        <ShortcutList />
      </div>
    </dialog>
  );
}
