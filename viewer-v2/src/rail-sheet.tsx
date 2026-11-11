/**
 * The page rail on a narrow screen: a floating **Page details** button that
 * opens the outline, neighbourhood, metadata and citations in a bottom sheet,
 * instead of stacking them under a long article where nobody scrolls. The
 * sheet is a native modal `<dialog>`, so the browser handles the top layer,
 * focus, and Escape. A tap on the backdrop or on any link or button inside
 * closes it, in the capture phase, so the page is no longer inert when the
 * outline moves focus to a heading. A route change unmounts the page view and
 * the open sheet with it. Its contents mount only while it is open, and only
 * after the dialog is shown: the neighbourhood graph measures its box when it
 * mounts, and a closed dialog has none.
 */
import { PanelBottomOpen, X } from "lucide-react";
import { useId, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { closestElement } from "./dom";

/** Whether a tap inside the sheet should close it: the backdrop, or anything that navigates or acts. */
export function closesSheet(target: EventTarget | null, sheet: EventTarget | null): boolean {
  return target === sheet || closestElement(target, "a, button") !== null;
}

/** The button and the sheet holding `children`. */
export function RailSheet({ children }: { children: ReactNode }): ReactNode {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const onClick = (event: MouseEvent<HTMLDialogElement>): void => {
    if (closesSheet(event.target, event.currentTarget)) dialog.current?.close();
  };
  return (
    <>
      <button type="button" onClick={() => { dialog.current?.showModal(); setOpen(true); }}
        className="fixed right-4 bottom-4 z-20 inline-flex items-center gap-2 rounded-full bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white shadow-lg dark:bg-white dark:text-zinc-900">
        <PanelBottomOpen className="size-4" strokeWidth={1.75} />Page details
      </button>
      <dialog ref={dialog} onClose={() => setOpen(false)} onClickCapture={onClick} aria-labelledby={titleId}
        className="top-auto bottom-0 m-0 max-h-[85dvh] w-full max-w-none overflow-y-auto rounded-t-2xl bg-zinc-50 p-0 shadow-2xl outline-none backdrop:bg-zinc-950/40 dark:bg-zinc-950">
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-zinc-950/5 bg-zinc-50/95 px-4 py-3 backdrop-blur dark:border-white/10 dark:bg-zinc-950/95">
          <h2 id={titleId} className="text-sm font-semibold text-zinc-950 dark:text-white">Page details</h2>
          <button type="button" aria-label="Close page details" className="rounded-md p-1 text-zinc-500 hover:bg-zinc-950/5 dark:hover:bg-white/10"><X className="size-5" strokeWidth={1.75} /></button>
        </div>
        <div className="space-y-4 p-4">{open && children}</div>
      </dialog>
    </>
  );
}
